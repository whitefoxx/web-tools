import { cli } from '../../runtime/registry.js';
import { assertTabId, assertHttpUrl, waitForPageReady } from './_helpers';
import { createAgentTab } from '../../background/agent-window';
import { getActiveExploreSession } from '../../core/explore-gate';

/**
 * Explore-time perception primitive: raw outerHTML of a tab (optionally a
 * single selector subtree), so the LLM can see DOM structure and decide on
 * scrape selectors when no clean API endpoint exists. Complements
 * get_page_text (which returns visible text only).
 *
 * Targets the active explore tab by default; a `tab_id` (from open_url) works
 * standalone too. Runs in the ISOLATED content world via chrome.scripting —
 * independent of the explore session's CDP attachment. When it reads the
 * explore tab, it also records a `state` snapshot into the trace.
 */
cli({
  site: 'generic',
  name: 'get_html',
  access: 'read',
  description:
    'Get the page\'s raw HTML (outerHTML, truncatable; the selector path can pierce open shadow DOM). Use it to inspect DOM structure and decide on scraping selectors (for body text use get_page_text, for a condensed structural outline use get_dom_outline). Targeting: (1) url — open that page, read, then close (to read a URL\'s HTML, use this directly, no need to open_url first); (2) tab_id — read an already-open tab (leave it open); (3) neither given: only valid while an Explore session is running (it uses that session tab).',
  args: [
    {
      name: 'url',
      type: 'string',
      help: 'URL of the page whose HTML to read (http/https). Use either url or tab_id (passing url opens a new tab and closes it after reading)',
    },
    {
      name: 'tab_id',
      type: 'int',
      help:
        'Target tab id — from open_url, or from get_page_text {url, keep_open:true}. Required unless an Explore session is running (only then may it be omitted, defaulting to that session tab)',
    },
    { name: 'selector', type: 'string', help: 'Take only the outerHTML of the first element matching this CSS selector' },
    {
      name: 'max_chars',
      type: 'int',
      default: 50000,
      help: 'Max characters to return (default 50000, cap 500000)',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    const urlArg = typeof kwargs.url === 'string' && kwargs.url.trim() ? kwargs.url.trim() : null;
    const hasTabId = kwargs.tab_id !== undefined && kwargs.tab_id !== null && kwargs.tab_id !== '';
    if (urlArg && hasTabId) throw new Error('pass only one of url or tab_id');

    let tabId: number;
    let ownTab = false;
    if (urlArg) {
      const url = assertHttpUrl(urlArg);
      const tab = await createAgentTab(url, { active: false });
      if (typeof tab.id !== 'number') throw new Error('failed to open tab');
      tabId = tab.id;
      ownTab = true;
      await waitForPageReady(tabId, { maxWaitMs: 15_000, quietMs: 800 });
    } else if (hasTabId) {
      await assertTabId(kwargs.tab_id);
      tabId = Number(kwargs.tab_id);
    } else if (session) {
      tabId = session.tabId;
    } else {
      throw new Error('provide url or tab_id, or start an explore session first');
    }

    const selector =
      typeof kwargs.selector === 'string' && kwargs.selector.trim() ? kwargs.selector.trim() : null;
    const maxChars = Math.max(1000, Math.min(Number(kwargs.max_chars ?? 50000) || 50000, 500000));

    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string | null) => {
          // Selector path pierces open shadow roots (bounded walk); the whole-page
          // default stays document.documentElement (shadow content is not in
          // outerHTML — probe shadow subtrees per-selector instead).
          let el: Element | null;
          if (sel) {
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
            try {
              el = walk(document);
            } catch {
              el = null;
            }
          } else {
            el = document.documentElement;
          }
          return {
            url: location.href,
            title: document.title,
            html: el instanceof HTMLElement ? el.outerHTML : '',
            found: !!el,
          };
        },
        args: [selector],
      });
      const out = res[0]?.result as
        | { url: string; title: string; html: string; found: boolean }
        | undefined;
      if (!out) throw new Error('failed to read page HTML (tab not scriptable on this URL?)');

      const fullLength = out.html.length;
      const truncated = fullLength > maxChars;
      const html = truncated ? out.html.slice(0, maxChars) : out.html;

      // Snapshot into the trace when reading the explore tab.
      if (session && tabId === session.tabId) {
        session.recordState({
          stream: 'state',
          url: out.url,
          title: out.title,
          html,
          label: selector ?? 'get_html',
        });
      }

      return {
        url: out.url,
        title: out.title,
        found: out.found,
        htmlLength: fullLength,
        truncated,
        html,
      };
    } finally {
      if (ownTab) {
        try {
          await chrome.tabs.remove(tabId);
        } catch {}
      }
    }
  },
});
