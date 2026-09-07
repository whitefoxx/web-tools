import { cli } from '../../runtime/registry.js';
import { forgetManyInKb, listKbEntries, rememberInKb } from '../../localmd-connect/kb-index';

/**
 * localmd Connect only — the browser's memory of which pages the knowledge base
 * already holds, opened up so its owner can correct it.
 *
 * The extension learns an entry when localmd acks a clip naming the file it
 * wrote, and then has no way to notice that the file was deleted or moved: it
 * cannot see the folder. So the folder's app revalidates. Reading the index is
 * `list_saved_pages`; putting it right is `sync_saved_pages`.
 */

cli({
  site: 'generic',
  name: 'list_saved_pages',
  access: 'read',
  local: true,
  description:
    'Pages this browser believes are already in the knowledge base: `{url, path, title, at}` per row, newest first. The extension learned each one from an ack_inbox `written` pair and CANNOT see the folder afterwards, so entries go stale when a note is deleted or moved — the toolbar badge and the popup both read this. Check the paths against the real folder and correct it with sync_saved_pages.',
  args: [],
  func: async () => {
    const pages = await listKbEntries();
    return { count: pages.length, pages };
  },
});

cli({
  site: 'generic',
  name: 'sync_saved_pages',
  access: 'write',
  local: true,
  description:
    'Correct the browser\'s idea of what the knowledge base holds, after checking it against the real folder. `forget` = JSON array of page URLs whose notes are gone (the badge stops claiming them); `moved` = JSON array of {url, path} for notes that still exist somewhere else. Only these two — a page becomes saved in the first place through ack_inbox `written`. Idempotent; unknown URLs are ignored.',
  args: [
    {
      name: 'forget',
      type: 'string',
      help: 'JSON array of page URLs to drop from the index',
    },
    {
      name: 'moved',
      type: 'string',
      help: 'JSON array of {url, path} — notes that are still there under a new path',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const forget = parseUrlList(kwargs.forget);
    const moved = parseMoved(kwargs.moved);
    const forgotten = await forgetManyInKb(forget);
    for (const m of moved) {
      await rememberInKb(m.url, { path: m.path, at: Date.now() });
    }
    return { forgotten, moved: moved.length, count: (await listKbEntries()).length };
  },
});

/** A JSON array of strings, or a comma/whitespace list. Pure. */
export function parseUrlList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  const s = String(v ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String).map((x) => x.trim()).filter(Boolean);
    } catch {
      /* fall through to the list form */
    }
  }
  return s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

/** `moved` argument → {url, path} pairs; malformed entries are dropped rather
 *  than failing the call, which must still apply the forgets. Pure. */
export function parseMoved(v: unknown): Array<{ url: string; path: string }> {
  let arr: unknown = v;
  if (typeof v === 'string') {
    if (!v.trim()) return [];
    try {
      arr = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((e) => e as { url?: unknown; path?: unknown })
    .filter((e) => e && typeof e.url === 'string' && typeof e.path === 'string' && e.path.trim())
    .map((e) => ({ url: String(e.url), path: String(e.path).trim() }));
}
