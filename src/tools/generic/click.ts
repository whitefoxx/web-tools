import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep, parseFrameRef } from './_helpers';
import { flashAgentCursor } from './_agent-cursor';
import { captureSig, actionReceipt } from './_receipt';

cli({
  site: 'generic',
  name: 'click',
  access: 'read',
  description:
    'Click an element on an already-open tab. Three ways to locate it (strongest to weakest): ① ref — the element ref returned by `get_interactives` (most stable, prefer it); ② selector — a CSS selector; ③ text — directly click a button/link/role=button **containing the given visible text** (handiest for a semantically clear click like "click Log in / Submit / New chat" when you have not called get_interactives; exact match first then substring, if multiple match it clicks the first and reports the candidate count — switch to ref when ambiguous). Optional button: "left" (default) / "right" (right-click → context menu) / "middle"; count: 1 (default) / 2 (double-click, e.g. to enter edit mode). Optional wait_ms after the click (default 0); when it will trigger navigation / an SPA switch, use wait_ms:1500 or re-scan afterward. A click on what looks like a **write control** (a Post/Send/Submit/Delete-type button, or a form submit) is REFUSED unless `allow_write:true` — such a click acts on the site as the user; get the user to confirm before passing it. Returns an **action receipt**: `url_changed` (navigated → old refs invalid, re-scan first) / `popup_appeared` (a popup/menu opened) / `new_elements` (count of DOM nodes added) / `new_interactives` (newly-appeared interactive elements, **already with ref+text, usable directly** — popups are often fleeting, prefer these)',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help: 'Target tab id',
    },
    {
      name: 'ref',
      type: 'string',
      help: 'Element ref returned by get_interactives (most stable). One of ref / selector / text',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'CSS selector. One of ref / selector / text',
    },
    {
      name: 'text',
      type: 'string',
      help: 'Click by visible text (no need to call get_interactives first). One of ref / selector / text',
    },
    {
      name: 'role',
      type: 'string',
      help: 'text mode only: restrict the type to button | link | any (default any — searches button / role=button / links)',
    },
    {
      name: 'button',
      type: 'string',
      help: 'Mouse button: left (default) / right (right-click, opens context menu) / middle',
    },
    {
      name: 'count',
      type: 'int',
      help: 'Number of clicks: 1 (default) / 2 (double-click)',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: 'Milliseconds to wait after the click (let the page respond / navigation start). Default 0',
    },
    {
      name: 'allow_write',
      type: 'bool',
      help: 'Confirm a click on a write control (a Post/Send/Submit/Delete-type button, or a form submit). Such a click is REFUSED without this — it acts on the site as the user (posting, sending, deleting). Only pass true once the user has explicitly confirmed this action.',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const ref = typeof kwargs.ref === 'string' ? kwargs.ref : null;
    const selectorArg = typeof kwargs.selector === 'string' ? kwargs.selector : null;
    const text = typeof kwargs.text === 'string' && kwargs.text.trim() ? kwargs.text.trim() : null;
    if (!ref && !selectorArg && !text) {
      throw new Error('Must provide one of: ref (from get_interactives), selector (CSS), or text.');
    }
    const role = String(kwargs.role ?? 'any').toLowerCase();
    if (text && !['any', 'button', 'link'].includes(role)) {
      throw new Error(`role must be one of: any / button / link; got "${role}"`);
    }
    const waitMs = Math.max(0, Math.min(30_000, Number(kwargs.wait_ms ?? 0)));
    const buttonName = String(kwargs.button ?? 'left').toLowerCase();
    const button = buttonName === 'right' ? 2 : buttonName === 'middle' ? 1 : 0;
    const count = Number(kwargs.count) === 2 ? 2 : 1;
    const allowWrite = kwargs.allow_write === true;
    // A frame-scoped ref (`f<id>…`, from get_interactives) targets that iframe;
    // the DOM attribute inside the frame is the un-prefixed localRef. selector /
    // text search the top frame.
    const parsed = ref ? parseFrameRef(ref) : null;
    const selector = parsed
      ? `[data-web-ref="${parsed.localRef}"]`
      : selectorArg; /* may be null when in text mode */
    const target: chrome.scripting.InjectionTarget =
      parsed && parsed.frameId ? { tabId, frameIds: [parsed.frameId] } : { tabId };

    const before = await captureSig(target); // ⑩ pre-action probe (best-effort)
    const results = await chrome.scripting.executeScript({
      target,
      func: clickInPage,
      args: [selector, text, role, button, count, allowWrite],
    });
    const r = results[0]?.result;
    if (!r) throw new Error('executeScript returned no result');
    // Write-intent guard: clickInPage resolved the target and, when it looks
    // like a write control (Post/Send/Submit/Delete), refused to click it
    // without allow_write. Surface that as a model-facing refusal — the write
    // did NOT happen — mirroring eval_js's write guard. The shell decides how
    // allow_write gets set (localmd Connect turns it into a confirm card).
    if (r.write_blocked) {
      return {
        tabId,
        write_blocked: true,
        control: r.control,
        message:
          `This click targets what looks like a WRITE control ("${r.control}") — clicking it acts on the site as the user (posting, sending, deleting) and cannot be undone. It was NOT clicked. ` +
          `If the user has explicitly confirmed this action, call click again with allow_write:true. Otherwise report the action you would take instead of performing it.`,
      };
    }
    if (!r.found) {
      const how = ref
        ? `ref=${ref}`
        : selectorArg
          ? `selector="${selectorArg}"`
          : `text="${text}" (role=${role})`;
      throw new Error(
        `Element not found for ${how}. ` +
          `If you used a ref from an earlier get_interactives call, the page may have re-rendered — call get_interactives again. Or try text mode / a different locator.`,
      );
    }
    // ⑧ SimulatorMask: glide the on-page agent cursor to the click point + ripple
    // (best-effort, never blocks). Skip for iframe elements — r.x/r.y are
    // frame-relative, not top-frame coords.
    if (!parsed?.frameId && typeof r.x === 'number' && typeof r.y === 'number') {
      void flashAgentCursor(tabId, r.x, r.y, undefined, r.w, r.h); // B: pulse the target box
    }
    if (waitMs > 0) await sleep(waitMs);
    // ⑩ receipt: navigation / popup / DOM-growth since the pre-action probe.
    const receipt = await actionReceipt(tabId, target, tab.url ?? '', before);
    return { tabId, ...r, ...receipt };
  },
});

function clickInPage(
  selector: string | null,
  text: string | null,
  role: string,
  button: number,
  count: number,
  allowWrite: boolean,
): {
  found: boolean;
  write_blocked?: boolean;
  control?: string;
  text?: string;
  matched_text?: string;
  candidates_count?: number;
  tag?: string;
  href?: string;
  used_hit_target?: boolean;
  blocked_by?: { tag: string; text: string; hint: string };
  x?: number;
  y?: number;
  w?: number;
  h?: number;
} {
  // Deep query incl. open shadow roots — querySelector can't pierce them, so
  // shadow-DOM controls (lit / web components) were unreachable. Self-contained
  // (executeScript only serializes this function). Bounded.
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

  // Resolve the target element: by CSS selector, or (text mode) by visible text.
  let el: HTMLElement | null = null;
  let candidatesCount = 0;
  if (selector) {
    el = deepQuery(selector) as HTMLElement | null;
  } else if (text) {
    let sel: string;
    if (role === 'button')
      sel = 'button, [role="button"], input[type="submit"], input[type="button"]';
    else if (role === 'link') sel = 'a[href]';
    else sel = 'button, [role="button"], input[type="submit"], input[type="button"], a[href]';

    const isVisible = (e: Element): boolean => {
      const rc = e.getBoundingClientRect();
      if (rc.width <= 1 || rc.height <= 1) return false;
      const style = window.getComputedStyle(e);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) === 0) return false;
      return true;
    };
    // Candidates across document + open shadow roots. Bounded walk.
    const roots: Array<Document | ShadowRoot> = [document];
    let walked = 0;
    for (let qi = 0; qi < roots.length && walked <= 12000; qi++) {
      const nodes = roots[qi].querySelectorAll('*');
      for (let i = 0; i < nodes.length; i++) {
        if (++walked > 12000) break;
        const sr = (nodes[i] as HTMLElement).shadowRoot;
        if (sr) roots.push(sr);
      }
    }
    const matched: Element[] = [];
    for (const rt of roots) rt.querySelectorAll(sel).forEach((e) => matched.push(e));
    const all = matched.filter(isVisible);
    // Exact match first, then substring.
    let candidates = all.filter((e) => {
      const t = (e.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t === text) return true;
      const v = (e as HTMLInputElement).value;
      if (v && v === text) return true;
      const aria = e.getAttribute('aria-label');
      return !!(aria && aria.trim() === text);
    });
    if (candidates.length === 0) {
      candidates = all.filter((e) => {
        const t = (e.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (t.includes(text)) return true;
        const aria = e.getAttribute('aria-label');
        return !!(aria && aria.includes(text));
      });
    }
    candidatesCount = candidates.length;
    el = (candidates[0] as HTMLElement | undefined) ?? null;
  }
  if (!el) return { found: false };

  // Write-intent guard (mirrors eval_js's guard, but on the resolved element,
  // which only this in-page pass can see). A click on a control that posts /
  // sends / submits / deletes acts on the site as the user and is not
  // undoable, so it is refused unless the caller passed allow_write — the shell
  // turns that into an explicit user confirmation. Detection: a real submit
  // control (type=submit / a bare <button> inside a <form>), or an actionable
  // element whose accessible name / testid reads as a write verb. Benign
  // navigation ("Show transcript", "Next", "Expand") does not match, so reading
  // stays friction-free.
  if (!allowWrite) {
    const host = (el.closest('button, [role="button"], input[type="submit"], input[type="button"], a[href]') ||
      el) as HTMLElement;
    const attr = (name: string): string => host.getAttribute?.(name) ?? '';
    const typeAttr = attr('type').toLowerCase();
    const isSubmit =
      typeAttr === 'submit' ||
      (host.tagName === 'BUTTON' && !typeAttr && !!host.closest('form'));
    const label = [
      host.textContent ?? '',
      attr('aria-label'),
      attr('data-testid'),
      attr('name'),
      (host as HTMLInputElement).value ?? '',
      attr('title'),
    ]
      .join(' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    const WRITE =
      /\b(post|tweet|reply|repost|retweet|send|publish|submit|delete|remove|discard|follow|unfollow|subscribe|unsubscribe|upvote|downvote|comment|buy|purchase|checkout|pay|order|book|save|create|upload)\b|tweetbutton|sendbutton|replybutton|postbutton|likebutton/;
    if (WRITE.test(label) || isSubmit) {
      const shown = (host.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return { found: true, write_blocked: true, control: shown || (isSubmit ? 'form submit' : host.tagName.toLowerCase()) };
    }
  }

  el.scrollIntoView({ behavior: 'auto', block: 'center' });

  // Robust click (page-agent / browser-use borrow). A bare el.click() fires ONLY
  // a `click` event, so controls that react to pointerdown / mousedown / hover
  // (custom widgets, hover-revealed menus, drag handles, many React components)
  // never respond. Dispatch the full W3C sequence a real pointer produces:
  // pointerover→enter→mouseover→enter → pointerdown→mousedown → focus →
  // pointerup→mouseup → click. Hit-test the click point so events target the
  // DEEPEST element (and bubble up to the handler), matching the real browser.
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  // Composed-aware hit test: document.elementFromPoint stops at a shadow HOST
  // (descend via shadowRoot.elementFromPoint), and Node.contains doesn't cross
  // shadow boundaries (walk parentNode / ShadowRoot.host instead).
  function deepElementFromPoint(px: number, py: number): Element | null {
    // elementsFromPoint + skip our own [data-wa-mask] overlay (A in
    // page-agent-comparison §4.2): when the interception mask is armed a plain
    // elementFromPoint would return the MASK for every point. Walking the stack
    // past it is a pure read — no toggling shared state around the action.
    const pick = (root: Document | ShadowRoot): Element | null => {
      const stack = root.elementsFromPoint(px, py);
      for (const e of stack) if (!e.closest('[data-wa-mask]')) return e;
      return null;
    };
    let cur = pick(document);
    let guard = 0;
    while (cur && (cur as HTMLElement).shadowRoot && ++guard < 20) {
      const inner = pick((cur as HTMLElement).shadowRoot!);
      if (!inner || inner === cur) break;
      cur = inner;
    }
    return cur;
  }
  function composedWithin(node: Element, ancestor: Element): boolean {
    let n: Node | null = node;
    while (n) {
      if (n === ancestor) return true;
      n = n instanceof ShadowRoot ? n.host : n.parentNode;
    }
    return false;
  }
  let hitTarget: HTMLElement = el;
  let blockedBy: { tag: string; text: string; hint: string } | undefined;
  if (
    typeof document.elementFromPoint === 'function' &&
    x >= 0 &&
    y >= 0 &&
    x <= window.innerWidth &&
    y <= window.innerHeight
  ) {
    const hit = deepElementFromPoint(x, y);
    if (hit instanceof HTMLElement) {
      if (composedWithin(hit, el)) {
        hitTarget = hit;
      } else if (!composedWithin(el, hit)) {
        // Something unrelated covers the click point (modal / cookie banner /
        // sticky bar). Synthetic events still reach el, but a REAL user click
        // would land on the cover — report it so the agent can dismiss the
        // overlay instead of silently wondering why the click "did nothing".
        blockedBy = {
          tag: hit.tagName.toLowerCase(),
          text: (hit.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
          hint: 'The click point is covered by this element (popup/banner?). If the click had no effect, deal with the overlay first (click its close button or press_key Escape) then retry.',
        };
      }
    }
  }
  // Hover events carry no pressed button; the press cycle carries `button` (0
  // left / 1 middle / 2 right) and its `buttons` bitmask (1 / 4 / 2).
  const hoverP = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'mouse' };
  const hoverM = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  const buttons = button === 2 ? 2 : button === 1 ? 4 : 1;
  const pressP = { ...hoverP, button, buttons };
  const pressM = { ...hoverM, button, buttons };
  hitTarget.dispatchEvent(new PointerEvent('pointerover', hoverP));
  hitTarget.dispatchEvent(new PointerEvent('pointerenter', { ...hoverP, bubbles: false }));
  hitTarget.dispatchEvent(new MouseEvent('mouseover', hoverM));
  hitTarget.dispatchEvent(new MouseEvent('mouseenter', { ...hoverM, bubbles: false }));
  // Repeat the press-release cycle `count` times (2 = double-click). Right-click
  // ends in `contextmenu` (no activation); left/middle fire `click` — the common
  // left single-click keeps the native el.click() so navigation / form submit /
  // default actions fire exactly as before.
  const cycles = count >= 2 ? 2 : 1;
  for (let i = 0; i < cycles; i++) {
    hitTarget.dispatchEvent(new PointerEvent('pointerdown', pressP));
    hitTarget.dispatchEvent(new MouseEvent('mousedown', pressM));
    if (i === 0) {
      // Focus the nearest focusable (the original el, not the hit-test descendant)
      // — matches the browser; preventScroll because we already scrolled into view.
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus?.();
      }
    }
    hitTarget.dispatchEvent(new PointerEvent('pointerup', pressP));
    hitTarget.dispatchEvent(new MouseEvent('mouseup', pressM));
    if (button === 2) hitTarget.dispatchEvent(new MouseEvent('contextmenu', pressM));
    else if (button === 0 && cycles === 1) hitTarget.click();
    else hitTarget.dispatchEvent(new MouseEvent('click', pressM));
  }
  if (cycles === 2 && button !== 2) hitTarget.dispatchEvent(new MouseEvent('dblclick', pressM));

  const label = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    found: true,
    // `text` for the selector/ref path, `matched_text` (+ candidates_count) for
    // text mode — preserves both tools' original result shapes.
    ...(text ? { matched_text: label, candidates_count: candidatesCount } : { text: label }),
    tag: el.tagName.toLowerCase(),
    href: (el as HTMLAnchorElement).href || undefined,
    used_hit_target: hitTarget !== el,
    blocked_by: blockedBy,
    x,
    y,
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
}
