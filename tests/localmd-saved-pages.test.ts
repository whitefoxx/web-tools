/**
 * The index the popup's green tick reads, and the two tools that let the folder
 * put it right.
 *
 * It is written once, when a clip is acked, and then the extension has no way
 * to learn that the note was deleted — it cannot see the folder. So it claimed
 * a page was saved, named a path that was not there, and the user found out by
 * opening the popup on a page whose note they had removed (findings F-61).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let store: Record<string, unknown> = {};

vi.stubGlobal('chrome', {
  tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
  windows: { onRemoved: { addListener: () => {} } },
  runtime: { getManifest: () => ({ name: 'localmd Connect' }) },
  storage: {
    local: {
      get: async (keys: string | string[] | null) => {
        if (keys === null) return { ...store };
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        Object.assign(store, obj);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    },
  },
});

const { listKbEntries, forgetManyInKb, rememberInKb } = await import(
  '../src/localmd-connect/kb-index'
);
const { parseUrlList, parseMoved } = await import('../src/tools/generic/saved-pages');

describe('listKbEntries', () => {
  beforeEach(() => {
    store = {};
  });

  it('returns the index rows with their page URL, newest first', async () => {
    await rememberInKb('https://a.test/', { path: 'raw/articles/a.md', at: 100, title: 'A' });
    await rememberInKb('https://b.test/', { path: 'raw/articles/b.md', at: 200 });
    const rows = await listKbEntries();
    expect(rows.map((r) => r.url)).toEqual(['https://b.test/', 'https://a.test/']);
    expect(rows[1]).toEqual({
      url: 'https://a.test/',
      path: 'raw/articles/a.md',
      at: 100,
      title: 'A',
    });
  });

  it('reads ONLY its own keys out of a shared storage area', async () => {
    store['highlights:https://a.test/'] = [{ id: 'h1' }];
    store['siteScript:x'] = { js: '…' };
    store['pageTools'] = { enabled: true };
    await rememberInKb('https://a.test/', { path: 'raw/a.md', at: 1 });
    expect((await listKbEntries()).map((r) => r.path)).toEqual(['raw/a.md']);
  });

  it('skips a row that is not an entry rather than returning a broken one', async () => {
    store['kbIndex:https://junk.test/'] = { at: 1 }; // no path
    await rememberInKb('https://a.test/', { path: 'raw/a.md', at: 1 });
    expect(await listKbEntries()).toHaveLength(1);
  });
});

describe('forgetManyInKb', () => {
  beforeEach(() => {
    store = {};
  });

  it('drops the named pages and counts what was actually there', async () => {
    await rememberInKb('https://a.test/', { path: 'raw/a.md', at: 1 });
    await rememberInKb('https://b.test/', { path: 'raw/b.md', at: 2 });
    const n = await forgetManyInKb(['https://a.test/', 'https://never.test/']);
    expect(n).toBe(1);
    expect((await listKbEntries()).map((r) => r.url)).toEqual(['https://b.test/']);
  });

  it('keys a URL the same way the write did — fragment dropped', async () => {
    await rememberInKb('https://a.test/page#top', { path: 'raw/a.md', at: 1 });
    expect(await forgetManyInKb(['https://a.test/page'])).toBe(1);
    expect(await listKbEntries()).toEqual([]);
  });

  it('is a no-op on an empty list', async () => {
    await rememberInKb('https://a.test/', { path: 'raw/a.md', at: 1 });
    expect(await forgetManyInKb([])).toBe(0);
    expect(await listKbEntries()).toHaveLength(1);
  });
});

describe('sync_saved_pages arguments', () => {
  it('reads a URL list as JSON or as a plain list', () => {
    expect(parseUrlList('["https://a.test/","https://b.test/"]')).toEqual([
      'https://a.test/',
      'https://b.test/',
    ]);
    expect(parseUrlList('https://a.test/, https://b.test/')).toEqual([
      'https://a.test/',
      'https://b.test/',
    ]);
    expect(parseUrlList('')).toEqual([]);
  });

  it('reads {url, path} pairs and drops what it cannot use', () => {
    expect(parseMoved('[{"url":"https://a.test/","path":" raw/new/a.md "}]')).toEqual([
      { url: 'https://a.test/', path: 'raw/new/a.md' },
    ]);
    expect(parseMoved('[{"url":"https://a.test/"}]')).toEqual([]);
    expect(parseMoved('not json')).toEqual([]);
    expect(parseMoved(undefined)).toEqual([]);
  });
});
