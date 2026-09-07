import { cli } from '../../runtime/registry.js';
import { assertTabId, assertHttpUrl, waitForPageReady } from './_helpers';
import { createAgentTab } from '../../background/agent-window';
import { getActiveExploreSession } from '../../core/explore-gate';

/**
 * Explore-time structure map: a pruned, token-cheap outline of the DOM (tag +
 * id + first classes + a little own-text, runs of identical siblings collapsed
 * to `×N`) instead of dumping 100k+ of raw HTML. Lets the agent see the layout
 * and find the right container/selector fast. ISOLATED world. Explore tab by
 * default.
 */
cli({
  site: 'generic',
  name: 'get_dom_outline',
  access: 'read',
  description:
    'Return a condensed structural outline of the page DOM (tag + id + first few classes + a little text, with runs of identical siblings folded into ×N; includes open shadow DOM, shadow content marked `#shadow-root` and indented) — far cheaper than raw HTML, used to quickly grasp the layout and find the container/selector holding the data (for body text use get_page_text, for one element\'s full HTML use get_html). Targeting: (1) url — open that page, read, then close; (2) tab_id — read an already-open tab (leave it open); (3) neither given: only valid while an Explore session is running (it uses that session tab). Use selector to specify the subtree root.',
  args: [
    {
      name: 'url',
      type: 'string',
      help: 'URL of the page whose structure to view (http/https). Use either url or tab_id (passing url opens a new tab and closes it after reading)',
    },
    {
      name: 'tab_id',
      type: 'int',
      help: 'Target tab id — from open_url, or from get_page_text {url, keep_open:true}. Required unless an Explore session is running (only then may it be omitted, defaulting to that session tab)',
    },
    { name: 'selector', type: 'string', help: 'Output only the subtree of the first element matching this selector (default body)' },
    { name: 'max_depth', type: 'int', default: 14, help: 'Max depth (default 14)' },
    { name: 'max_nodes', type: 'int', default: 400, help: 'Max nodes to output (default 400, cap 1500)' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    const urlArg = typeof kwargs.url === 'string' && kwargs.url.trim() ? kwargs.url.trim() : null;
    const hasTabId = kwargs.tab_id !== undefined && kwargs.tab_id !== null && kwargs.tab_id !== '';
    if (urlArg && hasTabId) return { error: 'pass only one of url or tab_id' };

    let tabId: number;
    let ownTab = false;
    if (urlArg) {
      const url = assertHttpUrl(urlArg);
      const tab = await createAgentTab(url, { active: false });
      if (typeof tab.id !== 'number') return { error: 'failed to open tab' };
      tabId = tab.id;
      ownTab = true;
      await waitForPageReady(tabId, { maxWaitMs: 15_000, quietMs: 800 });
    } else if (hasTabId) {
      await assertTabId(kwargs.tab_id);
      tabId = Number(kwargs.tab_id);
    } else if (session) {
      tabId = session.tabId;
    } else {
      return { error: 'provide url or tab_id, or start an explore session first' };
    }
    const selector =
      typeof kwargs.selector === 'string' && kwargs.selector.trim() ? kwargs.selector.trim() : null;
    const maxDepth = Math.max(2, Math.min(Number(kwargs.max_depth ?? 14) || 14, 30));
    const maxNodes = Math.max(20, Math.min(Number(kwargs.max_nodes ?? 400) || 400, 1500));

    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (rootSel: string | null, maxD: number, maxN: number) => {
          // Deep query across open shadow roots (bounded) — the root selector may
          // point inside a web component (F-31: outline missed shadow content).
          const deepQuery = (sel: string): Element | null => {
            let visited = 0;
            const w = (r: Document | ShadowRoot): Element | null => {
              const direct = r.querySelector(sel);
              if (direct) return direct;
              const all = r.querySelectorAll('*');
              for (let i = 0; i < all.length; i++) {
                if (++visited > 12000) return null;
                const sr = (all[i] as HTMLElement).shadowRoot;
                if (sr) {
                  const hit = w(sr);
                  if (hit) return hit;
                }
              }
              return null;
            };
            return w(document);
          };
          const root = rootSel ? deepQuery(rootSel) : document.body;
          if (!root) return { error: 'root element not found' };
          const SKIP = new Set([
            'SCRIPT',
            'STYLE',
            'NOSCRIPT',
            'SVG',
            'PATH',
            'LINK',
            'META',
            'TEMPLATE',
          ]);
          const lines: string[] = [];
          let count = 0;
          const sig = (el: Element): string => {
            const id = el.id ? `#${el.id}` : '';
            const cls = (el.getAttribute('class') || '')
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((c) => `.${c}`)
              .join('');
            return el.tagName.toLowerCase() + id + cls;
          };
          const kidsOf = (node: Element | ShadowRoot): Element[] =>
            Array.from(node.children).filter((c) => !SKIP.has(c.tagName));
          // function declarations (not const arrows) so emit↔walk can reference
          // each other without a temporal-dead-zone ordering error.
          function emit(kids: Element[], depth: number): void {
            let i = 0;
            while (i < kids.length && count < maxN) {
              const k = kids[i];
              const s = sig(k);
              let run = 1;
              while (i + run < kids.length && sig(kids[i + run]) === s) run++;
              const ownText = Array.from(k.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => (n.textContent || '').trim())
                .join(' ')
                .replace(/\s+/g, ' ')
                .slice(0, 60);
              lines.push(
                '  '.repeat(depth) +
                  s +
                  (run > 1 ? ` ×${run}` : '') +
                  (ownText ? `  "${ownText}"` : ''),
              );
              count++;
              walk(k, depth + 1); // recurse into the run's representative only
              i += run;
            }
          }
          function walk(el: Element, depth: number): void {
            if (count >= maxN || depth > maxD) return;
            // Open shadow content first (marked + indented), then light children
            // (light kids keep the original depth so non-shadow output is unchanged).
            const sr = (el as HTMLElement).shadowRoot;
            if (sr) {
              const sk = kidsOf(sr);
              if (sk.length && count < maxN) {
                lines.push('  '.repeat(depth) + '#shadow-root');
                count++;
                emit(sk, depth + 1);
              }
            }
            emit(kidsOf(el), depth);
          }
          walk(root, 0);
          return { root: sig(root), nodes: count, outline: lines.join('\n') };
        },
        args: [selector, maxDepth, maxNodes],
      });
      const out = res[0]?.result as
        | { root: string; nodes: number; outline: string }
        | { error: string }
        | undefined;
      if (!out) return { error: 'failed to read DOM (tab not scriptable on this URL?)' };
      return out;
    } finally {
      if (ownTab) {
        try {
          await chrome.tabs.remove(tabId);
        } catch {}
      }
    }
  },
});
