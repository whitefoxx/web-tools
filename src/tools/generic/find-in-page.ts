import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';

/**
 * find_in_page — a browser-Ctrl+F for the agent: search VISIBLE page text and
 * return match count + a readable context snippet per hit (the hit wrapped in
 * 【…】), instead of dumping the whole page via get_page_text. Answers "does this
 * page mention X / where" cheaply (token-diet), and can scroll the first hit into
 * view (native window.find highlight) so a follow-up screenshot/click lands.
 *
 * Matches on `document.body.innerText` — exactly the visible text the browser's
 * own find sees (hidden / script / style text excluded, layout whitespace
 * collapsed). Plain substring by default (case-insensitive); `regex:true` treats
 * the query as a RegExp. Runs in the page via chrome.scripting (isolated world).
 * Normal mode (NOT explore-only). See docs/adapter-hot-plug.md.
 */

export interface FindMatch {
  /** Readable snippet: surrounding context with the hit wrapped in 【…】. */
  context: string;
}

export interface FindResult {
  query: string;
  regex: boolean;
  /** Total matches found (may exceed matches.length; capped at HARD_MATCH_CAP). */
  count: number;
  /** Per-hit context, up to `limit`. */
  matches: FindMatch[];
  /** count exceeds the returned detail, or the internal cap was hit. */
  truncated: boolean;
  error?: string;
}

/** Backstop so a pathological query (or `a*`-style regex) can't spin forever. */
export const HARD_MATCH_CAP = 2000;

/**
 * Pure text matcher (no DOM) — the tested source of truth. The in-page function
 * below inlines an IDENTICAL copy because chrome.scripting serializes only that
 * function's own body (it can't call this). **Keep the two in sync.**
 */
export function findTextMatches(
  full: string,
  query: string,
  opts: { regex?: boolean; caseSensitive?: boolean; contextChars?: number; limit?: number },
): FindResult {
  const regex = !!opts.regex;
  const caseSensitive = !!opts.caseSensitive;
  const ctx = Math.max(0, Math.min(opts.contextChars ?? 80, 400));
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 30));
  if (!query)
    return { query, regex, count: 0, matches: [], truncated: false, error: 'query must not be empty' };

  const spans: Array<[number, number]> = [];
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(query, 'g' + (caseSensitive ? '' : 'i'));
    } catch (e) {
      return {
        query,
        regex,
        count: 0,
        matches: [],
        truncated: false,
        error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    let m: RegExpExecArray | null;
    while (spans.length < HARD_MATCH_CAP && (m = re.exec(full)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++; // guard zero-width infinite loop
    }
  } else {
    const hay = caseSensitive ? full : full.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    let from = 0;
    while (spans.length < HARD_MATCH_CAP) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      spans.push([i, i + needle.length]);
      from = i + needle.length; // needle is non-empty here
    }
  }

  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
  // Assemble pre+【hit】+post then clean the WHOLE thing, so word spacing around
  // the markers survives (…Fox 【jumps】 over…, not …Fox【jumps】over…).
  const snippet = (s: number, e: number): string =>
    (s - ctx > 0 ? '…' : '') +
    clean(
      `${full.slice(Math.max(0, s - ctx), s)}【${full.slice(s, e)}】${full.slice(e, e + ctx)}`,
    ) +
    (e + ctx < full.length ? '…' : '');
  const matches: FindMatch[] = spans.slice(0, limit).map(([s, e]) => ({ context: snippet(s, e) }));
  return {
    query,
    regex,
    count: spans.length,
    matches,
    truncated: spans.length > matches.length || spans.length >= HARD_MATCH_CAP,
  };
}

cli({
  site: 'generic',
  name: 'find_in_page',
  access: 'read',
  description:
    'Find text on an already-open page (like the browser\'s Ctrl+F): returns the hit count + a context snippet for each hit (the hit is wrapped in 【】), instead of dumping the whole page back — use it to confirm "does this page mention X / where does it mention X", cheaper on tokens than get_page_text and more precise. Case-insensitive by default, matches only VISIBLE text (uses the page innerText, same as browser Ctrl+F; hidden / script / style text is excluded). `regex:true` treats query as a regex (an invalid regex errors). `scroll_to:true` scrolls the first hit to the center of the viewport and natively highlights/selects it (handy for a following screenshot / click). To read a full passage / the whole page use get_page_text; to verify an element by **CSS selector** (rather than text) use query_dom.',
  args: [
    {
      name: 'query',
      type: 'string',
      required: true,
      help: 'The text to find; a regular expression when regex=true',
    },
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help:
        'Target tab id (from open_url / get_page_text {keep_open:true} / list_tabs / get_active_tab)',
    },
    { name: 'regex', type: 'bool', help: 'Treat query as a regex (default false = plain-text substring)' },
    { name: 'case_sensitive', type: 'bool', help: 'Case-sensitive (default false)' },
    {
      name: 'context_chars',
      type: 'int',
      help: 'How many characters of context to keep on each side of a hit (default 80, max 400)',
    },
    {
      name: 'limit',
      type: 'int',
      help: 'Max number of hit details to return (default 5, max 30; count is still the total hit count)',
    },
    { name: 'scroll_to', type: 'bool', help: 'Scroll the first hit into the viewport and natively highlight it (default false)' },
  ],
  columns: ['count', 'truncated'],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const query = typeof kwargs.query === 'string' ? kwargs.query : '';
    if (!query.length) return { error: 'query must not be empty' };
    const opts = {
      regex: !!kwargs.regex,
      caseSensitive: !!kwargs.case_sensitive,
      contextChars: kwargs.context_chars != null ? Number(kwargs.context_chars) : undefined,
      limit: kwargs.limit != null ? Number(kwargs.limit) : undefined,
      scrollTo: !!kwargs.scroll_to,
    };
    let res;
    try {
      res = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: findInPageInPage,
        args: [query, opts],
      });
    } catch (e) {
      return {
        error: `Cannot search this page (may be a browser-internal / restricted page, or the page is reloading): ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const out = res[0]?.result;
    if (!out) return { error: 'Query failed (page is loading / reloading, or the page is not script-injectable)' };
    return out;
  },
});

/** Runs in the page context (chrome.scripting serializes only this function —
 * no module refs). The matching logic MIRRORS findTextMatches above; keep in
 * sync. Adds: innerText source, a length cap, and native window.find scroll. */
function findInPageInPage(
  query: string,
  opts: {
    regex?: boolean;
    caseSensitive?: boolean;
    contextChars?: number;
    limit?: number;
    scrollTo?: boolean;
  },
): FindResult & { scrolled?: boolean } {
  const HARD = 2000;
  const regex = !!opts.regex;
  const caseSensitive = !!opts.caseSensitive;
  const ctx = Math.max(0, Math.min(opts.contextChars ?? 80, 400));
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 30));
  const root = document.body || document.documentElement;
  let full = (root && (root as HTMLElement).innerText) || '';
  const MAX = 2000000; // cap so a giant page can't hang a regex
  if (full.length > MAX) full = full.slice(0, MAX);

  const spans: Array<[number, number]> = [];
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(query, 'g' + (caseSensitive ? '' : 'i'));
    } catch (e) {
      return {
        query,
        regex,
        count: 0,
        matches: [],
        truncated: false,
        error: 'Invalid regex: ' + (e instanceof Error ? e.message : String(e)),
      };
    }
    let m: RegExpExecArray | null;
    while (spans.length < HARD && (m = re.exec(full)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++;
    }
  } else {
    const hay = caseSensitive ? full : full.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    let from = 0;
    while (spans.length < HARD) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      spans.push([i, i + needle.length]);
      from = i + needle.length;
    }
  }

  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const snippet = (s: number, e: number): string =>
    (s - ctx > 0 ? '…' : '') +
    clean(
      `${full.slice(Math.max(0, s - ctx), s)}【${full.slice(s, e)}】${full.slice(e, e + ctx)}`,
    ) +
    (e + ctx < full.length ? '…' : '');
  const matches = spans.slice(0, limit).map(([s, e]) => ({ context: snippet(s, e) }));

  let scrolled: boolean | undefined;
  if (opts.scrollTo && spans.length > 0) {
    scrolled = false;
    try {
      const hitText = full.slice(spans[0][0], spans[0][1]);
      const w = window as unknown as {
        find?: (s: string, cs?: boolean, bw?: boolean, wrap?: boolean) => boolean;
        getSelection?: () => Selection | null;
      };
      if (typeof w.find === 'function') {
        w.getSelection?.()?.removeAllRanges?.();
        // (aCaseSensitive, aBackwards, aWrapAround) — scrolls to + selects the hit.
        scrolled = !!w.find(hitText, caseSensitive, false, true);
      }
    } catch {
      scrolled = false;
    }
  }

  return {
    query,
    regex,
    count: spans.length,
    matches,
    truncated: spans.length > matches.length || spans.length >= HARD,
    ...(opts.scrollTo ? { scrolled } : {}),
  };
}
