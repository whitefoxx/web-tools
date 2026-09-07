/**
 * Agent cursor / "operating" overlay (page-agent borrows ⑧ + A/B, see
 * page-agent-comparison §4.2): a visual layer injected into a tab the agent is
 * driving, so a watching user can SEE what it's doing — and CAN'T accidentally
 * interfere with it (always on; a fixed part of the product, not a setting) —
 *   • an animated gradient border frame (the "agent is operating" cue),
 *   • a real MOUSE-POINTER cursor that glides to each click/type point, with a
 *     ripple from its tip on action,
 *   • a pulsing box around the element being acted on (B),
 *   • a gradient pill badge,
 *   • (A) real input interception: pointer-events:auto + swallowing mouse/wheel
 *     events, so a stray user click can't close the menu the agent just opened
 *     or steal focus mid-form-fill (page-agent's SimulatorMask).
 *
 * Fits web-agent's model (no bundled content script): the click/type tools
 * already compute the action point and run in the SW with a tabId, so after the
 * action they fire-and-forget `flashAgentCursor(tabId, x, y, …)`, which injects
 * the self-contained `agentCursorInPage` via chrome.scripting. The overlay is
 * idempotent (reused across calls) and auto-hides when the agent goes quiet.
 *
 * DEAD-MAN'S SWITCH (A, non-negotiable): page-agent's controller lives in the
 * page and can dispose its mask; ours is injected from an MV3 service worker
 * that CAN die (idle kill / crash / extension reload). Two layers:
 *   • the in-page MASK_ARM_MS timer disarms interception unless refreshed;
 *   • in persistent mode (the default for runs) the mask itself PINGS the SW
 *     (`MASK_PING`, isolated world → runtime.sendMessage) every ~2.5s — an
 *     alive answer re-arms the timer, so the mask stays up for the WHOLE run
 *     including LLM thinking gaps; no answer / alive:false (run over, SW
 *     restarted with an empty registry, extension reloaded) → disarm within a
 *     ping cycle. The registry lives in background/mask-keeper.ts; run end and
 *     human-takeover release explicitly for instant feel.
 * Keyboard input is not swallowed (it goes to the page's focused element, not
 * the overlay) — known limit.
 *
 * The root carries `data-wa-mask` so our own hit-tests (click / occlusion
 * sampling) can skip it via elementsFromPoint — see deepElementFromPoint in
 * click.ts (the mask must never count as "covering" the page for ourselves).
 *
 * Best-effort: any failure (restricted page, hostile DOM, tab gone) is
 * swallowed — it must never affect the actual click/type.
 */
import { productShortName } from '../../background/controlled-tabs';

/** How long one arm keeps the interception up without a successful ping (the
 * dead-man ceiling: max time a dead SW can leave the page blocked). Pings every
 * ~2.5s re-arm it, so a live run holds the mask continuously. */
export const MASK_ARM_MS = 8_000;

/** Injected into the page: ensure the overlay, glide the cursor to (x,y),
 * ripple, pulse a box around the target rect (w×h centered on the point; 0 =
 * none; x<0 = arm-only, no cursor/ripple update), optionally arm input
 * interception, and (re)arm the auto-hide/disarm. In persistent mode the mask
 * keeps itself alive by pinging the SW (see file header). Self-contained —
 * only its args + DOM + chrome.runtime (isolated world), so it serializes
 * cleanly into chrome.scripting.executeScript. */
export function agentCursorInPage(
  x: number,
  y: number,
  label: string,
  w: number,
  h: number,
  mask: boolean,
  armMs: number,
  persistent: boolean,
): void {
  try {
    const ID = '__wa_overlay';
    const doc = document;
    interface Root extends HTMLElement {
      __waHideTimer?: ReturnType<typeof setTimeout>;
      __waToastTimer?: ReturnType<typeof setTimeout>;
      __waLastToastAt?: number;
      __waPingTimer?: ReturnType<typeof setInterval>;
      __waDisarm?: () => void;
      __waRearm?: () => void;
    }
    let root = doc.getElementById(ID) as Root | null;
    if (!root) {
      root = doc.createElement('div') as Root;
      root.id = ID;
      root.setAttribute('aria-hidden', 'true');
      // Marker for our own hit-tests (deepElementFromPoint skips [data-wa-mask]).
      root.setAttribute('data-wa-mask', '1');
      root.style.cssText =
        'position:fixed;inset:0;z-index:2147483640;pointer-events:none;transition:opacity .45s,background .3s;cursor:wait;';
      const style = doc.createElement('style');
      style.textContent =
        // Armed veil: a perceptible (but non-obscuring) dim while interception
        // is on — a fully transparent blocking layer reads as "the page froze".
        '#__wa_overlay.__wa_armed{background:rgba(15,23,42,.08);}' +
        '@keyframes __wa_flow{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}' +
        '@keyframes __wa_rip{0%{transform:translate(-50%,-50%) scale(.3);opacity:.6}100%{transform:translate(-50%,-50%) scale(2.6);opacity:0}}' +
        // Mask: gradient-border frame around the viewport (the "operating" cue).
        '#__wa_overlay .__wa_frame{position:absolute;inset:0;border-radius:8px;padding:3px;opacity:.9;' +
        'background:linear-gradient(120deg,#4f8cff,#a855f7,#22d3ee,#4f8cff);background-size:300% 300%;' +
        'animation:__wa_flow 7s ease infinite;' +
        '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);' +
        '-webkit-mask-composite:xor;mask-composite:exclude;}' +
        // Cursor: a real mouse pointer; tip (~5,3 in its 24-box) sits on the point.
        '#__wa_overlay .__wa_cur{position:absolute;width:23px;height:23px;' +
        'filter:drop-shadow(0 1px 2px rgba(0,0,0,.5)) drop-shadow(0 0 6px rgba(79,140,255,.6));' +
        'transition:left .34s cubic-bezier(.22,1,.36,1),top .34s cubic-bezier(.22,1,.36,1);}' +
        // Ripple emanating from the tip / action point.
        '#__wa_overlay .__wa_rip{position:absolute;width:26px;height:26px;border-radius:50%;' +
        'border:2px solid #4f8cff;opacity:0;transform:translate(-50%,-50%) scale(.3);' +
        'transition:left .34s cubic-bezier(.22,1,.36,1),top .34s cubic-bezier(.22,1,.36,1);}' +
        '#__wa_overlay.__wa_click .__wa_rip{animation:__wa_rip .55s ease-out;}' +
        // Target box (B): pulses around the element being clicked / typed into.
        '@keyframes __wa_tgtp{0%{opacity:0}12%{opacity:1}70%{opacity:1}100%{opacity:0}}' +
        '#__wa_overlay .__wa_tgt{position:absolute;border:2.5px solid #4f8cff;border-radius:6px;' +
        'box-shadow:0 0 0 4px rgba(79,140,255,.22);opacity:0;box-sizing:border-box;' +
        'transition:left .34s cubic-bezier(.22,1,.36,1),top .34s cubic-bezier(.22,1,.36,1),' +
        'width .34s,height .34s;}' +
        '#__wa_overlay.__wa_click .__wa_tgt.__wa_tgt_on{animation:__wa_tgtp 1.2s ease-out;}' +
        '#__wa_overlay .__wa_badge{position:absolute;top:14px;right:14px;white-space:nowrap;' +
        'font:600 12px/1.4 system-ui,-apple-system,sans-serif;color:#fff;border-radius:999px;padding:6px 13px;' +
        'background:linear-gradient(120deg,rgba(79,140,255,.96),rgba(168,85,247,.96));' +
        'box-shadow:0 2px 12px rgba(0,0,0,.35);}' +
        // Toast shown when the mask swallows a real user interaction — the
        // "why didn't my click work" answer, in place, at the moment it happens.
        '#__wa_overlay .__wa_toast{position:absolute;top:54px;left:50%;' +
        'transform:translateX(-50%) translateY(-8px);opacity:0;transition:opacity .25s,transform .25s;' +
        'font:600 13px/1.5 system-ui,-apple-system,sans-serif;color:#fff;white-space:nowrap;' +
        'background:rgba(15,23,42,.92);padding:8px 16px;border-radius:10px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.3);}' +
        '#__wa_overlay .__wa_toast.__wa_toast_on{opacity:1;transform:translateX(-50%) translateY(0);}';
      const frame = doc.createElement('div');
      frame.className = '__wa_frame';
      const tgt = doc.createElement('div');
      tgt.className = '__wa_tgt';
      const rip = doc.createElement('div');
      rip.className = '__wa_rip';
      const cur = doc.createElement('div');
      cur.className = '__wa_cur';
      // Fresh overlay from an arm-only call: park the cursor offscreen instead
      // of a stray arrow at (0,0) until the first real action places it.
      cur.style.left = '-40px';
      cur.style.top = '-40px';
      cur.innerHTML =
        '<svg width="23" height="23" viewBox="0 0 24 24" fill="none">' +
        '<path d="M5.5 3.21 L5.5 20.79 L10.25 16.04 L13.04 22.5 L15.34 21.5 L12.62 15.21 L19.5 15.21 Z" ' +
        'fill="#fff" stroke="#16223b" stroke-width="1.7" stroke-linejoin="round"/></svg>';
      const badge = doc.createElement('div');
      badge.className = '__wa_badge';
      // Fallback names no product: this function is injected verbatim by THREE
      // shells, so a hardcoded name is wrong for at least two of them. Callers
      // pass the real one (flashAgentCursor derives it from the manifest).
      badge.textContent = label || '🤖 Agent is working';
      const toast = doc.createElement('div');
      toast.className = '__wa_toast';
      root.appendChild(style);
      root.appendChild(frame);
      root.appendChild(tgt);
      root.appendChild(rip);
      root.appendChild(cur);
      root.appendChild(badge);
      root.appendChild(toast);
      // A: swallow real user mouse/wheel input. The listeners only ever fire
      // while pointer-events is 'auto' (armed) — unarmed, events pass beneath.
      // The agent's own synthetic events dispatch directly on page elements and
      // never route through the overlay, so they are unaffected. Discrete
      // interactions (clicks / wheel — not mousemove) flash a toast explaining
      // WHY the page isn't responding; throttled so a click flurry shows one.
      const TOAST_TYPES = new Set([
        'click',
        'dblclick',
        'contextmenu',
        'pointerdown',
        'mousedown',
        'wheel',
      ]);
      const swallow = (e: Event): void => {
        e.stopPropagation();
        e.preventDefault();
        if (!TOAST_TYPES.has(e.type)) return;
        const r = doc.getElementById(ID) as Root | null;
        if (!r) return;
        const now = Date.now();
        if (r.__waLastToastAt && now - r.__waLastToastAt < 1500) return;
        r.__waLastToastAt = now;
        const t = r.querySelector('.__wa_toast') as HTMLElement | null;
        if (!t) return;
        t.textContent =
          '🤖 Agent is working — this page is temporarily taken over, control returns in a few seconds';
        t.classList.add('__wa_toast_on');
        if (r.__waToastTimer) clearTimeout(r.__waToastTimer);
        r.__waToastTimer = setTimeout(() => t.classList.remove('__wa_toast_on'), 1800);
      };
      for (const t of [
        'click',
        'dblclick',
        'contextmenu',
        'pointerdown',
        'pointerup',
        'mousedown',
        'mouseup',
        'mousemove',
      ]) {
        root.addEventListener(t, swallow);
      }
      root.addEventListener('wheel', swallow, { passive: false });
      // Navigation tears the overlay down with the page anyway; be explicit so
      // bfcache restores never resurrect an armed mask.
      window.addEventListener('pagehide', () => doc.getElementById(ID)?.remove(), { once: true });
      (doc.body || doc.documentElement).appendChild(root);
    }
    root.style.opacity = '1';
    // A: arm/refresh interception (callers always pass mask:true today; the
    // param stays for flexibility). The __wa_armed class carries the visible
    // veil so "blocked" is perceptible, not a mystery.
    root.style.pointerEvents = mask ? 'auto' : 'none';
    root.classList.toggle('__wa_armed', mask);
    if (x >= 0 && y >= 0) {
      // Action call: move the cursor/ripple/target-pulse to the action point.
      const cx = Math.max(0, Math.min(window.innerWidth, x));
      const cy = Math.max(0, Math.min(window.innerHeight, y));
      const cur = root.querySelector('.__wa_cur') as HTMLElement | null;
      const rip = root.querySelector('.__wa_rip') as HTMLElement | null;
      const tgt = root.querySelector('.__wa_tgt') as HTMLElement | null;
      if (cur) {
        // Offset so the cursor's TIP (~5,3 of the 24-box at this size) lands on the point.
        cur.style.left = `${cx - 5}px`;
        cur.style.top = `${cy - 3}px`;
      }
      if (rip) {
        rip.style.left = `${cx}px`;
        rip.style.top = `${cy}px`;
      }
      if (tgt) {
        // B: pulse the target rect when we know it; point-only actions skip it.
        if (w > 0 && h > 0) {
          tgt.style.left = `${cx - w / 2}px`;
          tgt.style.top = `${cy - h / 2}px`;
          tgt.style.width = `${w}px`;
          tgt.style.height = `${h}px`;
          tgt.classList.add('__wa_tgt_on');
        } else {
          tgt.classList.remove('__wa_tgt_on');
        }
      }
      // Restart the ripple animation (reflow forces the keyframes to replay).
      root.classList.remove('__wa_click');
      void root.offsetWidth;
      root.classList.add('__wa_click');
    }
    // Dead-man: ONE path both hides the visuals and DISARMS interception. An
    // invisible-but-blocking wall must be impossible, and a dead SW must never
    // freeze the page beyond armMs. Defined fresh each call (closes over the
    // same root); the ping interval from an earlier call picks up the latest.
    const self = root;
    self.__waDisarm = () => {
      self.style.pointerEvents = 'none';
      self.classList.remove('__wa_armed');
      self.style.opacity = '0';
      if (self.__waPingTimer) {
        clearInterval(self.__waPingTimer);
        self.__waPingTimer = undefined;
      }
      if (self.__waHideTimer) {
        clearTimeout(self.__waHideTimer);
        self.__waHideTimer = undefined;
      }
    };
    self.__waRearm = () => {
      if (self.__waHideTimer) clearTimeout(self.__waHideTimer);
      self.__waHideTimer = setTimeout(() => self.__waDisarm?.(), armMs);
    };
    if (mask) {
      self.__waRearm();
      // Persistent mode: the mask keeps itself alive by asking the SW "is the
      // run still driving this tab?" — the answer re-arms the dead-man; any
      // failure (run over / SW restarted with empty registry / extension
      // reloaded) disarms within one ping cycle.
      if (persistent && !self.__waPingTimer) {
        self.__waPingTimer = setInterval(() => {
          try {
            chrome.runtime.sendMessage({ type: 'MASK_PING' }, (resp?: { alive?: boolean }) => {
              const err = chrome.runtime.lastError;
              if (err || !resp || resp.alive !== true) self.__waDisarm?.();
              else self.__waRearm?.();
            });
          } catch {
            self.__waDisarm?.();
          }
        }, 2500);
      }
    } else {
      // Cosmetic mode: no interception, no heartbeat — just fade out.
      if (self.__waPingTimer) {
        clearInterval(self.__waPingTimer);
        self.__waPingTimer = undefined;
      }
      if (self.__waHideTimer) clearTimeout(self.__waHideTimer);
      self.__waHideTimer = setTimeout(() => {
        self.style.opacity = '0';
      }, armMs);
    }
  } catch {
    /* cosmetic + guard layer — never let it touch the real action */
  }
}

/** Injected: immediately disarm + hide the mask (run end / human takeover —
 * the user is about to operate this tab themselves). Self-contained. */
export function agentMaskReleaseInPage(): void {
  try {
    const root = document.getElementById('__wa_overlay') as
      | (HTMLElement & { __waDisarm?: () => void })
      | null;
    if (!root) return;
    if (root.__waDisarm) root.__waDisarm();
    else {
      root.style.pointerEvents = 'none';
      root.classList.remove('__wa_armed');
      root.style.opacity = '0';
    }
  } catch {
    /* best-effort */
  }
}

/** SW-side: flash the agent cursor at (x,y) in `tabId` (target rect w×h pulses
 * when given). Always arms input interception — the cockpit is a fixed part of
 * the product, not a setting (user decision). Fire-and-forget; a tab that
 * can't be injected (restricted scheme, gone) is silently skipped. */
export async function flashAgentCursor(
  tabId: number,
  x: number,
  y: number,
  label?: string,
  w?: number,
  h?: number,
): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: agentCursorInPage,
      args: [x, y, label ?? defaultBadgeLabel(), w ?? 0, h ?? 0, true, MASK_ARM_MS, true],
    });
  } catch {
    /* overlay is best-effort */
  }
}

/** "🤖 <this shell> is working" — the badge must name the extension the user
 * actually installed. Same string as the tab-group title, from the manifest, so
 * a shell can never announce another shell's name. */
function defaultBadgeLabel(): string {
  return `🤖 ${productShortName()} is working`;
}
