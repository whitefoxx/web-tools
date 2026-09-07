import { cli } from '../../runtime/registry.js';
import { assertHttpUrl } from './_helpers';

/**
 * The browser's OWN data — bookmarks, history, the reading list, recently
 * closed tabs. localmd Connect only (registered from `_localmd.ts`).
 *
 * This is the second layer of "the browser as a context container"
 * (docs/localmd-connect.md §14.1): the first is the sites the user can reach,
 * this is the record of what they already chose to keep or already read. A
 * knowledge base that can see it stops needing to be told "that article I
 * bookmarked last month".
 *
 * EVERY permission here is OPTIONAL, and that is the whole reason this can
 * exist at all. The same five tools shipped in the full extension in June 2026
 * and were deleted a month later (`e31fde0`): asking for bookmarks, history and
 * the reading list UP FRONT turns the install prompt into "read and change your
 * browsing history", which is not a trade a new user should be asked to make
 * before seeing the product. `optional_permissions` moves that decision to the
 * moment it buys something, and the extension popup is where the user makes it
 * — `chrome.permissions.request` needs a user gesture, so a page cannot ask and
 * neither can the service worker.
 *
 * A tool whose permission is not granted FAILS, with a message naming the
 * switch. It does not return an empty list: "no bookmarks match" and "I am not
 * allowed to look" are different answers, and a tool that conflates them
 * teaches the agent to report the wrong one (findings F-47).
 *
 * Everything here is paginated. The calling app clips a tool result well below
 * the size a full history search reaches, so a tool that answers with
 * everything is a tool that answers with a truncated middle.
 */

/** Optional permissions this file's tools sit behind, with the popup wording
 * the failure message points at. */
export const BROWSER_DATA_PERMISSIONS = {
  bookmarks: 'Bookmarks',
  history: 'Browsing history',
  readingList: 'Reading list',
  sessions: 'Recently closed tabs',
} as const;

export type BrowserDataPermission = keyof typeof BROWSER_DATA_PERMISSIONS;

/** Stable prefix so a caller can tell "not allowed yet" from a real failure
 * without parsing prose. */
export const PERMISSION_REQUIRED = 'permission_required';

export function permissionMessage(permission: BrowserDataPermission): string {
  return (
    `${PERMISSION_REQUIRED}: ${permission}. This tool reads the browser's ${BROWSER_DATA_PERMISSIONS[permission].toLowerCase()}, ` +
    'which the user has not granted. It cannot be granted from a page or by an agent: ask the user to open the ' +
    `localmd Connect popup (the toolbar icon), expand "Browser data" and switch on "${BROWSER_DATA_PERMISSIONS[permission]}". ` +
    'Do not retry until they say they have.'
  );
}

async function requirePermission(permission: BrowserDataPermission): Promise<void> {
  let granted: boolean;
  try {
    granted = await chrome.permissions.contains({ permissions: [permission] });
  } catch {
    // An API that cannot even be asked is an API we do not have.
    granted = false;
  }
  if (!granted) throw new Error(permissionMessage(permission));
}

/** Clamp a caller's `limit` into something a tool result can actually carry. */
export function pageLimit(v: unknown, fallback = 25, cap = 100): number {
  const n = Number(v ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(cap, Math.trunc(n)));
}

/** Offset cursors, as an opaque-looking string so callers pass them back
 * verbatim instead of doing arithmetic on them. */
export function parseOffset(v: unknown): number {
  const n = Number(String(v ?? '0').replace(/^o/, ''));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function offsetCursor(next: number): string {
  return `o${next}`;
}

/** How deep `search_history` will page. Each page re-runs the query asking for
 *  `offset + limit + 1` rows, so unbounded paging would end up asking Chrome for
 *  the entire history in order to serve the tail of it. */
export const MAX_HISTORY_DEPTH = 1000;

/* ───────── bookmarks ───────── */

interface BookmarkRow {
  id: string;
  title: string;
  url: string;
  folder?: string;
  added?: number;
}

/** Parent-folder titles, looked up once per folder rather than once per hit. */
async function folderTitles(ids: Array<string | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(ids.filter((v): v is string => !!v))) {
    try {
      const [node] = await chrome.bookmarks.get(id);
      if (node?.title) out.set(id, node.title);
    } catch {
      /* a parent that vanished mid-listing is not worth failing over */
    }
  }
  return out;
}

cli({
  site: 'generic',
  name: 'search_bookmarks',
  access: 'read',
  local: true,
  description:
    'Search the user\'s browser bookmarks by keyword (matches title and URL) and return id / title / url / containing folder / date added, newest first. Use it whenever a request points at something the user already saved — "that article I bookmarked", "the docs I keep going back to" — then read a hit with fetch_url or clip it with clip_page. Paginated: pass `cursor` from the previous result to continue. Needs the optional "Bookmarks" permission, which the user grants in the extension popup; without it this fails and says so rather than answering empty.',
  args: [
    {
      name: 'query',
      type: 'string',
      required: true,
      help: 'Keyword; matches the title or the URL',
    },
    { name: 'limit', type: 'int', help: 'Max rows (default 25, cap 100)' },
    {
      name: 'cursor',
      type: 'string',
      help: '`next_cursor` from a previous call, to get the next page',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await requirePermission('bookmarks');
    const query = String(kwargs.query ?? '').trim();
    if (!query) throw new Error('query is required (a keyword matching the title or URL)');
    const limit = pageLimit(kwargs.limit);
    const offset = parseOffset(kwargs.cursor);
    const hits = (await chrome.bookmarks.search(query)).filter((b) => !!b.url);
    hits.sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0));
    const page = hits.slice(offset, offset + limit);
    const titles = await folderTitles(page.map((b) => b.parentId));
    const rows: BookmarkRow[] = page.map((b) => ({
      id: b.id,
      title: b.title,
      url: b.url!,
      ...(b.parentId && titles.get(b.parentId) ? { folder: titles.get(b.parentId) } : {}),
      ...(b.dateAdded ? { added: b.dateAdded } : {}),
    }));
    const next = offset + page.length;
    return {
      total: hits.length,
      returned: rows.length,
      bookmarks: rows,
      ...(next < hits.length ? { next_cursor: offsetCursor(next) } : {}),
    };
  },
});

cli({
  site: 'generic',
  name: 'list_bookmarks',
  access: 'read',
  local: true,
  description:
    'Browse the bookmark TREE one folder at a time: omit `folder_id` for the top level, then pass the id of a folder row to descend into it. Returns folders (with how many children each holds) and bookmarks separately, so "import my \'AI papers\' folder" is find-the-folder then list-it, rather than a keyword search that also catches everything else. Paginated with `cursor`. Needs the optional "Bookmarks" permission (granted in the extension popup).',
  args: [
    {
      name: 'folder_id',
      type: 'string',
      help: 'Folder to list (from a previous row). Omit for the top level',
    },
    { name: 'limit', type: 'int', help: 'Max rows (default 50, cap 200)' },
    { name: 'cursor', type: 'string', help: '`next_cursor` from a previous call' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await requirePermission('bookmarks');
    const folderId =
      typeof kwargs.folder_id === 'string' && kwargs.folder_id.trim()
        ? kwargs.folder_id.trim()
        : null;
    const limit = pageLimit(kwargs.limit, 50, 200);
    const offset = parseOffset(kwargs.cursor);
    let children: chrome.bookmarks.BookmarkTreeNode[];
    if (folderId) {
      children = await chrome.bookmarks.getChildren(folderId);
    } else {
      // The roots ("Bookmarks bar", "Other bookmarks", …) are the children of
      // the unnamed tree root, which is never itself worth showing.
      const [root] = await chrome.bookmarks.getTree();
      children = root?.children ?? [];
    }
    const page = children.slice(offset, offset + limit);
    const folders: Array<{ id: string; title: string; children: number }> = [];
    const bookmarks: BookmarkRow[] = [];
    for (const node of page) {
      if (node.url) {
        bookmarks.push({
          id: node.id,
          title: node.title,
          url: node.url,
          ...(node.dateAdded ? { added: node.dateAdded } : {}),
        });
      } else {
        let count = 0;
        try {
          count = (await chrome.bookmarks.getChildren(node.id)).length;
        } catch {
          /* unreadable folder — report it with an unknown size rather than hide it */
        }
        folders.push({ id: node.id, title: node.title, children: count });
      }
    }
    const next = offset + page.length;
    return {
      folder_id: folderId,
      total: children.length,
      returned: page.length,
      folders,
      bookmarks,
      ...(next < children.length ? { next_cursor: offsetCursor(next) } : {}),
    };
  },
});

cli({
  site: 'generic',
  name: 'create_bookmark',
  access: 'write',
  local: true,
  description:
    'Add a bookmark (title + http/https URL, optionally inside a folder from list_bookmarks). Changes the user\'s own bookmark bar, so get their confirmation first. Needs the optional "Bookmarks" permission (granted in the extension popup).',
  args: [
    { name: 'title', type: 'string', required: true, help: 'Bookmark title' },
    { name: 'url', type: 'string', required: true, help: 'http/https URL' },
    {
      name: 'parent_id',
      type: 'string',
      help: 'Folder id from list_bookmarks; omitted puts it in the default folder',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await requirePermission('bookmarks');
    const url = assertHttpUrl(kwargs.url);
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new Error('title is required');
    const parentId =
      typeof kwargs.parent_id === 'string' && kwargs.parent_id.trim()
        ? kwargs.parent_id.trim()
        : undefined;
    const node = await chrome.bookmarks.create({ title, url, ...(parentId ? { parentId } : {}) });
    return { id: node.id, title: node.title, url: node.url, parent_id: node.parentId };
  },
});

cli({
  site: 'generic',
  name: 'delete_bookmark',
  access: 'write',
  local: true,
  description:
    'Delete ONE bookmark by id (from search_bookmarks or list_bookmarks). Removes it from the user\'s own bookmarks, so get their confirmation first. The result echoes the title and URL that were deleted, which is what makes it undoable: create_bookmark with those values puts it back. Refuses a folder id — deleting a folder takes everything inside it with no way back, and that is not a thing to do on an agent\'s judgement. Needs the optional "Bookmarks" permission (granted in the extension popup).',
  args: [
    {
      name: 'id',
      type: 'string',
      required: true,
      help: 'Bookmark id from search_bookmarks / list_bookmarks',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await requirePermission('bookmarks');
    const id = String(kwargs.id ?? '').trim();
    if (!id) throw new Error('id is required (from search_bookmarks or list_bookmarks)');
    let node: chrome.bookmarks.BookmarkTreeNode | undefined;
    try {
      [node] = await chrome.bookmarks.get(id);
    } catch {
      throw new Error(`no bookmark with id ${id} (it may already be gone)`);
    }
    if (!node?.url) {
      throw new Error(
        `${id} is a folder ("${node?.title ?? '?'}"), not a bookmark. Deleting a folder removes everything inside it and cannot be undone, so this tool will not do it — ask the user to delete it in Chrome if that is really what they want.`,
      );
    }
    // Captured BEFORE the delete: this is the whole undo path.
    const deleted = { id: node.id, title: node.title, url: node.url, parent_id: node.parentId };
    await chrome.bookmarks.remove(id);
    return { deleted, undo: 'create_bookmark with the title, url and parent_id above' };
  },
});

/* ───────── history ───────── */

cli({
  site: 'generic',
  name: 'search_history',
  access: 'read',
  local: true,
  description:
    'Search the pages the user has actually VISITED, newest first: title, URL, visit count and when they last saw it. This is what answers "what was that page I read last week about X", "what have I been reading on this topic" — and it reaches things no bookmark or note ever captured. `days` bounds how far back to look (default 30). Paginated: pass `cursor` from the previous result for the next page, up to 1000 rows deep — past that, narrow with `query` or a smaller `days` instead. Needs the optional "Browsing history" permission (granted in the extension popup); without it this fails and says so.',
  args: [
    {
      name: 'query',
      type: 'string',
      help: 'Keyword; matches title or URL. Omit to list everything in the window',
    },
    { name: 'days', type: 'int', help: 'How far back to search (default 30, cap 3650)' },
    { name: 'limit', type: 'int', help: 'Max rows (default 25, cap 100)' },
    {
      name: 'cursor',
      type: 'string',
      help: '`next_cursor` from a previous call',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await requirePermission('history');
    const text = String(kwargs.query ?? '');
    const days = Math.max(1, Math.min(3650, Number(kwargs.days ?? 30) || 30));
    const limit = pageLimit(kwargs.limit);
    const startTime = Date.now() - days * 86_400_000;
    const offset = parseOffset(kwargs.cursor);
    if (offset + limit > MAX_HISTORY_DEPTH) {
      throw new Error(
        `search_history pages ${MAX_HISTORY_DEPTH} rows deep at most — narrow it with \`query\` or a smaller \`days\` rather than paging further.`,
      );
    }
    // Offset paging over ONE bounded query, NOT a time cursor. A time cursor is
    // the obvious design for a time series and it is wrong here:
    // chrome.history.search filters by VISIT time but reports each item's
    // GLOBAL `lastVisitTime`, so a URL visited both inside and before the window
    // comes back on two consecutive pages carrying the same timestamp. Caught on
    // real history, where consecutive five-row pages overlapped by one row
    // (findings F-53). Asking for one row more than we return is how we know
    // whether another page follows.
    const items = await chrome.history.search({
      text,
      startTime,
      maxResults: offset + limit + 1,
    });
    items.sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0));
    const page = items.slice(offset, offset + limit);
    return {
      days,
      returned: page.length,
      history: page.map((h) => ({
        title: h.title ?? '',
        url: h.url ?? '',
        visits: h.visitCount ?? 0,
        last_visit: h.lastVisitTime ?? 0,
      })),
      ...(items.length > offset + limit ? { next_cursor: offsetCursor(offset + limit) } : {}),
    };
  },
});

/* ───────── reading list ───────── */

// chrome.readingList is absent from @types/chrome; narrow it to what is used.
interface ReadingListEntry {
  title?: string;
  url?: string;
  hasBeenRead?: boolean;
  creationTime?: number;
  lastUpdateTime?: number;
}
interface ReadingListApi {
  query(info: Record<string, unknown>): Promise<ReadingListEntry[]>;
  addEntry(entry: { title: string; url: string; hasBeenRead: boolean }): Promise<void>;
  removeEntry(info: { url: string }): Promise<void>;
  updateEntry(info: { url: string; title?: string; hasBeenRead?: boolean }): Promise<void>;
}
function readingList(): ReadingListApi {
  const api = (chrome as unknown as { readingList?: ReadingListApi }).readingList;
  if (!api) throw new Error('This Chrome build has no reading list (needs Chrome 120+)');
  return api;
}

cli({
  site: 'generic',
  name: 'list_reading_list',
  access: 'read',
  local: true,
  description:
    'The user\'s Chrome reading list — pages they deliberately put aside to read later, which makes it a much stronger signal of intent than history. Returns title / url / whether it has been read / when it was added, newest first, optionally filtered by keyword. Needs the optional "Reading list" permission (granted in the extension popup).',
  args: [
    { name: 'query', type: 'string', help: 'Optional keyword; matches title or URL' },
    { name: 'unread_only', type: 'bool', help: 'true = only entries not yet marked read' },
    { name: 'limit', type: 'int', help: 'Max rows (default 50, cap 200)' },
    { name: 'cursor', type: 'string', help: '`next_cursor` from a previous call' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await requirePermission('readingList');
    const q = String(kwargs.query ?? '')
      .trim()
      .toLowerCase();
    const limit = pageLimit(kwargs.limit, 50, 200);
    const offset = parseOffset(kwargs.cursor);
    const all = await readingList().query({});
    const matched = all.filter((e) => {
      if (kwargs.unread_only && e.hasBeenRead) return false;
      if (!q) return true;
      return (e.title ?? '').toLowerCase().includes(q) || (e.url ?? '').toLowerCase().includes(q);
    });
    matched.sort((a, b) => (b.creationTime ?? 0) - (a.creationTime ?? 0));
    const page = matched.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      total: matched.length,
      returned: page.length,
      items: page.map((e) => ({
        title: e.title ?? '',
        url: e.url ?? '',
        read: !!e.hasBeenRead,
        added: e.creationTime ?? 0,
      })),
      ...(next < matched.length ? { next_cursor: offsetCursor(next) } : {}),
    };
  },
});

cli({
  site: 'generic',
  name: 'add_to_reading_list',
  access: 'write',
  local: true,
  description:
    'Put a page on the user\'s Chrome reading list to read later. Changes their browser, so get their confirmation first. Needs the optional "Reading list" permission (granted in the extension popup).',
  args: [
    { name: 'title', type: 'string', required: true, help: 'Entry title' },
    { name: 'url', type: 'string', required: true, help: 'http/https URL' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await requirePermission('readingList');
    const url = assertHttpUrl(kwargs.url);
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new Error('title is required');
    await readingList().addEntry({ title, url, hasBeenRead: false });
    return { added: true, title, url };
  },
});

cli({
  site: 'generic',
  name: 'remove_from_reading_list',
  access: 'write',
  local: true,
  description:
    'Take a page off the user\'s Chrome reading list, by URL (exactly as list_reading_list returns it). Changes their browser, so get their confirmation first — though this one is cheap to undo with add_to_reading_list. Prefer set_reading_list_read when the intent is "I have finished this": removing loses the entry, marking it read keeps the record. Needs the optional "Reading list" permission (granted in the extension popup).',
  args: [
    {
      name: 'url',
      type: 'string',
      required: true,
      help: "The entry's URL, as list_reading_list returns it",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await requirePermission('readingList');
    const url = assertHttpUrl(kwargs.url);
    // Look it up first so the result can carry the title — the undo needs it,
    // and removeEntry gives nothing back.
    const entry = (await readingList().query({})).find((e) => e.url === url);
    if (!entry)
      throw new Error(`no reading-list entry for ${url} (already removed, or a different URL)`);
    await readingList().removeEntry({ url });
    return {
      removed: { title: entry.title ?? '', url },
      undo: 'add_to_reading_list with the title and url above',
    };
  },
});

cli({
  site: 'generic',
  name: 'set_reading_list_read',
  access: 'write',
  local: true,
  description:
    'Mark a reading-list entry read (or unread) without removing it — the natural close of a loop that starts with clip_page: the page is now in the knowledge base, so it is no longer waiting to be read. Takes the URL exactly as list_reading_list returns it. Needs the optional "Reading list" permission (granted in the extension popup).',
  args: [
    {
      name: 'url',
      type: 'string',
      required: true,
      help: "The entry's URL, as list_reading_list returns it",
    },
    {
      name: 'read',
      type: 'bool',
      default: true,
      help: 'true = mark read (default); false = mark unread',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await requirePermission('readingList');
    const url = assertHttpUrl(kwargs.url);
    const read = kwargs.read === undefined ? true : !!kwargs.read;
    const entry = (await readingList().query({})).find((e) => e.url === url);
    if (!entry) throw new Error(`no reading-list entry for ${url} (removed, or a different URL)`);
    await readingList().updateEntry({ url, hasBeenRead: read });
    return { url, title: entry.title ?? '', read, was: !!entry.hasBeenRead };
  },
});

/* ───────── recently closed ───────── */

cli({
  site: 'generic',
  name: 'list_recently_closed',
  access: 'read',
  local: true,
  description:
    'Tabs and windows the user closed recently, newest first — the reading session that just ended and is otherwise unrecoverable. Pairs with list_tabs ("everything I have open plus what I just closed") for turning a reading session into notes. Rows carry the url, so bringing one back is open_url. Needs the optional "Recently closed tabs" permission (granted in the extension popup).',
  args: [
    {
      name: 'limit',
      type: 'int',
      help: 'Max entries (default 25, cap 25 — the browser keeps few)',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await requirePermission('sessions');
    const limit = pageLimit(kwargs.limit, 25, 25);
    const entries = await chrome.sessions.getRecentlyClosed({ maxResults: limit });
    const rows: Array<{
      kind: 'tab' | 'window';
      title: string;
      url: string;
      closed_at: number;
      tabs?: number;
    }> = [];
    for (const e of entries) {
      if (e.tab) {
        rows.push({
          kind: 'tab',
          title: e.tab.title ?? '',
          url: e.tab.url ?? '',
          closed_at: (e.lastModified ?? 0) * 1000,
        });
      } else if (e.window) {
        const tabs = e.window.tabs ?? [];
        rows.push({
          kind: 'window',
          title: `${tabs.length} tab(s)`,
          url: tabs[0]?.url ?? '',
          closed_at: (e.lastModified ?? 0) * 1000,
          tabs: tabs.length,
        });
      }
    }
    return { returned: rows.length, entries: rows };
  },
});
