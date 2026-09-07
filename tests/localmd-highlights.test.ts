/**
 * The in-page highlighter's data layer (docs/localmd-connect.md §14.4 Phase 3):
 * whether the script runs on a page at all, the colour/note fields, and the
 * read/delete tools over them. The UI itself is a real-browser test — jsdom has
 * no selection geometry and no shadow-root rendering worth asserting on.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

type Tool = {
  site: string;
  name: string;
  func: (page: unknown, args: Record<string, unknown>) => Promise<unknown>;
};

/** A chrome.storage.local stand-in with the getKeys() the store prefers. */
const store: Record<string, unknown> = {};
let tools = new Map<string, Tool>();

beforeAll(async () => {
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
    windows: { onRemoved: { addListener: () => {} } },
    runtime: { getManifest: () => ({ name: 'localmd Connect' }) },
    storage: {
      onChanged: { addListener: () => {} },
      local: {
        get: async (k: string | string[] | null) => {
          if (k === null) return { ...store };
          const keys = Array.isArray(k) ? k : [k];
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in store) out[key] = store[key];
          return out;
        },
        set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
        remove: async (k: string) => {
          delete store[k];
        },
        getKeys: async () => Object.keys(store),
      },
    },
  });
  await import('../src/tools/generic/highlights');
  const { getRegistry } = await import('../src/runtime/registry.js');
  tools = new Map(
    (getRegistry() as Tool[]).filter((t) => t.site === 'generic').map((t) => [t.name, t]),
  );
});

const call = (name: string, args: Record<string, unknown> = {}): Promise<unknown> =>
  tools.get(name)!.func(null, args);

const KEY = 'selHl:https://a.test/post';

function seed(): void {
  for (const k of Object.keys(store)) delete store[k];
  store[KEY] = [
    {
      id: 'hl_1',
      exact: 'a marked passage',
      prefix: 'before ',
      suffix: ' after',
      ts: 1_700_000_000_000,
      title: 'A Post',
      color: 'yellow',
      note: 'why this matters',
    },
    {
      id: 'hl_2',
      exact: 'another one',
      prefix: '',
      suffix: '',
      ts: 1_700_000_001_000,
      title: 'A Post',
      // no colour and no note: what the full shell's toolbar writes, and what
      // this build must keep reading.
    },
  ];
  store['selHl:https://b.test/other'] = [
    {
      id: 'hl_3',
      exact: 'elsewhere',
      prefix: '',
      suffix: '',
      ts: 1_700_000_002_000,
      title: 'Other',
    },
  ];
}

describe('runsOn', () => {
  it('is on by default, off when disabled, off on a blacklisted host and its subdomains', async () => {
    const { runsOn, DEFAULT_PAGE_TOOLS } = await import('../src/localmd-connect/page-settings');
    const on = DEFAULT_PAGE_TOOLS;
    expect(runsOn('https://x.test/a', on)).toBe(true);
    expect(runsOn('https://x.test/a', { ...on, enabled: false })).toBe(false);
    const blocked = { ...on, blacklist: ['x.test'] };
    expect(runsOn('https://x.test/a', blocked)).toBe(false);
    expect(runsOn('https://sub.x.test/a', blocked)).toBe(false);
    expect(runsOn('https://www.x.test/a', blocked)).toBe(false);
    expect(runsOn('https://notx.test/a', blocked)).toBe(true);
  });

  it('never runs outside http(s) — a chrome:// page has nothing to highlight', async () => {
    const { runsOn, DEFAULT_PAGE_TOOLS } = await import('../src/localmd-connect/page-settings');
    expect(runsOn('chrome://extensions', DEFAULT_PAGE_TOOLS)).toBe(false);
  });

  it('stays out of localmd by default — as a list entry, not a rule', async () => {
    const { runsOn, DEFAULT_PAGE_TOOLS, DEFAULT_BLACKLIST } = await import(
      '../src/localmd-connect/page-settings'
    );
    // The app is a text editor: a selection there is an edit, and a toolbar on
    // every selection is in the way of the thing this extension serves. Shipped
    // as data rather than as a hard-coded branch, so it is visible in the list
    // and the user can disagree.
    expect(DEFAULT_BLACKLIST).toEqual(['localmd.app']);
    expect(runsOn('https://localmd.app/', DEFAULT_PAGE_TOOLS)).toBe(false);
    expect(runsOn('https://app.localmd.app/kb', DEFAULT_PAGE_TOOLS)).toBe(false);
    // …and removing it means what it says.
    expect(runsOn('https://localmd.app/', { ...DEFAULT_PAGE_TOOLS, blacklist: [] })).toBe(true);
  });

  it('does not mistake a lookalike hostname for the app', async () => {
    const { runsOn, DEFAULT_PAGE_TOOLS } = await import('../src/localmd-connect/page-settings');
    expect(runsOn('https://notlocalmd.app/', DEFAULT_PAGE_TOOLS)).toBe(true);
    expect(runsOn('https://localmd.app.evil.test/', DEFAULT_PAGE_TOOLS)).toBe(true);
    expect(runsOn('http://localhost:8123/highlight.html', DEFAULT_PAGE_TOOLS)).toBe(true);
    expect(runsOn('file:///tmp/a.html', DEFAULT_PAGE_TOOLS)).toBe(false);
    expect(runsOn('not a url', DEFAULT_PAGE_TOOLS)).toBe(false);
  });
});

describe('mergePageTools', () => {
  it('defaults to on, and survives anything in storage', async () => {
    const { mergePageTools } = await import('../src/localmd-connect/page-settings');
    expect(mergePageTools(undefined).enabled).toBe(true);
    expect(mergePageTools({ enabled: false }).enabled).toBe(false);
    // No list stored = the shipped default; a list that IS stored is the
    // user's answer, even when they emptied it.
    expect(mergePageTools({ blacklist: 'nonsense' }).blacklist).toEqual(['localmd.app']);
    expect(mergePageTools(undefined).blacklist).toEqual(['localmd.app']);
    expect(mergePageTools({ blacklist: [] }).blacklist).toEqual([]);
    expect(mergePageTools({ blacklist: ['https://WWW.X.test/a', '  '] }).blacklist).toEqual([
      'x.test',
    ]);
    expect(mergePageTools({ defaultColor: 'octarine' }).defaultColor).toBe('yellow');
  });

  it('ships two worked prompts and an escape hatch, and survives nonsense', async () => {
    const { mergePageTools, mergePrompts, DEFAULT_PROMPTS } =
      await import('../src/localmd-connect/page-settings');
    // Two worked examples and an escape hatch. The examples demonstrate both
    // variables; the third has NO prompt, which is what makes it the general
    // one — the page asks for the instruction when it is used.
    expect(DEFAULT_PROMPTS.map((a) => a.id)).toEqual(['translate', 'explain', 'ask']);
    const saved = DEFAULT_PROMPTS.filter((a) => a.prompt);
    expect(saved).toHaveLength(2);
    expect(saved.every((a) => a.prompt.includes('${content}'))).toBe(true);
    expect(saved.every((a) => a.prompt.includes('${lang}'))).toBe(true);
    expect(mergePageTools(undefined).prompts).toEqual(DEFAULT_PROMPTS);

    const mine = { id: 'x', label: 'Rewrite', prompt: 'rewrite it', on: false };
    expect(mergePageTools({ prompts: [mine] }).prompts).toEqual([mine]);
    // "I switched them all off and deleted the rest" has to survive a reload,
    // so an EMPTY list is an answer where a MISSING one is not.
    expect(mergePageTools({ prompts: [] }).prompts).toEqual([]);
    expect(mergePageTools({ prompts: 'nonsense' }).prompts).toEqual(DEFAULT_PROMPTS);
    // A NAME is the whole requirement: an entry with no prompt is the
    // open-ended kind, an entry with no name is nothing.
    expect(mergePrompts([{ prompt: 'no name' }, null])).toEqual([]);
    expect(mergePrompts([{ label: 'Ask…' }])).toEqual([
      { id: 'p_1', label: 'Ask…', prompt: '', on: true },
    ]);
    expect(mergePrompts([{ label: 'a', prompt: 'b' }])[0]).toMatchObject({ on: true });
    expect(mergePrompts(Array.from({ length: 40 }, () => mine)).length).toBe(20);
  });

  it('has a toolbar switch of its own, and a language that defaults to the browser', async () => {
    const { mergePageTools, defaultLanguage, resolveLang } =
      await import('../src/localmd-connect/page-settings');
    // The toolbar is separable from the feature: highlights still come back
    // when the bar is off.
    expect(mergePageTools(undefined).bar).toBe(true);
    expect(mergePageTools({ bar: false }).bar).toBe(false);
    expect(mergePageTools({ lang: '  日本語  ' }).lang).toBe('日本語');
    expect(mergePageTools({ lang: 42 }).lang).toBe('');
    expect(defaultLanguage('zh-CN')).toBe('简体中文');
    expect(defaultLanguage('zh-Hant-TW')).toBe('繁體中文');
    expect(defaultLanguage('ja')).toBe('日本語');
    expect(defaultLanguage(undefined)).toBe('English');
    // What was chosen wins; otherwise the browser answers.
    expect(resolveLang('Klingon', 'ja')).toBe('Klingon');
    expect(resolveLang('', 'de')).toBe('Deutsch');
  });
});

describe('get_highlights', () => {
  beforeEach(seed);

  it("reads one page's highlights, with colour, note and the anchor to find them again", async () => {
    const r = (await call('get_highlights', { url: 'https://a.test/post#section' })) as {
      count: number;
      highlights: Array<Record<string, unknown>>;
    };
    // The #hash is not part of a page's identity for highlights.
    expect(r.count).toBe(2);
    const first = r.highlights[0];
    expect(first.text).toBe('a marked passage');
    expect(first.color).toBe('yellow');
    expect(first.note).toBe('why this matters');
    expect(first.anchor).toEqual({
      exact: 'a marked passage',
      prefix: 'before ',
      suffix: ' after',
    });
  });

  it('omits colour and note rather than inventing them', async () => {
    const r = (await call('get_highlights', { url: 'https://a.test/post' })) as {
      highlights: Array<Record<string, unknown>>;
    };
    expect('color' in r.highlights[1]).toBe(false);
    expect('note' in r.highlights[1]).toBe(false);
  });

  it('searches across pages on text, note, title and URL', async () => {
    const byText = (await call('get_highlights', { query: 'elsewhere' })) as { total: number };
    expect(byText.total).toBe(1);
    const byNote = (await call('get_highlights', { query: 'why this' })) as { total: number };
    expect(byNote.total).toBe(1);
    const byUrl = (await call('get_highlights', { query: 'b.test' })) as { total: number };
    expect(byUrl.total).toBe(1);
    const all = (await call('get_highlights', {})) as { pages: number; total: number };
    expect(all.pages).toBe(2);
    expect(all.total).toBe(3);
  });

  it('says when it truncated, instead of quietly returning a prefix', async () => {
    const r = (await call('get_highlights', { limit: 1 })) as {
      total: number;
      truncated?: boolean;
    };
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(true);
  });
});

describe('delete_highlights', () => {
  beforeEach(seed);

  it('removes the named ids and leaves the rest', async () => {
    const r = (await call('delete_highlights', {
      url: 'https://a.test/post',
      ids: '["hl_1"]',
    })) as { removed: number; remaining: number };
    expect(r).toMatchObject({ removed: 1, remaining: 1 });
    expect((store[KEY] as unknown[]).length).toBe(1);
  });

  it('clears the page when no ids are given, and says that is what it did', async () => {
    const r = (await call('delete_highlights', { url: 'https://a.test/post' })) as {
      removed: number;
      cleared?: boolean;
    };
    expect(r).toMatchObject({ removed: 2, cleared: true });
    expect(KEY in store).toBe(false);
  });

  it('reports ids it did not recognise rather than pretending they were removed', async () => {
    const r = (await call('delete_highlights', {
      url: 'https://a.test/post',
      ids: 'hl_1, hl_nope',
    })) as { removed: number; unknown_ids?: string[] };
    expect(r.removed).toBe(1);
    expect(r.unknown_ids).toEqual(['hl_nope']);
  });

  it('is harmless on a page with no highlights', async () => {
    const r = (await call('delete_highlights', { url: 'https://none.test/' })) as {
      removed: number;
    };
    expect(r.removed).toBe(0);
  });
});

describe('the ids argument', () => {
  it('distinguishes "these" from "all of them"', async () => {
    const { parseHighlightIds } = await import('../src/tools/generic/highlights');
    expect(parseHighlightIds(undefined)).toBeNull(); // all
    expect(parseHighlightIds('')).toBeNull(); // all
    expect(parseHighlightIds('["a","b"]')).toEqual(['a', 'b']);
    expect(parseHighlightIds('a, b')).toEqual(['a', 'b']);
    expect(parseHighlightIds(['a'])).toEqual(['a']);
  });
});
