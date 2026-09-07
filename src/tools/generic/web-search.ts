import { cli } from '../../runtime/registry.js';
import { sleep, waitForPageReady } from './_helpers';
import { createAgentTab } from '../../background/agent-window';

/**
 * Generic web search — the base capability every agent expects next to "fetch a
 * URL" (which get_page_text / get_html already cover). marketplace has plenty of
 * IN-SITE search adapters (zhihu/search, bilibili/search …), but nothing that
 * takes a query to a GENERAL search engine and returns ranked {title,url,snippet}.
 * That's a generic primitive, not a site adapter, so it lives here and ships in
 * BOTH shells (WebCLI too) — external agents get web_search like read/write file.
 *
 * Approach mirrors get_page_text's url-mode exactly (no API key, uses the user's
 * real Chrome session so bot-detection is far milder than a headless scraper):
 * open the engine's SERP in a throwaway background agent tab → waitForPageReady
 * on the first result LINK → executeScript a self-contained per-engine extractor
 * → close the tab in finally. The extractor returns structured results; the agent
 * then get_page_text's whichever URLs it wants — clean search / fetch split.
 *
 * Engines (3 natively supported): google (best results, most volatile DOM),
 * bing (stable DOM, EN+CN), duckduckgo (lite.duckduckgo.com — no-JS, most
 * parseable, EN-leaning). With no `engine` given, they're tried in the order
 * google → bing → duckduckgo and the first that yields results wins.
 *
 * Two robustness layers over the raw scrape:
 *   1. `max_wait_ms` — the page-ready wait cap is a TUNABLE arg (default usually
 *      enough); a slow/heavy SERP can be retried with a bigger budget.
 *   2. Text fallback — if NO engine yields structured results (selectors rotted,
 *      SERP restructured, or a block page), we still return the SERP's visible
 *      TEXT (`fallback:"text"`, `text` field) so the agent gets *something*
 *      readable instead of nothing. This same open-URL-then-read-text path is how
 *      a user/agent can search an UNSUPPORTED engine today (open_url its query URL
 *      → get_page_text) — the 3 above just additionally get parsed results.
 */

type Engine = 'bing' | 'duckduckgo' | 'google';

/** Try order when the caller doesn't pin an engine. Exported for tests. */
export const ENGINE_ORDER: Engine[] = ['google', 'bing', 'duckduckgo'];

/**
 * Parse the (REQUIRED) engine arg, with common aliases.
 *   'auto'            → cascade ENGINE_ORDER
 *   an engine name    → pin exactly that one
 *   anything else     → null, and the caller REJECTS the call
 *
 * The rejection is the point. This used to fold blank/unknown into "cascade",
 * so `engine:"baidu"` silently searched Google and reported it as a success —
 * the caller believed it had pinned an engine it had not. An unsupported engine
 * is now an argument error naming the four legal values, and `auto` exists so
 * "I don't care, just find something" stays expressible. Exported for tests.
 */
export function parseEngine(v: unknown): Engine | 'auto' | null {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s === 'auto') return 'auto';
  if (s === 'duckduckgo' || s === 'ddg' || s === 'duck') return 'duckduckgo';
  if (s === 'google' || s === 'g') return 'google';
  if (s === 'bing' || s === 'b') return 'bing';
  return null; // unsupported engine → argument error, never a silent substitution
}

/** Build the SERP URL + a "results are present" selector to short-circuit the
 * page-ready wait, per engine. The ready selector MUST target an actual result
 * LINK, not just the results container: bing streams `<li class="b_algo">`
 * front-loaded with a big inline CSS blob well before the `<h2><a>` inside it
 * parses, so waiting on the container alone fires at readyState "interactive"
 * and extracts before any anchor exists (0 results). Waiting on the anchor
 * guarantees at least one result is parsed. `www.bing.com`/`www.google.com`
 * redirect to the regional host (cn.bing.com / google.com.hk) automatically —
 * both use the same result markup, so no region-specific URL is needed. */
export function buildEngine(
  engine: Engine,
  query: string,
  count: number,
): { url: string; ready: string } {
  const q = encodeURIComponent(query);
  switch (engine) {
    case 'duckduckgo':
      // lite is the no-JS, table-rendered variant — the most scrape-stable SERP.
      return { url: `https://lite.duckduckgo.com/lite/?q=${q}`, ready: 'a.result-link, a.result__a' };
    case 'google':
      return { url: `https://www.google.com/search?q=${q}&num=${count}`, ready: '#search a h3, #rso a h3' };
    case 'bing':
    default:
      return { url: `https://www.bing.com/search?q=${q}&count=${count}`, ready: 'li.b_algo h2 a' };
  }
}

/** Run the in-page SERP extractor once against `tabId`. Split out so the caller
 * can retry it on an empty (still-hydrating) result. */
async function runExtract(
  tabId: number,
  engine: Engine,
  count: number,
): Promise<ReturnType<typeof extractSerp>> {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractSerp,
    args: [engine, count],
  });
  const r = res[0]?.result;
  if (!r) throw new Error('executeScript returned no result (SERP tab not scriptable?)');
  return r;
}

/** Grab the SERP's visible text as fallback material (when structured parsing
 * yields nothing). Truncated; best-effort — returns '' on any failure. */
async function grabSerpText(tabId: number, maxChars = 8000): Promise<string> {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (max: number) => (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, max),
      args: [maxChars],
    });
    return (res[0]?.result as string) ?? '';
  } catch {
    return '';
  }
}

interface SearchAttempt {
  engine: Engine;
  results: ReturnType<typeof extractSerp>['results'];
  blocked: boolean;
  blockReason: string;
  pageUrl: string;
  wait: Awaited<ReturnType<typeof waitForPageReady>>;
  /** SERP visible text — captured ONLY when `results` is empty (fallback material). */
  text?: string;
}

/** Open one engine's SERP in a throwaway background tab, wait for a result link,
 * extract structured results (retrying on empty in case the SERP is still
 * hydrating), and — only if we got nothing — grab the page's visible text as
 * fallback material. Always closes its tab. `maxWaitMs` is caller-tunable. */
async function openAndSearch(
  engine: Engine,
  query: string,
  count: number,
  maxWaitMs: number,
): Promise<SearchAttempt> {
  const { url, ready } = buildEngine(engine, query, count);
  const tab = await createAgentTab(url, { active: false });
  if (typeof tab.id !== 'number') throw new Error('failed to open search tab');
  const tabId = tab.id;
  try {
    const wait = await waitForPageReady(tabId, { maxWaitMs, quietMs: 500, waitForSelector: ready });
    let r: ReturnType<typeof extractSerp> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await runExtract(tabId, engine, count);
      } catch {
        r = undefined; // extraction threw (page not scriptable / odd DOM) → treat as empty
      }
      if (r && (r.results.length > 0 || r.blocked)) break;
      if (attempt < 2) await sleep(700);
    }
    const results = r?.results ?? [];
    // Fallback text only on the empty path — skipped on the happy path (cheap).
    const text = results.length === 0 ? await grabSerpText(tabId) : undefined;
    return {
      engine,
      results,
      blocked: r?.blocked ?? false,
      blockReason: r?.blockReason ?? '',
      pageUrl: r?.pageUrl ?? url,
      wait,
      text,
    };
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {}
  }
}

cli({
  site: 'generic',
  name: 'web_search',
  access: 'read',
  description:
    'Generic web search: give a query, search it on a search engine, and get back a list of structured results {rank, title, url, snippet} (not page body text — to read the body of a result, call get_page_text on its url). This is a foundational capability, forming a search+fetch pair with get_page_text (which fetches a URL). **`engine` is REQUIRED — state it every call**, one of: "auto" (try google→bing→duckduckgo in order, take the first that returns results — the right choice unless you have a reason) | "google" (best results) | "bing" (stable DOM, works for both Chinese and English) | "duckduckgo" (lite JS-free page, easiest to parse, English-leaning). Any other value is rejected rather than quietly substituted. If no engine can parse structured results (selector broke / SERP changed / verification page), it **falls back** to the **plain text** of the search results page (`fallback:"text"` + `text` field), which the agent can still work from. For slow/heavy pages, raise `max_wait_ms` and retry. **If the target is a known site (知乎/B站/微博…) with a matching adapter installed, prefer its in-site search.** Runs through the user\'s real browser session — no API key needed.',
  args: [
    { name: 'query', type: 'string', required: true, help: 'Search keyword / question' },
    {
      name: 'engine',
      type: 'string',
      required: true,
      help: '**Required, no default** — pass it explicitly so the call says what it does. "auto" = try google→bing→duckduckgo in order and take the first with results (use this unless you specifically want one engine); or pin exactly one: "google" | "bing" | "duckduckgo" (aliases: g / b / ddg). An unsupported value (e.g. "baidu", "yahoo") is an error, NOT a silent fall back to another engine — if the one you want is not listed, open its query URL with open_url and read the page instead',
    },
    {
      name: 'count',
      type: 'int',
      default: 10,
      help: 'Max results to return (default 10, cap 20)',
    },
    {
      name: 'max_wait_ms',
      type: 'int',
      default: 12000,
      help: 'Per-engine **cap** on waiting for the SERP to be ready (milliseconds, default 12000, range 1000–60000) — not a fixed wait: it returns as soon as results appear (a few hundred ms on a fast connection), and only approaches this cap when the page is very slow / results never show. Only raise it and retry when slow loading is the suspected cause of empty results',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const query = String(kwargs.query ?? '').trim();
    if (!query) throw new Error('query must not be empty');
    // engine is required AND validated: an unsupported value fails loudly here
    // instead of silently searching somewhere else (the caller would never learn
    // its pin was ignored). `auto` is the explicit way to ask for the cascade.
    const chosen = parseEngine(kwargs.engine);
    if (!chosen) {
      throw new Error(
        `engine "${String(kwargs.engine ?? '')}" is not supported. Pass one of: "auto" (try google→bing→duckduckgo, take the first with results), "google", "bing", "duckduckgo". To search an engine that is not on that list, open its query URL with open_url and read the page.`,
      );
    }
    const count = Math.max(1, Math.min(20, Number(kwargs.count ?? 10) || 10));
    const maxWaitMs = Math.max(1000, Math.min(60_000, Number(kwargs.max_wait_ms ?? 12_000) || 12_000));

    // "auto" → cascade google→bing→duckduckgo, stopping at the first engine that
    // yields structured results; a pinned engine → just that one.
    const engines = chosen === 'auto' ? ENGINE_ORDER : [chosen];
    const attempts: SearchAttempt[] = [];
    for (const eng of engines) {
      const a = await openAndSearch(eng, query, count, maxWaitMs);
      attempts.push(a);
      if (a.results.length > 0) {
        return {
          engine: eng,
          query,
          count: a.results.length,
          results: a.results,
          page_url: a.pageUrl,
          wait: a.wait,
          // Only note the cascade when more than one engine was actually tried.
          ...(attempts.length > 1 ? { tried: attempts.map(briefAttempt) } : {}),
        };
      }
    }

    // No engine produced structured results → text fallback. Prefer the first
    // attempt that wasn't a block page and has real text; else the first attempt.
    const fb = attempts.find((a) => !a.blocked && (a.text ?? '').trim().length > 0) ?? attempts[0];
    const anyBlocked = attempts.some((a) => a.blocked);
    return {
      engine: fb.engine,
      query,
      count: 0,
      results: [],
      page_url: fb.pageUrl,
      wait: fb.wait,
      fallback: 'text',
      text: fb.text ?? '',
      tried: attempts.map(briefAttempt),
      ...(anyBlocked ? { blocked: true } : {}),
      note: `Could not parse structured results (${anyBlocked ? 'likely a verification/block page; ' : ''}selector may have broken or SERP structure changed). Fell back to the plain text of the ${fb.engine} results page (see text field), which the agent can work from; you can also raise max_wait_ms or switch engine and retry.`,
    };
  },
});

/** Compact per-engine summary for the `tried` field (cascade / fallback trace). */
function briefAttempt(a: SearchAttempt): {
  engine: Engine;
  count: number;
  blocked: boolean;
} {
  return { engine: a.engine, count: a.results.length, blocked: a.blocked };
}

/**
 * In-page SERP → structured results. Self-contained (executeScript serializes
 * ONLY this function — no imports / module refs, like extractPageMarkdown), so
 * all per-engine selectors + redirect-URL decoding are inlined. Exported so it's
 * unit-testable under jsdom (set document.body.innerHTML, call directly).
 *
 * Each engine has multiple candidate selectors + a fallback so a minor DOM drift
 * degrades gracefully instead of returning zero. Redirect hrefs are decoded to
 * the real target (DDG's //duckduckgo.com/l/?uddg=… and Google's /url?q=…).
 * When zero results, a heuristic flags a likely bot-check / CAPTCHA page so the
 * caller can surface "switch engine / hand off" instead of "no matches".
 */
export function extractSerp(
  engine: string,
  maxResults: number,
): {
  results: { rank: number; title: string; url: string; snippet: string }[];
  pageUrl: string;
  pageTitle: string;
  blocked: boolean;
  blockReason: string;
} {
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  // Decode an engine redirect wrapper to the real destination, else return as-is.
  const deref = (raw: string): string => {
    try {
      const u = new URL(raw, location.href);
      const host = u.hostname.toLowerCase();
      // DuckDuckGo: //duckduckgo.com/l/?uddg=<encoded target>
      if (host.endsWith('duckduckgo.com') && u.searchParams.has('uddg')) {
        return u.searchParams.get('uddg') || raw;
      }
      // Google: /url?q=<target> (older layouts / consent bounces)
      if (host.endsWith('google.com') && u.pathname === '/url') {
        return u.searchParams.get('q') || u.searchParams.get('url') || raw;
      }
      return u.href;
    } catch {
      return raw;
    }
  };

  const isExternalHttp = (raw: string, engineHost: RegExp): boolean => {
    if (!/^https?:\/\//i.test(raw)) return false;
    try {
      return !engineHost.test(new URL(raw).hostname.toLowerCase());
    } catch {
      return false;
    }
  };

  const collected: { title: string; url: string; snippet: string }[] = [];
  const seen = new Set<string>();
  const push = (title: string, url: string, snippet: string): void => {
    if (!title || !url || seen.has(url)) return;
    seen.add(url);
    collected.push({ title, url, snippet: snippet.slice(0, 300) });
  };

  if (engine === 'bing') {
    let blocks = Array.from(document.querySelectorAll('#b_results > li.b_algo'));
    if (!blocks.length) blocks = Array.from(document.querySelectorAll('li.b_algo'));
    for (const li of blocks) {
      const a = li.querySelector('h2 a[href]') as HTMLAnchorElement | null;
      if (!a) continue;
      const url = deref(a.href);
      if (!isExternalHttp(url, /(^|\.)bing\.com$|(^|\.)microsoft\.com$/)) continue;
      const snipEl =
        li.querySelector('.b_caption p') ||
        li.querySelector('.b_algoSlug') ||
        li.querySelector('.b_caption') ||
        li.querySelector('p');
      push(clean(a.textContent), url, clean(snipEl?.textContent));
      if (collected.length >= maxResults) break;
    }
  } else if (engine === 'duckduckgo') {
    // lite variant: <a class="result-link"> + sibling <td class="result-snippet">.
    // Fallback to the html variant's .result__a / .result__snippet.
    let links = Array.from(document.querySelectorAll('a.result-link')) as HTMLAnchorElement[];
    let snips = Array.from(document.querySelectorAll('.result-snippet'));
    if (!links.length) {
      links = Array.from(document.querySelectorAll('a.result__a')) as HTMLAnchorElement[];
      snips = Array.from(document.querySelectorAll('.result__snippet'));
    }
    links.forEach((a, i) => {
      if (collected.length >= maxResults) return;
      const url = deref(a.href);
      if (!isExternalHttp(url, /(^|\.)duckduckgo\.com$/)) return;
      push(clean(a.textContent), url, clean(snips[i]?.textContent));
    });
  } else if (engine === 'google') {
    // Every organic result is an <h3> inside a result anchor within #search/#rso.
    let nodes = Array.from(document.querySelectorAll('#search a[href] h3, #rso a[href] h3'));
    if (!nodes.length) nodes = Array.from(document.querySelectorAll('a[href] h3'));
    for (const h3 of nodes) {
      if (collected.length >= maxResults) break;
      const a = h3.closest('a[href]') as HTMLAnchorElement | null;
      if (!a) continue;
      const url = deref(a.href);
      if (!isExternalHttp(url, /(^|\.)google\.com$|(^|\.)gstatic\.com$/)) continue;
      const block =
        (a.closest('div.g') as HTMLElement | null) ||
        (a.closest('[data-hveid]') as HTMLElement | null) ||
        (a.parentElement as HTMLElement | null);
      const snipEl = block?.querySelector('.VwiC3b, [data-sncf], .kb0PBd, .lyLwlc');
      push(clean(h3.textContent), url, clean(snipEl?.textContent));
    }
  }

  // Bot-check / CAPTCHA heuristic — only meaningful when we got nothing.
  let blocked = false;
  let blockReason = '';
  if (collected.length === 0) {
    const href = location.href.toLowerCase();
    const title = (document.title || '').toLowerCase();
    // innerText needs layout (and jsdom omits it); textContent is the robust
    // fallback for a plain "is this a block page" text scan.
    const body = (document.body?.innerText || document.body?.textContent || '')
      .slice(0, 4000)
      .toLowerCase();
    const hit = (s: string): boolean => body.includes(s) || title.includes(s);
    if (
      href.includes('/sorry/') ||
      href.includes('/captcha') ||
      hit('unusual traffic') ||
      hit('not a robot') ||
      hit('are you a robot') ||
      hit('verify you are human') ||
      hit('captcha') ||
      hit('detected unusual') ||
      hit('anomaly')
    ) {
      blocked = true;
      blockReason = href.includes('/sorry/')
        ? 'redirected to /sorry (bot-check)'
        : 'captcha/verification text on page';
    }
  }

  return {
    results: collected
      .slice(0, maxResults)
      .map((r, i) => ({ rank: i + 1, title: r.title, url: r.url, snippet: r.snippet })),
    pageUrl: location.href,
    pageTitle: document.title,
    blocked,
    blockReason,
  };
}
