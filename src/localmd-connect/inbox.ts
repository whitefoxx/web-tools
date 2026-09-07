/**
 * The capture inbox — what the BROWSER hands to localmd.
 *
 * Every other path in this shell is localmd pulling (its agent calls a tool).
 * A clip, a highlight or an "ask localmd about this" starts on the other side:
 * the user is on some page and presses a menu item, a shortcut or a popup
 * button, and localmd may not even be open. So the gesture lands HERE first —
 * an IndexedDB queue owned by the extension — and reaches localmd in two steps:
 *
 *   1. a poke: `notifications/localmd/inbox {count}` over every live relay port
 *      (and once more when a page finishes its handshake), so an open localmd
 *      tab reacts at once;
 *   2. a pull: localmd calls `list_inbox`, writes what it wants into the KB
 *      (its own paths, its own frontmatter — the extension never decides where
 *      a note goes), then `ack_inbox` removes the items.
 *
 * Why not push the payload inside the notification: the notification is a
 * hint, not a delivery — a tab can miss it (mid-reload, SW recycled between
 * capture and connect) and a 1-of-2 delivery for something the user just
 * captured is the failure this design exists to rule out. The queue is the
 * truth; the poke is an optimization.
 *
 * Why the queue lives in the extension and not the KB: localmd's rule is that
 * the KB holds only what the user owns (notes, sources) — never a record the
 * machinery has to keep correct. This inbox is exactly such a record, so it
 * stays on this side, built to be lost: an unacked item is re-listed next
 * time, an acked one is gone, and nothing in the KB is wrong either way.
 *
 * Storage: its own IndexedDB (`localmd-connect-inbox`), not chrome.storage —
 * a clip with inlined images is megabytes, and storage.local's quota is not.
 */
import { warn } from '../runtime/log';

export type InboxKind = 'clip' | 'ask' | 'highlight' | 'screenshot';

export interface InboxItem {
  id: string;
  kind: InboxKind;
  createdAt: number;
  /** Page the gesture happened on. */
  url: string;
  title: string;
  /** The tab, when it is still around — lets localmd attach it as a chip
   * (`ask`) and read it live instead of from the clip. */
  tabId?: number;
  /** Kind-specific body: a ClipPayload for `clip`, `{selection?}` for `ask`. */
  payload: unknown;
}

/** Ordered oldest-first: the user's gestures arrive in the order made. */
export function sortInbox(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function makeInboxId(now = Date.now()): string {
  return `ib_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function makeInboxItem(
  kind: InboxKind,
  fields: { url: string; title: string; tabId?: number; payload: unknown },
  now = Date.now(),
): InboxItem {
  return {
    id: makeInboxId(now),
    kind,
    createdAt: now,
    url: fields.url,
    title: fields.title,
    ...(typeof fields.tabId === 'number' ? { tabId: fields.tabId } : {}),
    payload: fields.payload,
  };
}

/** A listing row: everything but the (possibly huge) payload. */
export interface InboxSummary {
  id: string;
  kind: InboxKind;
  createdAt: number;
  url: string;
  title: string;
  tabId?: number;
}

export function summarize(item: InboxItem): InboxSummary {
  const { payload: _payload, ...rest } = item;
  return rest;
}

// ── frame-safe batches ────────────────────────────────────────────────────────

/** The largest JSON-RPC frame the localmd Connect service worker will send to
 *  a page (its `maxOutboundBytes`). Anything bigger is TRUNCATED to fit, and a
 *  truncated JSON document is not a smaller document, it is not JSON. */
export const LOCALMD_FRAME_BYTES = 16 * 1_048_576;

/** How many bytes of items one `list_inbox` reply may carry. Below the frame
 *  ceiling by a margin that covers the envelope and the non-payload fields,
 *  so a reply built to this budget always arrives whole. */
export const INBOX_BATCH_BYTES = 12 * 1_048_576;

/** An item that cannot be delivered even on its own: its metadata, its size,
 *  and no payload. The reader gives up on it (acks it) instead of the queue
 *  stalling behind it forever. */
export type OversizedInboxItem = InboxSummary & { oversized: true; bytes: number };

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * The oldest items that fit in one reply.
 *
 * `limit` is a count; `maxBytes` is what actually bounds a frame. Two full-page
 * screenshots at 9MB each are two items and 18MB, and a count-only batch of
 * them was truncated by the service worker into something the reader could not
 * parse — which it read as "nothing pending", and every capture behind them
 * was stuck for good (findings F-59). So: oldest first, stop BEFORE the item
 * that would cross the budget, and always return at least one item so the
 * queue keeps moving. An item too big to fit alone comes back as an
 * OversizedInboxItem, so that the queue moves past it too.
 */
export function pickInboxBatch(
  items: InboxItem[],
  limit: number,
  maxBytes: number = INBOX_BATCH_BYTES,
): Array<InboxItem | OversizedInboxItem> {
  const out: Array<InboxItem | OversizedInboxItem> = [];
  let used = 0;
  for (const item of items) {
    if (out.length >= limit) break;
    const bytes = utf8Bytes(JSON.stringify(item));
    if (bytes > maxBytes) {
      // Cannot travel at all. Only as the first of a batch — mixing it into a
      // batch that already holds real items would be delivering it stripped
      // while its neighbours are whole, and the reader would ack all of them
      // as one; alone, its meaning is unambiguous.
      if (out.length === 0) out.push({ ...summarize(item), oversized: true, bytes });
      break;
    }
    if (used + bytes > maxBytes && out.length > 0) break;
    out.push(item);
    used += bytes;
  }
  return out;
}

// ── change listeners (in-process: the SW pokes the relay + paints the badge) ──

type Listener = (count: number) => void;
const listeners = new Set<Listener>();

export function onInboxChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function emit(): Promise<void> {
  const n = await inboxCount();
  for (const cb of listeners) {
    try {
      cb(n);
    } catch (e) {
      warn('inbox', 'listener failed', e);
    }
  }
}

// ── IndexedDB (same shape as site-scripts/store.ts; best-effort) ──

const DB_NAME = 'localmd-connect-inbox';
const STORE = 'items';

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      fn(store).then((result) => {
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error ?? new Error('IDB tx failed'));
        t.onabort = () => reject(t.error ?? new Error('IDB tx aborted'));
      }, reject);
    });
  } finally {
    db.close();
  }
}

export async function putInboxItem(item: InboxItem): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await withStore('readwrite', (store) => reqAsPromise(store.put(item)).then(() => undefined));
  } catch (e) {
    warn('inbox', 'putInboxItem failed', e);
    throw e;
  }
  await emit();
}

export async function listInbox(): Promise<InboxItem[]> {
  if (!hasIndexedDb()) return [];
  try {
    return await withStore('readonly', async (store) => {
      const all = (await reqAsPromise(store.getAll())) as InboxItem[] | undefined;
      return sortInbox(all ?? []);
    });
  } catch (e) {
    warn('inbox', 'listInbox failed', e);
    return [];
  }
}

export async function inboxCount(): Promise<number> {
  if (!hasIndexedDb()) return 0;
  try {
    return await withStore('readonly', (store) => reqAsPromise(store.count()));
  } catch {
    return 0;
  }
}

/** Remove the given ids. Returns how many existed. Unknown ids are not an
 * error — an ack that arrives twice must be harmless. */
export async function ackInbox(ids: string[]): Promise<number> {
  if (!hasIndexedDb() || !ids.length) return 0;
  let removed = 0;
  try {
    await withStore('readwrite', async (store) => {
      for (const id of ids) {
        const had = await reqAsPromise(store.getKey(id));
        if (had === undefined) continue;
        await reqAsPromise(store.delete(id));
        removed++;
      }
    });
  } catch (e) {
    warn('inbox', 'ackInbox failed', e);
  }
  if (removed) await emit();
  return removed;
}
