import { cli } from '../../runtime/registry.js';
import {
  clearPageHighlights,
  listAllHighlights,
  loadHighlights,
  pageKey,
  removeHighlight,
  type HighlightEntry,
} from '../../selection/highlights-store';

/**
 * What the user marked while reading — localmd Connect's read/write surface over
 * the in-page highlighter (src/localmd-connect/page-tools.ts).
 *
 * The full shell registers a `get_highlights` too, and this is not it: that one
 * is gated behind `FEATURES.selectionToolbar` and reads a store with no colours
 * and no notes. Registered here from `_localmd.ts`, this version returns both,
 * and is paired with a delete so a highlight archived into the knowledge base
 * can be cleared from the browser — the asymmetry of a create with no remove is
 * a mistake this shell already made once with bookmarks.
 *
 * Highlights are a WORKING COPY on this side. They reach the knowledge base
 * when a clip is written (clip_page carries the page's highlights) or when the
 * agent asks for them here — never by pushing, which would make twenty
 * highlights on one page twenty interruptions.
 */

const LIMIT_DEFAULT = 200;
const LIMIT_CAP = 1000;

function row(e: HighlightEntry): Record<string, unknown> {
  return {
    id: e.id,
    text: e.exact,
    ...(e.color ? { color: e.color } : {}),
    ...(e.note ? { note: e.note } : {}),
    date: new Date(e.ts).toISOString(),
    // The anchor, so a caller can find the passage in the live page again —
    // and so an archived highlight can point back at where it came from.
    anchor: { exact: e.exact, prefix: e.prefix, suffix: e.suffix },
  };
}

cli({
  site: 'generic',
  name: 'get_highlights',
  access: 'read',
  local: true,
  description:
    "Passages the user highlighted in their browser, with the colour and any note they wrote. This is the reading they did BY HAND — the strongest signal in the browser about what mattered to them on a page. Pass `url` for one page's highlights, or `query` to search text / title / URL across every page, or neither for everything (newest page first). Each row carries a TextQuote anchor {exact, prefix, suffix} so the passage can be found again in the live page. Highlights are made in the page itself, not by tools; they are a working copy in the extension until you write them into the knowledge base.",
  args: [
    {
      name: 'url',
      type: 'string',
      help: "One page's highlights (the page URL; the #hash is ignored)",
    },
    {
      name: 'query',
      type: 'string',
      help: 'Case-insensitive match on highlight text, page title or URL',
    },
    {
      name: 'limit',
      type: 'int',
      help: `Max highlights across all pages (default ${LIMIT_DEFAULT}, cap ${LIMIT_CAP})`,
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const limit = Math.max(
      1,
      Math.min(LIMIT_CAP, Number(kwargs.limit ?? LIMIT_DEFAULT) || LIMIT_DEFAULT),
    );
    const url = typeof kwargs.url === 'string' && kwargs.url.trim() ? kwargs.url.trim() : null;
    const q = String(kwargs.query ?? '')
      .trim()
      .toLowerCase();

    if (url) {
      const entries = await loadHighlights(pageKey(url));
      const hits = q
        ? entries.filter(
            (e) => e.exact.toLowerCase().includes(q) || (e.note ?? '').toLowerCase().includes(q),
          )
        : entries;
      return {
        url,
        count: hits.length,
        highlights: hits.slice(0, limit).map(row),
        ...(hits.length > limit ? { truncated: true } : {}),
      };
    }

    const pages = await listAllHighlights();
    const results: Array<Record<string, unknown>> = [];
    let total = 0;
    let shown = 0;
    for (const p of pages) {
      const title = p.entries.find((e) => e.title)?.title ?? '';
      const matches = q
        ? p.entries.filter(
            (e) =>
              e.exact.toLowerCase().includes(q) ||
              (e.note ?? '').toLowerCase().includes(q) ||
              title.toLowerCase().includes(q) ||
              p.url.toLowerCase().includes(q),
          )
        : p.entries;
      if (!matches.length) continue;
      total += matches.length;
      if (shown >= limit) continue;
      const take = matches.slice(0, limit - shown);
      shown += take.length;
      results.push({ url: p.url, title, count: matches.length, highlights: take.map(row) });
    }
    return {
      pages: results.length,
      total,
      results,
      ...(total > shown ? { truncated: true, note: 'Narrow with `query` or a `url`.' } : {}),
    };
  },
});

cli({
  site: 'generic',
  name: 'delete_highlights',
  access: 'write',
  local: true,
  description:
    "Remove highlights from a page — one by id, several by ids, or every highlight on that page when `ids` is omitted. Use it after archiving them into the knowledge base, or when the user asks to clear a page. The marks disappear from any open tab showing that page. This DELETES the user's own annotations and cannot be undone from here, so confirm first; get_highlights returns everything needed to write them down before you do.",
  args: [
    { name: 'url', type: 'string', required: true, help: 'The page URL (the #hash is ignored)' },
    {
      name: 'ids',
      type: 'string',
      help: 'JSON array or comma-separated highlight ids from get_highlights. Omit to clear the whole page',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const url = String(kwargs.url ?? '').trim();
    if (!url) throw new Error('url is required (the page whose highlights to remove)');
    const key = pageKey(url);
    const before = await loadHighlights(key);
    if (!before.length)
      return { url, removed: 0, remaining: 0, note: 'That page has no highlights.' };
    const ids = parseHighlightIds(kwargs.ids);
    if (!ids) {
      await clearPageHighlights(key);
      return { url, removed: before.length, remaining: 0, cleared: true };
    }
    const known = new Set(before.map((e) => e.id));
    const hit = ids.filter((id) => known.has(id));
    for (const id of hit) await removeHighlight(key, id);
    return {
      url,
      removed: hit.length,
      remaining: before.length - hit.length,
      ...(hit.length < ids.length ? { unknown_ids: ids.filter((id) => !known.has(id)) } : {}),
    };
  },
});

/** ids argument → a list, or null meaning "all of them". Pure. */
export function parseHighlightIds(v: unknown): string[] | null {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
  if (Array.isArray(v))
    return v
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr))
        return arr
          .map(String)
          .map((x) => x.trim())
          .filter(Boolean);
    } catch {
      /* fall through to the comma form */
    }
  }
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
