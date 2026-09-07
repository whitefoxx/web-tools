import { cli } from '../../runtime/registry.js';
import { assertHttpUrl, assertTabId, waitForPageReady } from './_helpers';
import { createAgentTab } from '../../background/agent-window';
import { getActiveExploreSession } from '../../core/explore-gate';

/**
 * List all links (`<a href>`) on a page — the frontier-extraction PRIMITIVE for
 * agent-orchestrated crawling (and generally useful "what does this page link
 * to?"). We deliberately do NOT ship a `crawl` tool: crawling is a loop (fetch →
 * extract links → filter/dedup → BFS/DFS → repeat → stop), i.e. ORCHESTRATION,
 * which the upper-layer agent (full extension / an external agent over the
 * bridge) does with open_url + get_page_text + this. What was missing was the
 * cheap single-page primitive that makes that loop efficient: one call returns
 * the whole deduped frontier as absolute URLs, instead of get_html + LLM-parsing
 * hrefs on every hop. (query_dom is only a bounded PROBE — ≤30 samples.)
 *
 * Same dual/tri-mode addressing as get_html: `url` (open → read → close),
 * `tab_id` (read an open tab, don't close), or the explore-session tab. The
 * in-page extractor resolves hrefs to absolute, keeps http(s) only, dedupes, and
 * optionally filters to same-origin / a URL regex — all mechanical single-page
 * work, no crawling.
 */
cli({
  site: 'generic',
  name: 'list_links',
  access: 'read',
  description:
    'List every link on a page (`<a href>`) — the **link-extraction primitive** for a higher-level agent orchestrating a "crawl" (we don\'t ship a crawl tool: multi-page crawling is loop orchestration, which the agent runs itself with open_url + get_page_text + this tool). Returns **the whole page\'s deduped links** in one shot (resolved to absolute URLs, keeping only http/https), far cheaper than get_html then having the model extract hrefs. Located the same way as get_html: ① url — open the page, read it, close it; ② tab_id — read an already-open tab (not closed); ③ neither: only valid while an Explore session is running (it uses that session tab). Optional selector to take only the links inside a container (e.g. only main / a certain list), same_origin to take only same-origin links (stay on this site, common when crawling), pattern to filter URLs by regex. Returns {url, text}[] (with total/truncated). (To probe whether a selector is right use query_dom; for the full page body use get_page_text.)',
  args: [
    {
      name: 'url',
      type: 'string',
      help: 'URL of the page to extract links from (http/https). One of url / tab_id (passing url opens a new page and closes it after reading)',
    },
    {
      name: 'tab_id',
      type: 'int',
      help:
        'Target tab id — from open_url, or from get_page_text {url, keep_open:true}. Required unless an Explore session is running (only then may it be omitted, defaulting to that session tab)',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'Optional CSS selector: take only links inside the matched container (e.g. only main / a certain list); omit to take the whole page',
    },
    {
      name: 'same_origin',
      type: 'bool',
      help: 'Return only links same-origin with the page (same protocol+host+port). Use it to stay on this site when crawling. Default false',
    },
    {
      name: 'pattern',
      type: 'string',
      help: 'Optional regex; return only links whose URL matches it (tested against the absolute URL)',
    },
    {
      name: 'limit',
      type: 'int',
      default: 200,
      help: 'Max number of links to return (default 200, max 1000); total gives the real deduped count',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    const urlArg = typeof kwargs.url === 'string' && kwargs.url.trim() ? kwargs.url.trim() : null;
    const hasTabId = kwargs.tab_id !== undefined && kwargs.tab_id !== null && kwargs.tab_id !== '';
    if (urlArg && hasTabId) throw new Error('pass only one of url and tab_id');

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
    const sameOrigin = !!kwargs.same_origin;
    const pattern =
      typeof kwargs.pattern === 'string' && kwargs.pattern.trim() ? kwargs.pattern.trim() : null;
    const limit = Math.max(1, Math.min(1000, Number(kwargs.limit ?? 200) || 200));

    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractLinks,
        args: [selector, sameOrigin, pattern, limit],
      });
      const out = res[0]?.result;
      if (!out) throw new Error('failed to read links (tab not scriptable on this URL?)');
      if (out.error) throw new Error(out.error);
      return {
        url: out.pageUrl,
        title: out.pageTitle,
        count: out.links.length,
        total: out.total,
        truncated: out.truncated,
        links: out.links,
        ...(sameOrigin ? { same_origin: true } : {}),
        ...(pattern ? { pattern } : {}),
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

/**
 * In-page link collector. Self-contained (executeScript serializes ONLY this
 * function — no imports / module refs, like extractSerp / extractPageMarkdown),
 * so scope resolution, shadow-DOM piercing, URL resolution + filtering are all
 * inlined. Exported so it's unit-testable under jsdom.
 *
 * - `scopeSelector`: restrict to links inside matched container(s); null = whole
 *   document. A selector matching nothing → empty result (not a whole-page
 *   fallback), mirroring get_html / get_page_text's selector semantics.
 * - Pierces OPEN shadow roots (bounded walk, cap 12000 nodes) — a plain
 *   querySelectorAll misses links inside web components (same fix as query_dom).
 * - Resolves every href to an absolute URL against location; keeps http(s) only
 *   (drops javascript:/mailto:/tel:/fragment-only); dedupes by absolute URL.
 * - `sameOrigin` keeps only same protocol+host+port; `pattern` (regex string)
 *   keeps only URLs it matches. `total` is the deduped match count before the
 *   `limit` cut, so the caller sees whether more exist (`truncated`).
 */
export function extractLinks(
  scopeSelector: string | null,
  sameOrigin: boolean,
  pattern: string | null,
  limit: number,
): {
  links: { url: string; text: string }[];
  total: number;
  truncated: boolean;
  pageUrl: string;
  pageTitle: string;
  error?: string;
} {
  const base = {
    pageUrl: location.href,
    pageTitle: document.title,
  };
  let re: RegExp | null = null;
  if (pattern) {
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return { links: [], total: 0, truncated: false, ...base, error: `bad pattern: ${String(e)}` };
    }
  }

  let roots: (Document | Element)[];
  if (scopeSelector) {
    try {
      roots = Array.from(document.querySelectorAll(scopeSelector));
    } catch (e) {
      return { links: [], total: 0, truncated: false, ...base, error: `bad selector: ${String(e)}` };
    }
    if (!roots.length) return { links: [], total: 0, truncated: false, ...base };
  } else {
    roots = [document];
  }

  // Collect anchors across the scope + open shadow roots (bounded).
  const anchors: Element[] = [];
  let walked = 0;
  const collect = (root: Document | Element | ShadowRoot): void => {
    root.querySelectorAll('a[href]').forEach((a) => anchors.push(a));
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      if (++walked > 12000) return;
      const sr = (all[i] as HTMLElement).shadowRoot;
      if (sr) collect(sr);
    }
  };
  roots.forEach((r) => collect(r));

  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
  const origin = location.origin;
  const seen = new Set<string>();
  const links: { url: string; text: string }[] = [];
  let total = 0;

  for (const a of anchors) {
    const raw = a.getAttribute('href') || '';
    let abs: URL;
    try {
      abs = new URL(raw, location.href);
    } catch {
      continue;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    const url = abs.href;
    if (sameOrigin && abs.origin !== origin) continue;
    if (re && !re.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    total++;
    if (links.length < limit) {
      const text =
        clean(a.textContent) || clean(a.getAttribute('aria-label')) || clean(a.getAttribute('title'));
      links.push({ url, text: text.slice(0, 150) });
    }
  }

  return { links, total, truncated: total > links.length, ...base };
}
