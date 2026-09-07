/**
 * get_page_text — TAB LIFECYCLE (the url / url+keep_open / tab_id split).
 *
 * Two things are pinned here:
 *  ① a one-shot `url` grab must NOT report a tab id. It closes its own tab in
 *    `finally`, and a `tabId` in the result reads to the model as "the page is
 *    still open" → the next scroll_page / click dies with "tab N no longer
 *    exists (closed?)". It says `tab_closed: true` instead.
 *  ② `keep_open: true` is the one-call replacement for open_url → get_page_text:
 *    the tab survives, is adopted into the agent tab group, and comes back with
 *    `created_tab: true` so the dispatcher's run-tab janitor owns its cleanup
 *    (the janitor keys off that marker, not off the tool name).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const created: { url: string; active?: boolean }[] = [];
const adopted: number[] = [];
const removed: number[] = [];
const NEW_TAB_ID = 4242;

vi.mock('../src/background/agent-window', () => ({
  createAgentTab: async (url: string, opts: { active?: boolean } = {}) => {
    created.push({ url, active: opts.active });
    return { id: NEW_TAB_ID, url };
  },
}));

vi.mock('../src/background/controlled-tabs', () => ({
  adoptTab: async (id: number) => {
    adopted.push(id);
  },
}));

// Real assertHttpUrl / assertTabId; only the polling wait is stubbed (it drives
// real timers against a live tab, which this stub browser has no notion of).
vi.mock('../src/tools/generic/_helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/generic/_helpers')>();
  return { ...actual, waitForPageReady: async () => ({ readyState: 'complete', waitedMs: 0 }) };
});

import '../src/tools/generic/get-page-text';
import { getRegistry } from '../src/runtime/registry.js';

type Def = {
  site: string;
  name: string;
  func: (p: unknown, k: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
const tool = (getRegistry() as Def[]).find(
  (d) => d.site === 'generic' && d.name === 'get_page_text',
)!;

const PAGE = {
  title: 'T',
  url: 'https://x.test/p',
  text: 'hello',
  truncated: false,
  full_length: 5,
};

beforeEach(() => {
  created.length = 0;
  adopted.length = 0;
  removed.length = 0;
  vi.stubGlobal('chrome', {
    tabs: {
      get: async (id: number) => {
        if (id !== 7) throw new Error(`no tab ${id}`);
        return { id, url: 'https://open.test/', windowId: 1 };
      },
      remove: async (id: number) => {
        removed.push(id);
      },
    },
    scripting: { executeScript: async () => [{ result: PAGE }] },
  });
});

describe('get_page_text — url mode (one-shot)', () => {
  it('opens its own tab, closes it, and reports NO tab id', async () => {
    const r = await tool.func(null, { url: 'https://x.test/p' });
    expect(created).toEqual([{ url: 'https://x.test/p', active: false }]);
    expect(r.text).toBe('hello');
    expect(removed).toEqual([NEW_TAB_ID]);
    expect(r.tab_closed).toBe(true);
    expect(r.tabId).toBeUndefined();
    expect(r.created_tab).toBeUndefined();
    expect(adopted).toEqual([]); // a throwaway tab is never grouped
  });

  it('closes the tab even when the grab throws', async () => {
    vi.stubGlobal('chrome', {
      tabs: { remove: async (id: number) => void removed.push(id) },
      scripting: {
        executeScript: async () => {
          throw new Error('not scriptable');
        },
      },
    });
    await expect(tool.func(null, { url: 'https://x.test/p' })).rejects.toThrow('not scriptable');
    expect(removed).toEqual([NEW_TAB_ID]);
  });
});

describe('get_page_text — url + keep_open (read then act, one call)', () => {
  it('keeps the tab, adopts it, and returns a LIVE tabId + created_tab', async () => {
    const r = await tool.func(null, { url: 'https://x.test/p', keep_open: true });
    expect(r.text).toBe('hello');
    expect(removed).toEqual([]);
    expect(r.tabId).toBe(NEW_TAB_ID);
    expect(r.created_tab).toBe(true);
    expect(r.tab_closed).toBeUndefined();
    expect(adopted).toEqual([NEW_TAB_ID]); // joins the agent tab group like open_url
  });

  it('works with format:"markdown" too', async () => {
    vi.stubGlobal('chrome', {
      tabs: { remove: async (id: number) => void removed.push(id) },
      scripting: {
        executeScript: async () => [{ result: { title: 'T', url: 'u', markdown: '# H' } }],
      },
    });
    const r = await tool.func(null, {
      url: 'https://x.test/p',
      keep_open: true,
      format: 'markdown',
    });
    expect(r.markdown).toBe('# H');
    expect(r.tabId).toBe(NEW_TAB_ID);
    expect(removed).toEqual([]);
  });
});

describe('get_page_text — tab_id mode', () => {
  it('grabs in place: keeps the caller tab, no created_tab marker', async () => {
    const r = await tool.func(null, { tab_id: 7 });
    expect(r.tabId).toBe(7);
    expect(r.tab_closed).toBeUndefined();
    expect(r.created_tab).toBeUndefined(); // the caller owns this tab, not the janitor
    expect(removed).toEqual([]);
    expect(created).toEqual([]);
  });

  it('keep_open is inert in tab_id mode (the tab was never ours to close)', async () => {
    const r = await tool.func(null, { tab_id: 7, keep_open: true });
    expect(r.tabId).toBe(7);
    expect(r.created_tab).toBeUndefined();
    expect(removed).toEqual([]);
  });

  it('still rejects url + tab_id together, and neither', async () => {
    await expect(tool.func(null, { url: 'https://x.test/', tab_id: 7 })).rejects.toThrow(
      'only one of url and tab_id',
    );
    await expect(tool.func(null, {})).rejects.toThrow('need either url');
  });
});
