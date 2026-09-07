import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep } from './_helpers';
import { createPageShim } from '../../runtime/page';
import { captureSig, actionReceipt } from './_receipt';

/**
 * Trusted keyboard input via CDP `Input.dispatchKeyEvent` — the same channel a
 * real keyboard uses, so it works where synthetic KeyboardEvents are ignored.
 * Fills the gap type_into can't cover: Escape to close modals, arrows to move
 * through custom autocomplete lists, Enter outside a form, Tab focus moves,
 * Ctrl/Cmd combos. PageShim already implements the CDP plumbing (pressKey /
 * nativeKeyPress); this tool just exposes it to the agent (audit 2026-07-02 ④).
 */

const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: ' ',
};

const MOD_ALIASES: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
};

cli({
  site: 'generic',
  name: 'press_key',
  access: 'read',
  description:
    'Press a key on a tab (real keyboard channel: CDP trusted events, works even where synthetic events are ignored). Uses: Escape to close a popup, arrow keys to move in an autocomplete/list, Enter to confirm (outside a form), Tab to move focus, key combos (modifiers like "ctrl", "ctrl+shift"). By default sent to the page\'s currently focused element; passing ref/selector focuses that element first, then presses. Ctrl/Cmd+Enter is the post/send shortcut on most sites and is REFUSED unless `allow_write:true` — get the user to confirm before passing it. Note: briefly attaches the debugger (yellow banner)',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help: 'Target tab id',
    },
    {
      name: 'key',
      type: 'string',
      required: true,
      help: 'Key name: Enter / Escape / Tab / Backspace / Delete / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Home / End / PageUp / PageDown, or a single character (e.g. "a")',
    },
    {
      name: 'modifiers',
      type: 'string',
      help: 'Modifier keys joined with +: e.g. "ctrl", "ctrl+shift", "cmd". Default none',
    },
    {
      name: 'ref',
      type: 'string',
      help: 'Optional: focus this element first (a get_interactives ref) then press. One of ref / selector',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'Optional: focus the element matched by this CSS selector first, then press',
    },
    {
      name: 'repeat',
      type: 'int',
      help: 'Number of repeated presses (e.g. press ArrowDown 5 times). Default 1, max 20',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: 'Milliseconds to wait after pressing (let the page respond). Default 0',
    },
    {
      name: 'allow_write',
      type: 'bool',
      help: 'Confirm a submit gesture. Ctrl/Cmd+Enter (the near-universal post/send shortcut) is REFUSED without this — it commits on the site as the user (posting, sending). Only pass true once the user has explicitly confirmed.',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const rawKey = String(kwargs.key ?? '').trim();
    if (!rawKey) throw new Error('key must not be empty');
    const key = KEY_ALIASES[rawKey.toLowerCase()] ?? rawKey;
    const modifiers = String(kwargs.modifiers ?? '')
      .split(/[+,\s]+/)
      .map((m) => MOD_ALIASES[m.toLowerCase()])
      .filter((m): m is string => !!m);
    const repeat = Math.max(1, Math.min(20, Number(kwargs.repeat ?? 1) || 1));
    const waitMs = Math.max(0, Math.min(30_000, Number(kwargs.wait_ms ?? 0)));
    const ref = typeof kwargs.ref === 'string' ? kwargs.ref : null;
    const selectorArg = typeof kwargs.selector === 'string' ? kwargs.selector : null;

    // Write-intent guard (mirrors eval_js / click). Ctrl+Enter and Cmd+Enter are
    // the near-universal "post / send / submit" shortcut (X, Slack, GitHub,
    // messengers …) — a real, un-undoable site write. It has no control label to
    // read, but the combo itself is the signal, so refuse it without allow_write
    // and let the shell turn the flag into a confirmation. Plain Enter, Escape,
    // arrows, Tab, etc. are navigation and pass untouched.
    const allowWrite = kwargs.allow_write === true;
    const isSubmitCombo =
      key === 'Enter' && modifiers.some((m) => m === 'Control' || m === 'Meta');
    if (isSubmitCombo && !allowWrite) {
      const combo = `${modifiers.join('+')}+Enter`;
      return {
        tabId,
        write_blocked: true,
        control: `${combo} (submit)`,
        message:
          `${combo} is the post/send shortcut on most sites — it commits on the site as the user and cannot be undone. It was NOT pressed. ` +
          `If the user has explicitly confirmed this action, call press_key again with allow_write:true. Otherwise report the action instead of performing it.`,
      };
    }

    // Keyboard input only reaches a RENDERED tab: a non-active (hidden) tab
    // silently drops dispatched key events even with focus emulation on
    // (real-machine finding, fixtures/shadow-dom.html). Activate it within its
    // window — for agent-window tabs this is invisible to the user; for a
    // user-window tab it switches their view, which keyboard input implies
    // anyway. Report it in the result.
    let activated = false;
    if (!tab.active) {
      try {
        await chrome.tabs.update(tabId, { active: true });
        activated = true;
      } catch {
        /* proceed; the dispatch may still work */
      }
    }

    const before = await captureSig({ tabId }); // ⑩ pre-action probe (best-effort)
    let focusedTag: string | undefined;
    if (ref || selectorArg) {
      const selector = ref ? `[data-web-ref="${ref}"]` : selectorArg!;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: focusInPage,
        args: [selector],
      });
      const r = results[0]?.result;
      if (!r?.found) {
        throw new Error(
          `Element not found for ${ref ? `ref=${ref}` : `selector="${selectorArg}"`}. ` +
            `If the ref is stale, call get_interactives again.`,
        );
      }
      focusedTag = r.tag;
    }

    const page = await createPageShim(tabId);
    try {
      // Agent-window tabs are never the OS-focused window, and Blink only
      // routes keyboard input to a frame that believes it has focus — without
      // this the CDP events dispatch "ok" but no keydown ever fires on the page
      // (real-machine finding on fixtures/shadow-dom.html, 2026-07-02). Same
      // mechanism Puppeteer/headless rely on. Resets when the debugger
      // detaches; harmless if it lingers on an explore-session-owned tab.
      await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      for (let i = 0; i < repeat; i++) {
        // With modifiers → nativeKeyPress carries the CDP modifier bitmask; the
        // plain path uses pressKey (proper windowsVirtualKeyCode for
        // non-printable keys like Escape/arrows).
        if (modifiers.length) await page.nativeKeyPress(key, modifiers);
        else await page.pressKey(key);
      }
    } finally {
      try {
        await page.detach(); // no-op when an explore session owns the attachment
      } catch {
        /* ignore */
      }
    }
    if (waitMs > 0) await sleep(waitMs);
    // ⑩ receipt: Enter often navigates; Escape closes popups; arrows move lists.
    const receipt = await actionReceipt(tabId, { tabId }, tab.url ?? '', before);
    return { tabId, key, modifiers, repeat, focused: focusedTag, activated, ...receipt };
  },
});

function focusInPage(selector: string): { found: boolean; tag?: string } {
  // Deep query incl. open shadow roots — self-contained (executeScript only
  // serializes this function; see click.ts for the same convention). Bounded.
  function deepQuery(sel: string): Element | null {
    let visited = 0;
    const walk = (root: Document | ShadowRoot): Element | null => {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        if (++visited > 12000) return null;
        const sr = (all[i] as HTMLElement).shadowRoot;
        if (sr) {
          const hit = walk(sr);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(document);
  }
  const el = deepQuery(selector) as HTMLElement | null;
  if (!el) return { found: false };
  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  el.focus?.({ preventScroll: true });
  return { found: true, tag: el.tagName.toLowerCase() };
}
