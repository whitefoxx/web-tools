import { cli } from '../../runtime/registry.js';
import { listInbox, ackInbox, summarize, pickInboxBatch } from '../../localmd-connect/inbox';
import { rememberInKb } from '../../localmd-connect/kb-index';

/**
 * localmd Connect only — the pull half of the capture inbox (see
 * src/localmd-connect/inbox.ts for the design). The push half is the
 * `notifications/localmd/inbox {count}` poke the SW broadcasts on change.
 */

const LIST_CAP = 20;

cli({
  site: 'generic',
  name: 'list_inbox',
  access: 'read',
  local: true,
  description:
    'Pending items the user captured FROM THE BROWSER for localmd — via the extension\'s context menu, keyboard shortcut or popup — waiting to be written into the knowledge base. Kinds: "clip" (payload = the same object clip_page returns: metadata + Markdown + images, or {kind:"pdf", data} for a PDF), "ask" (the user wants to talk about a page: payload {selection?}; attach the tab and answer), "screenshot" ({dataUrl}), "highlight". Oldest first, and bounded by BYTES as well as by `limit`: one reply carries at most ~12MB of items (a full-page screenshot is several MB), the rest wait for the next call — keep calling until `pending` is 0. An item too large to travel even alone comes back without its payload and with `oversized:true` and its `bytes`; ack it, it cannot be delivered. Items stay until ack_inbox removes them, so process each one (write the note / start the conversation) and then ack its id. The extension sends `notifications/localmd/inbox {count}` whenever this list changes. Pass `summary:true` to list without payloads.',
  args: [
    {
      name: 'limit',
      type: 'int',
      help: `Max items (default 5, cap ${LIST_CAP}); the total pending count is always returned`,
    },
    {
      name: 'summary',
      type: 'bool',
      help: 'true = ids, kinds, urls and titles only (no payloads); default false',
    },
    { name: 'kind', type: 'string', help: 'Optional filter: clip | ask | highlight | screenshot' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const limit = Math.max(1, Math.min(LIST_CAP, Number(kwargs.limit ?? 5) || 5));
    const kind = typeof kwargs.kind === 'string' && kwargs.kind.trim() ? kwargs.kind.trim() : null;
    const all = await listInbox();
    const filtered = kind ? all.filter((i) => i.kind === kind) : all;
    // A summary is small whatever the payloads weigh; a full listing is cut
    // to what one frame can carry (see pickInboxBatch).
    const page = kwargs.summary
      ? filtered.slice(0, limit).map(summarize)
      : pickInboxBatch(filtered, limit);
    return {
      pending: all.length,
      ...(kind ? { matching: filtered.length } : {}),
      returned: page.length,
      items: page,
    };
  },
});

cli({
  site: 'generic',
  name: 'ack_inbox',
  access: 'write',
  local: true,
  description:
    'Remove processed items from the capture inbox by id (after the note is written / the ask is being handled). Idempotent: unknown ids are ignored. Returns the number removed and how many remain. When you WROTE a clip, also pass `written` — the item id and the KB path of the note — so the browser learns that page is now in the knowledge base: its toolbar icon then says so on that page, and clip_page will report `already_in_kb` before clipping it again.',
  args: [
    {
      name: 'ids',
      type: 'string',
      required: true,
      help: 'JSON array of item ids, or a comma-separated list',
    },
    {
      name: 'written',
      type: 'string',
      help: 'Optional JSON array of {id, path} — which inbox item became which KB file. Only clips need this',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const ids = parseIds(kwargs.ids);
    if (!ids.length) throw new Error('ids must name at least one inbox item id');
    // Learn the mapping BEFORE the items are gone: the item carries the page
    // URL (and, for a clip, its canonical URL) that the path is filed under.
    const written = parseWritten(kwargs.written);
    let remembered = 0;
    if (written.length) {
      const items = await listInbox();
      for (const w of written) {
        const item = items.find((i) => i.id === w.id);
        if (!item) continue;
        const canonical = (item.payload as { canonical?: unknown } | null)?.canonical;
        await rememberInKb(
          item.url,
          { path: w.path, at: Date.now(), ...(item.title ? { title: item.title } : {}) },
          typeof canonical === 'string' ? canonical : undefined,
        );
        remembered++;
      }
    }
    const removed = await ackInbox(ids);
    const remaining = (await listInbox()).length;
    return { removed, remaining, ...(remembered ? { remembered } : {}) };
  },
});

export function parseIds(v: unknown): string[] {
  if (Array.isArray(v))
    return v
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  const s = String(v ?? '').trim();
  if (!s) return [];
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

/** `written` argument → {id, path} pairs; anything malformed is dropped, not
 *  fatal — the ack itself must still go through. Pure. */
export function parseWritten(v: unknown): Array<{ id: string; path: string }> {
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
    .map((e) => e as { id?: unknown; path?: unknown })
    .filter((e) => e && typeof e.id === 'string' && typeof e.path === 'string' && e.path.trim())
    .map((e) => ({ id: String(e.id), path: String(e.path).trim() }));
}
