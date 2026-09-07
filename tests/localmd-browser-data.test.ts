/**
 * The browser's own data behind OPTIONAL permissions (docs/localmd-connect.md
 * §14.4 Phase 2): the permission gate, and the paging that keeps a result
 * inside what the calling app can carry.
 *
 * The history cursor is the part worth pinning: history is a time series, so
 * paging it by offset would skip or repeat rows as new visits arrive while the
 * agent reads. It pages by an END TIME instead.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';

type Tool = {
  site: string;
  name: string;
  access?: string;
  func: (page: unknown, args: Record<string, unknown>) => Promise<unknown>;
};

let tools = new Map<string, Tool>();
const granted = new Set<string>();

/** The bookmark nodes the fake knows about: a folder, and bookmarks inside it. */
const NODES: Record<string, { id: string; title: string; url?: string; parentId?: string }> = {
  f1: { id: 'f1', title: 'Reading' },
  f2: { id: 'f2', title: 'Reading' },
  '1': { id: '1', title: 'A page', url: 'https://a.test/', parentId: 'f1' },
  '2': { id: '2', title: 'B page', url: 'https://b.test/', parentId: 'f1' },
  '3': { id: '3', title: 'C page', url: 'https://c.test/', parentId: 'f1' },
};
const removed: string[] = [];
const readingEntries: Array<{ title: string; url: string; hasBeenRead: boolean }> = [];
const readingCalls: Array<{ op: string; info: Record<string, unknown> }> = [];
/**
 * Rows modelled the way chrome.history.search ACTUALLY behaves: it selects URLs
 * that had a VISIT inside the window, and reports each one's GLOBAL
 * `lastVisitTime` — which may fall outside that window. Modelling it as "filter
 * on the row's own lastVisitTime" is what let a broken time cursor pass this
 * suite and then fail on the first real history (findings F-53).
 */
const historyRows: Array<{ title: string; url: string; visits: number[] }> = [];
let historyQueries: Array<Record<string, unknown>> = [];
/** A fixed "now" for the history fixtures — a minute ago, so every window the
 *  tool asks for contains them. */
const T0 = Date.now() - 60_000;

beforeAll(async () => {
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
    windows: { onRemoved: { addListener: () => {} } },
    runtime: { getManifest: () => ({ name: 'localmd Connect' }) },
    readingList: {
      query: async () => readingEntries.map((e) => ({ ...e })),
      addEntry: async (e: Record<string, unknown>) => {
        readingCalls.push({ op: 'add', info: e });
      },
      removeEntry: async (e: Record<string, unknown>) => {
        readingCalls.push({ op: 'remove', info: e });
      },
      updateEntry: async (e: Record<string, unknown>) => {
        readingCalls.push({ op: 'update', info: e });
      },
    },
    permissions: {
      contains: async ({ permissions }: { permissions: string[] }) =>
        permissions.every((p) => granted.has(p)),
    },
    bookmarks: {
      search: async (q: string) => [
        { id: '1', title: `hit ${q} a`, url: 'https://a.test/', parentId: 'f1', dateAdded: 300 },
        { id: '2', title: `hit ${q} b`, url: 'https://b.test/', parentId: 'f1', dateAdded: 200 },
        { id: '3', title: `hit ${q} c`, url: 'https://c.test/', parentId: 'f1', dateAdded: 100 },
        { id: 'f2', title: 'a folder, not a bookmark', parentId: 'f1' },
      ],
      get: async (id: string) => {
        // A real chrome.bookmarks.get REJECTS an unknown id and returns the
        // actual node otherwise — a fake that answers the same thing for every
        // id cannot tell "gone" from "a folder" from "a bookmark".
        const node = NODES[id];
        if (!node) throw new Error(`Can't find bookmark for id: ${id}`);
        return [node];
      },
      getChildren: async (id: string) =>
        id === 'f1'
          ? [
              { id: 'f9', title: 'Sub', parentId: 'f1' },
              { id: '1', title: 'A page', url: 'https://a.test/', parentId: 'f1', dateAdded: 5 },
            ]
          : [],
      getTree: async () => [
        { id: '0', title: '', children: [{ id: 'f1', title: 'Bookmarks bar' }] },
      ],
      remove: async (id: string) => {
        removed.push(id);
      },
    },
    history: {
      search: async (q: Record<string, unknown>) => {
        historyQueries.push(q);
        const end = typeof q.endTime === 'number' ? q.endTime : Infinity;
        const start = typeof q.startTime === 'number' ? q.startTime : -Infinity;
        return historyRows
          .filter((r) => r.visits.some((v) => v >= start && v <= end))
          .map((r) => ({
            title: r.title,
            url: r.url,
            visitCount: r.visits.length,
            lastVisitTime: Math.max(...r.visits), // global, not window-bounded
          }))
          .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
          .slice(0, Number(q.maxResults ?? 100));
      },
    },
  });
  await import('../src/tools/generic/browser-data');
  const { getRegistry } = await import('../src/runtime/registry.js');
  tools = new Map(
    (getRegistry() as Tool[]).filter((t) => t.site === 'generic').map((t) => [t.name, t]),
  );
});

const call = (name: string, args: Record<string, unknown> = {}): Promise<unknown> =>
  tools.get(name)!.func(null, args);

describe('the permission gate', () => {
  it('fails, with the popup switch named, instead of answering empty', async () => {
    granted.clear();
    for (const [name, perm] of [
      ['search_bookmarks', 'bookmarks'],
      ['list_bookmarks', 'bookmarks'],
      ['create_bookmark', 'bookmarks'],
      ['search_history', 'history'],
      ['list_reading_list', 'readingList'],
      ['add_to_reading_list', 'readingList'],
      ['list_recently_closed', 'sessions'],
    ] as const) {
      await expect(call(name, { query: 'x', title: 't', url: 'https://x.test/' })).rejects.toThrow(
        new RegExp(`permission_required: ${perm}`),
      );
    }
  });

  it('names a switch the user can actually find, and forbids retrying', async () => {
    granted.clear();
    await expect(call('search_history', {})).rejects.toThrow(/localmd Connect popup/);
    await expect(call('search_history', {})).rejects.toThrow(/Do not retry/);
  });
});

describe('bookmarks', () => {
  beforeAll(() => granted.add('bookmarks'));

  it('returns newest first, drops folders, and resolves the containing folder once', async () => {
    const r = (await call('search_bookmarks', { query: 'z' })) as {
      total: number;
      bookmarks: Array<{ id: string; folder?: string }>;
    };
    expect(r.total).toBe(3); // the folder row is not a bookmark
    expect(r.bookmarks.map((b) => b.id)).toEqual(['1', '2', '3']);
    expect(r.bookmarks[0].folder).toBe('Reading');
  });

  it('pages with a cursor and stops offering one at the end', async () => {
    const first = (await call('search_bookmarks', { query: 'z', limit: 2 })) as {
      bookmarks: unknown[];
      next_cursor?: string;
    };
    expect(first.bookmarks).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = (await call('search_bookmarks', {
      query: 'z',
      limit: 2,
      cursor: first.next_cursor,
    })) as { bookmarks: Array<{ id: string }>; next_cursor?: string };
    expect(second.bookmarks.map((b) => b.id)).toEqual(['3']);
    expect(second.next_cursor).toBeUndefined();
  });

  it('requires a query rather than dumping every bookmark', async () => {
    await expect(call('search_bookmarks', { query: '  ' })).rejects.toThrow(/query is required/);
  });

  it('lists a folder as folders + bookmarks, so a tree can be walked', async () => {
    const r = (await call('list_bookmarks', { folder_id: 'f1' })) as {
      folders: Array<{ id: string; children: number }>;
      bookmarks: Array<{ id: string }>;
    };
    expect(r.folders.map((f) => f.id)).toEqual(['f9']);
    expect(r.bookmarks.map((b) => b.id)).toEqual(['1']);
  });

  it('starts at the real roots, never the unnamed tree root', async () => {
    const r = (await call('list_bookmarks', {})) as { folders: Array<{ title: string }> };
    expect(r.folders.map((f) => f.title)).toEqual(['Bookmarks bar']);
  });
});

describe('undoing what the write tools did', () => {
  beforeAll(() => {
    granted.add('bookmarks');
    granted.add('readingList');
    readingEntries.length = 0;
    readingEntries.push({ title: 'Saved', url: 'https://r.test/one', hasBeenRead: false });
  });

  it('a deleted bookmark comes back with everything needed to re-create it', async () => {
    removed.length = 0;
    const r = (await call('delete_bookmark', { id: '1' })) as {
      deleted: { id: string; title: string; url: string };
      undo: string;
    };
    expect(removed).toEqual(['1']);
    // Captured BEFORE the delete — this is the entire undo path.
    expect(r.deleted.url).toBe('https://a.test/');
    expect(r.undo).toMatch(/create_bookmark/);
  });

  it('refuses to delete a folder, because that cannot be undone', async () => {
    removed.length = 0;
    await expect(call('delete_bookmark', { id: 'f2' })).rejects.toThrow(/is a folder/);
    expect(removed).toEqual([]);
  });

  it('says so when the bookmark is already gone', async () => {
    await expect(call('delete_bookmark', { id: 'nope' })).rejects.toThrow(/no bookmark with id/);
  });

  it('removing a reading-list entry returns its title, which removeEntry does not', async () => {
    readingCalls.length = 0;
    const r = (await call('remove_from_reading_list', { url: 'https://r.test/one' })) as {
      removed: { title: string };
    };
    expect(readingCalls).toEqual([{ op: 'remove', info: { url: 'https://r.test/one' } }]);
    expect(r.removed.title).toBe('Saved');
  });

  it('marks read without removing, and reports what it was before', async () => {
    readingCalls.length = 0;
    const r = (await call('set_reading_list_read', { url: 'https://r.test/one' })) as {
      read: boolean;
      was: boolean;
    };
    expect(readingCalls).toEqual([
      { op: 'update', info: { url: 'https://r.test/one', hasBeenRead: true } },
    ]);
    expect(r.read).toBe(true);
    expect(r.was).toBe(false);
  });

  it('will not touch a reading-list URL that is not there', async () => {
    await expect(call('remove_from_reading_list', { url: 'https://r.test/gone' })).rejects.toThrow(
      /no reading-list entry/,
    );
  });
});

describe('history paging', () => {
  beforeAll(() => {
    granted.add('history');
    historyRows.length = 0;
    // Real epoch milliseconds: the tool bounds its window against Date.now(),
    // so toy timestamps would fall outside every window it ever asks for.
    for (let i = 0; i < 5; i++) {
      historyRows.push({ title: `page ${i}`, url: `https://h.test/${i}`, visits: [T0 - i * 1000] });
    }
    // The row that broke the time cursor: seen recently AND long ago, so it
    // matches both a narrow and a wide window while always reporting its recent
    // last visit.
    historyRows.push({
      title: 'recurring',
      url: 'https://h.test/recurring',
      visits: [T0 - 500, T0 - 200 * 86_400_000],
    });
  });

  /** Every page of a walk, following next_cursor to the end. */
  async function walk(limit: number, days = 3650): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const r = (await call('search_history', { limit, days, ...(cursor ? { cursor } : {}) })) as {
        history: Array<{ url: string }>;
        next_cursor?: string;
      };
      pages.push(r.history.map((h) => h.url));
      if (!r.next_cursor) return pages;
      cursor = r.next_cursor;
    }
    throw new Error('paging did not terminate');
  }

  it('never serves the same row on two pages', async () => {
    // The regression: a URL visited both inside and long before the window used
    // to come back on consecutive pages, because the row's reported
    // lastVisitTime is its GLOBAL one and the cursor was a timestamp.
    const seen = (await walk(2)).flat();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain('https://h.test/recurring');
  });

  it('covers everything exactly once, whatever the page size', async () => {
    const byTwo = (await walk(2)).flat();
    const byFive = (await walk(5)).flat();
    const all = (await walk(100)).flat();
    expect(byTwo).toEqual(all);
    expect(byFive).toEqual(all);
    expect(all).toHaveLength(historyRows.length);
  });

  it('asks for one more than it returns, to know whether a page follows', async () => {
    historyQueries = [];
    await call('search_history', { limit: 2, days: 3650 });
    expect(historyQueries[0].maxResults).toBe(3);
    historyQueries = [];
    await call('search_history', { limit: 2, days: 3650, cursor: 'o2' });
    expect(historyQueries[0].maxResults).toBe(5); // offset + limit + 1
  });

  it('stops offering a cursor once the window is exhausted', async () => {
    const r = (await call('search_history', { limit: 50, days: 3650 })) as { next_cursor?: string };
    expect(r.next_cursor).toBeUndefined();
  });

  it('refuses to page deeper than it can afford to', async () => {
    await expect(call('search_history', { limit: 100, cursor: 'o1000' })).rejects.toThrow(
      /narrow it with/,
    );
  });

  it('bounds the window it looks back over', async () => {
    historyQueries = [];
    await call('search_history', { days: 99999 });
    const span = Date.now() - Number(historyQueries[0].startTime);
    expect(span / 86_400_000).toBeLessThanOrEqual(3650);
  });
});

describe('the manifest and the tools agree on what is optional', () => {
  it('every gated permission is declared optional, and none is required', async () => {
    const { BROWSER_DATA_PERMISSIONS } = await import('../src/tools/generic/browser-data');
    const manifest = JSON.parse(
      readFileSync(new URL('../manifest.localmd.json', import.meta.url), 'utf8'),
    ) as { permissions: string[]; optional_permissions: string[] };
    expect(Object.keys(BROWSER_DATA_PERMISSIONS).sort()).toEqual(
      [...manifest.optional_permissions].sort(),
    );
    for (const p of manifest.optional_permissions) expect(manifest.permissions).not.toContain(p);
  });
});
