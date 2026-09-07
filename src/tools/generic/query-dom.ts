import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';
import { getActiveExploreSession } from '../../core/explore-gate';

/**
 * Explore-time selector probe: given a CSS selector, return the match count and
 * a few lightweight samples (tag, shallow open-tag with its attrs, a short text
 * preview, link, child count). The safe, structured way to answer "is this
 * selector right, and is it grabbing the data I want?" before committing to a
 * synthesis. ISOLATED content world, explore tab by default.
 *
 * IMPORTANT (see docs/llm-explore.md §V2.4): everything done per-match is
 * **bounded** — shallow `cloneNode(false)` open-tag (O(attrs), not the whole
 * subtree) and a TreeWalker that stops after a small text budget — so a broad
 * selector or a huge element can't serialize megabytes on the page's main thread
 * and freeze the tab. For the FULL HTML of one element, use get_html(selector).
 */
cli({
  site: 'generic',
  name: 'query_dom',
  access: 'read',
  description:
    'Probe the page with a **CSS selector**: returns the match count + the first few matches (tag / opening tag with attributes / text preview / link / child count; includes open shadow DOM). Use it to quickly verify "is this selector right, is what it grabs the data I want". (To check whether **visible text** is on the page, use find_in_page; for one element\'s full HTML use get_html(selector); for the whole-page body use get_page_text.) Pass tab_id (omitting it is only valid while an Explore session is running).',
  args: [
    { name: 'selector', type: 'string', required: true, help: 'CSS selector' },
    {
      name: 'tab_id',
      type: 'int',
      help: 'Target tab id — from open_url, or from get_page_text {url, keep_open:true}. Required unless an Explore session is running (only then may it be omitted, defaulting to that session tab)',
    },
    { name: 'limit', type: 'int', default: 5, help: 'Max match samples to return (default 5, cap 30)' },
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
    const selector = typeof kwargs.selector === 'string' ? kwargs.selector : '';
    if (!selector.trim()) return { error: 'selector must not be empty' };
    const limit = Math.max(1, Math.min(Number(kwargs.limit ?? 5) || 5, 30));

    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string, lim: number) => {
        // Matches across document + open shadow roots (bounded walk) — a plain
        // querySelectorAll can't pierce shadow DOM, so probes on lit/web-component
        // pages reported count:0 for elements that exist.
        let nodes: Element[];
        try {
          nodes = Array.from(document.querySelectorAll(sel));
          const roots: ShadowRoot[] = [];
          let walked = 0;
          const scan = (r: Document | ShadowRoot): void => {
            const all = r.querySelectorAll('*');
            for (let i = 0; i < all.length; i++) {
              if (++walked > 12000) return;
              const sr = (all[i] as HTMLElement).shadowRoot;
              if (sr) roots.push(sr);
            }
          };
          scan(document);
          for (let qi = 0; qi < roots.length && walked <= 12000; qi++) {
            roots[qi].querySelectorAll(sel).forEach((e) => nodes.push(e));
            scan(roots[qi]);
          }
        } catch (e) {
          return { error: `bad selector: ${e instanceof Error ? e.message : String(e)}` };
        }
        const count = nodes.length;
        // Bounded text: walk text nodes only until a small budget — never builds
        // the whole subtree's textContent (which can be megabytes on a big
        // element and froze the tab).
        const shortText = (el: Element): string => {
          let out = '';
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let n: Node | null;
          while (out.length < 400 && (n = w.nextNode())) out += (n.textContent || '') + ' ';
          return out.replace(/\s+/g, ' ').trim().slice(0, 200);
        };
        const samples = [];
        const k = Math.min(count, lim);
        for (let i = 0; i < k; i++) {
          const el = nodes[i];
          const a = el.matches('a[href]') ? el : el.querySelector('a[href]');
          // Shallow open tag only: cloneNode(false) drops children, so outerHTML
          // here is O(attrs), not O(subtree).
          const open = (el.cloneNode(false) as Element).outerHTML;
          samples.push({
            tag: el.tagName.toLowerCase(),
            open: open.length > 400 ? open.slice(0, 400) : open,
            text: shortText(el),
            href: a ? a.getAttribute('href') || undefined : undefined,
            children: el.childElementCount,
          });
        }
        return { count, samples };
      },
      args: [selector, limit],
    });
    const out = res[0]?.result as
      | { count: number; samples: unknown[] }
      | { error: string }
      | undefined;
    if (!out) {
      return {
        error:
          'Query failed — the page may be loading or was just refreshed (retry shortly), or scripts cannot be injected into it (chrome://, etc.).',
      };
    }
    if ('error' in out && out.error) return out;
    return { selector, ...out };
  },
});
