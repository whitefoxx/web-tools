import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';
import { getActiveExploreSession } from '../../core/explore-gate';

/**
 * Explore-time deterministic wait: poll until a selector exists (optionally is
 * visible) or timeout. For lazy / async content (e.g. an AI overview that loads
 * after the page settles, or content that appears after a click) — more reliable
 * than guessing a fixed sleep. ISOLATED world. Explore tab by default.
 */
cli({
  site: 'generic',
  name: 'wait_for_selector',
  access: 'read',
  description:
    'Poll until something appears on the page, or until timeout — pass EITHER `selector` (a CSS selector, can require it be visible; includes open shadow DOM) OR `text` (a snippet of visible text, case-insensitive). Use it to wait for lazy-loaded / async content — more reliable than a fixed sleep: chain this after a click that triggers loading instead of guessing wait_ms. Prefer `text` when you know what the page will SAY but not how it is marked up ("Order confirmed", "3 results") — it needs no DOM probe first; prefer `selector` when you need a specific element to exist before acting on it. Pass tab_id (omitting it is only valid while an Explore session is running).',
  args: [
    { name: 'selector', type: 'string', help: 'CSS selector to wait for. One of selector / text' },
    {
      name: 'text',
      type: 'string',
      help: 'Visible text to wait for (case-insensitive substring of the page\'s rendered text). One of selector / text',
    },
    {
      name: 'tab_id',
      type: 'int',
      help: 'Target tab id — from open_url, or from get_page_text {url, keep_open:true}. Required unless an Explore session is running (only then may it be omitted, defaulting to that session tab)',
    },
    { name: 'timeout_ms', type: 'int', default: 8000, help: 'Max wait in ms (default 8000, cap 30000)' },
    { name: 'visible', type: 'bool', help: 'Require the element to be visible (has a layout box); default false = existence only' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    let tabId: number;
    if (kwargs.tab_id !== undefined && kwargs.tab_id !== null && kwargs.tab_id !== '') {
      await assertTabId(kwargs.tab_id);
      tabId = Number(kwargs.tab_id);
    } else if (session) {
      tabId = session.tabId;
    } else {
      return { error: 'provide tab_id, or start an explore session first' };
    }
    const selector = typeof kwargs.selector === 'string' ? kwargs.selector.trim() : '';
    const text = typeof kwargs.text === 'string' ? kwargs.text.trim() : '';
    if (!selector && !text) return { error: 'provide either selector (CSS) or text (visible text)' };
    if (selector && text) return { error: 'pass only one of selector and text' };
    const timeout = Math.max(500, Math.min(Number(kwargs.timeout_ms ?? 8000) || 8000, 30000));
    const visible = !!kwargs.visible;
    const t0 = Date.now();

    while (Date.now() - t0 < timeout) {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string, vis: boolean, want: string) => {
          // Text mode: innerText is already "what is rendered" — hidden subtrees
          // and display:none are excluded by definition, so `visible` is moot here.
          if (want) {
            const body = document.body?.innerText ?? '';
            return { found: body.toLowerCase().includes(want.toLowerCase()) };
          }
          // Deep query incl. open shadow roots (bounded) — lazy content inside
          // web components is otherwise invisible to the poll.
          let el: Element | null;
          try {
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
            el = walk(document);
          } catch {
            return { bad: true };
          }
          if (!el) return { found: false };
          if (vis) {
            const he = el as HTMLElement;
            return { found: !!(he.offsetParent || el.getClientRects().length) };
          }
          return { found: true };
        },
        args: [selector, visible, text],
      });
      const r = res[0]?.result as { found?: boolean; bad?: boolean } | undefined;
      if (r?.bad) return { error: `bad selector: ${selector}` };
      if (r?.found) {
        return { found: true, waitedMs: Date.now() - t0, matched: text ? { text } : { selector } };
      }
      await new Promise((rsv) => setTimeout(rsv, 300));
    }
    return {
      found: false,
      waitedMs: Date.now() - t0,
      ...(text ? { text } : { selector }),
      hint: text
        ? 'Timed out before that text appeared. Check the wording (the match is a plain case-insensitive substring of the rendered text, so punctuation and line breaks inside your snippet matter), or read the page with get_page_text to see what it actually says.'
        : 'Timed out before it appeared; check the selector, or trigger loading first (scroll / click to expand).',
    };
  },
});
