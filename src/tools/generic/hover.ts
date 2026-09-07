import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep } from './_helpers';
import { createPageShim } from '../../runtime/page';
import { flashAgentCursor } from './_agent-cursor';

/**
 * Real pointer hover via CDP `Input.dispatchMouseEvent` mouseMoved — trusted
 * input, so Blink updates :hover state AND fires the derived pointer/mouse
 * event stream. Synthetic mouseover (what click's prelude dispatches) can't
 * trigger CSS :hover menus at all; this fills that gap (audit 2026-07-02 ④).
 * The click sequence stays synthetic-in-page; hover is the one interaction
 * where only the trusted channel works.
 */
cli({
  site: 'generic',
  name: 'hover',
  access: 'read',
  description:
    'Hover over an element (real pointer movement: CDP trusted events, which trigger :hover styles and JS hover menus — something synthetic events cannot do). Use for menus/flyouts/toolbars that only expand on hover: after hovering, follow with get_interactives to see the newly appeared elements, then click. Note: this briefly attaches the debugger (yellow notification bar); the user actually moving the mouse will interrupt the hover state',
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
      help: 'Element ref returned by get_interactives. Use either ref or selector',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'CSS selector. Use either ref or selector',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: 'Wait in ms after hovering (for the menu/flyout to expand). Default 300',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const ref = typeof kwargs.ref === 'string' ? kwargs.ref : null;
    const selectorArg = typeof kwargs.selector === 'string' ? kwargs.selector : null;
    if (!ref && !selectorArg) {
      throw new Error('Must provide either ref (from get_interactives) or selector (CSS).');
    }
    const waitMs = Math.max(0, Math.min(30_000, Number(kwargs.wait_ms ?? 300)));
    const selector = ref ? `[data-web-ref="${ref}"]` : selectorArg!;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: locateInPage,
      args: [selector],
    });
    const r = results[0]?.result;
    if (!r) throw new Error('executeScript returned no result');
    if (!r.found || typeof r.x !== 'number' || typeof r.y !== 'number') {
      throw new Error(
        `Element not found for ${ref ? `ref=${ref}` : `selector="${selectorArg}"`}. ` +
          `If the ref is stale, call get_interactives again.`,
      );
    }

    const page = await createPageShim(tabId);
    try {
      // Approach point first, then centre — some hover trackers want movement,
      // not a teleport. Trusted moves update :hover and fire pointer events.
      await page.cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.max(0, r.x - 8),
        y: Math.max(0, r.y - 8),
        buttons: 0,
      });
      await page.cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: r.x,
        y: r.y,
        buttons: 0,
      });
    } finally {
      try {
        await page.detach(); // no-op when an explore session owns the attachment
      } catch {
        /* ignore */
      }
    }
    void flashAgentCursor(tabId, r.x, r.y);
    if (waitMs > 0) await sleep(waitMs);
    return { tabId, hovered: true, tag: r.tag, text: r.text, x: r.x, y: r.y };
  },
});

function locateInPage(selector: string): {
  found: boolean;
  tag?: string;
  text?: string;
  x?: number;
  y?: number;
} {
  // Deep query incl. open shadow roots — self-contained (see click.ts). Bounded.
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
  const rect = el.getBoundingClientRect();
  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}
