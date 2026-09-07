/**
 * agent-window — the dedicated window that isolates agent-opened tabs from the
 * user's window. chrome.windows/tabs-heavy, so a minimal stub. Verifies: lazy
 * create + open-in-window, reuse across calls, recreate after the user closes it
 * (both the onRemoved path and the stale-id probe), the concurrency guard (one
 * window under parallel pre-run), and active → focus.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createAgentTab,
  getAgentWindowId,
  reapLeakedAgentWindowsOnBoot,
  closeIdleAgentWindow,
  __resetAgentWindow,
} from '../src/background/agent-window';
import { __resetControlledTabs } from '../src/background/controlled-tabs';

const USER_WINDOW = 1; // the user's foreground window (never an agent window id ≥500)

function makeChrome() {
  const winOnRemoved: Array<(id: number) => void> = [];
  const live = new Set<number>();
  const doomed = new Set<number>(); // window 'alive' per get() but create() reports it gone
  const sessionStore: Record<string, unknown> = {}; // chrome.storage.session backing
  const groups: Array<{ id: number; windowId: number; title: string }> = [];
  const tabsStore = new Map<
    number,
    { id: number; windowId: number; url: string; groupId?: number }
  >();
  let nextWin = 500;
  let nextTab = 1;
  let nextGroup = 100;
  const created = {
    windows: [] as Record<string, unknown>[],
    tabs: [] as Record<string, unknown>[],
    updates: [] as unknown[],
    removedWindows: [] as number[],
  };
  const chrome: Record<string, unknown> = {
    windows: {
      onRemoved: { addListener: (cb: (id: number) => void) => winOnRemoved.push(cb) },
      getLastFocused: async () => ({ id: USER_WINDOW }),
      create: async (opts: Record<string, unknown>) => {
        const id = nextWin++;
        live.add(id);
        created.windows.push(opts);
        const tid = nextTab++;
        tabsStore.set(tid, { id: tid, windowId: id, url: 'about:blank' });
        return { id, tabs: [{ id: tid, url: opts.url }] };
      },
      get: async (id: number) => {
        if (!live.has(id)) throw new Error(`no window ${id}`);
        return { id };
      },
      update: async (id: number, props: unknown) => {
        created.updates.push([id, props]);
      },
      remove: async (id: number) => {
        created.removedWindows.push(id);
        live.delete(id);
        dropGroups(id);
        for (const [tid, t] of tabsStore) if (t.windowId === id) tabsStore.delete(tid);
      },
    },
    tabs: {
      onRemoved: { addListener: () => {} },
      get: async (id: number) => tabsStore.get(id) ?? { id, windowId: 500 },
      query: async (q: { windowId?: number } = {}) => {
        const all = [...tabsStore.values()];
        return q.windowId !== undefined ? all.filter((t) => t.windowId === q.windowId) : all;
      },
      create: async (opts: Record<string, unknown>) => {
        if (typeof opts.windowId === 'number' && doomed.has(opts.windowId)) {
          throw new Error(`No window with id: ${opts.windowId}.`);
        }
        created.tabs.push(opts);
        const id = nextTab++;
        tabsStore.set(id, { id, windowId: opts.windowId as number, url: opts.url as string });
        return { id, url: opts.url };
      },
      // placeholder adoption goes through controlled-tabs → tabs.group (best-effort)
      group: async (opts: {
        groupId?: number;
        tabIds: number;
        createProperties?: { windowId?: number };
      }) => {
        let gid = opts.groupId;
        if (gid === undefined) {
          gid = nextGroup++;
          groups.push({ id: gid, windowId: opts.createProperties?.windowId ?? 500, title: '' });
        }
        const t = tabsStore.get(opts.tabIds);
        if (t) t.groupId = gid;
        return gid;
      },
    },
    tabGroups: {
      onRemoved: { addListener: () => {} },
      update: async (id: number, props: { title?: string }) => {
        const g = groups.find((x) => x.id === id);
        if (g && props.title !== undefined) g.title = props.title;
      },
      query: async (q: { title?: string; windowId?: number }) =>
        groups.filter(
          (g) =>
            (q.title === undefined || g.title === q.title) &&
            (q.windowId === undefined || g.windowId === q.windowId),
        ),
    },
    storage: {
      session: {
        get: async (key: string) => (key in sessionStore ? { [key]: sessionStore[key] } : {}),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(sessionStore, obj);
        },
        remove: async (key: string) => {
          delete sessionStore[key];
        },
      },
    },
  };
  // A window that closes (or vanishes at create time) takes its tab group with
  // it — so findAgentGroupWindow can't resurrect a dead window id.
  const dropGroups = (id: number) => {
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].windowId === id) groups.splice(i, 1);
    }
  };
  return {
    chrome,
    created,
    /** Seed a leaked agent window: alive, with an agent-titled group + a lone
     * about:blank placeholder — exactly what a stranded agent window looks like. */
    seedLeakedWindow: (winId: number, title: string) => {
      live.add(winId);
      groups.push({ id: nextGroup++, windowId: winId, title });
      const tid = nextTab++;
      tabsStore.set(tid, { id: tid, windowId: winId, url: 'about:blank' });
    },
    closeWindow: (id: number) => {
      live.delete(id);
      dropGroups(id);
    },
    doomWindow: (id: number) => {
      doomed.add(id);
      dropGroups(id);
    },
    fireWinRemoved: (id: number) => winOnRemoved.forEach((cb) => cb(id)),
    /** Drop a tab, as the run-tab janitor / the user would. */
    removeTab: (id: number) => tabsStore.delete(id),
    /** A tab mid-navigation: Chrome reports an EMPTY url until it commits, with
     * the destination in pendingUrl. */
    seedLoadingTab: (winId: number, pendingUrl: string) => {
      const tid = nextTab++;
      tabsStore.set(tid, { id: tid, windowId: winId, url: '', pendingUrl } as never);
      return tid;
    },
    tabIdsIn: (winId: number) =>
      [...tabsStore.values()].filter((t) => t.windowId === winId).map((t) => t.id),
    clearSession: () => {
      for (const k of Object.keys(sessionStore)) delete sessionStore[k];
    },
  };
}

describe('agent-window', () => {
  beforeEach(() => {
    __resetAgentWindow();
    __resetControlledTabs();
  });

  it('lazily creates one window and opens the tab inside it', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    const tab = await createAgentTab('https://example.com');
    expect(m.created.windows).toHaveLength(1); // window created once
    expect(typeof tab.id).toBe('number');
    expect(getAgentWindowId()).toBe(500);
    // content tab opened in the agent window, in the background
    expect(m.created.tabs).toEqual([{ url: 'https://example.com', active: false, windowId: 500 }]);
  });

  it('reuses the same window for later tabs', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await createAgentTab('https://a.com');
    await createAgentTab('https://b.com');
    expect(m.created.windows).toHaveLength(1); // not a second window
    expect(m.created.tabs.map((t) => t.windowId)).toEqual([500, 500]);
  });

  it('recreates the window after the user closes it (onRemoved)', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await createAgentTab('https://a.com'); // window 500
    m.closeWindow(500);
    m.fireWinRemoved(500); // user closed it
    await createAgentTab('https://b.com'); // → fresh window 501
    expect(m.created.windows).toHaveLength(2);
    expect(getAgentWindowId()).toBe(501);
  });

  it('recreates when the remembered window is stale (get throws, no onRemoved)', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await createAgentTab('https://a.com'); // window 500
    m.closeWindow(500); // gone, but onRemoved not fired
    await createAgentTab('https://b.com'); // get(500) rejects → recreate
    expect(m.created.windows).toHaveLength(2);
    expect(getAgentWindowId()).toBe(501);
  });

  it('opens just one window under concurrent calls (parallel pre-run)', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await Promise.all([
      createAgentTab('https://a.com'),
      createAgentTab('https://b.com'),
      createAgentTab('https://c.com'),
    ]);
    expect(m.created.windows).toHaveLength(1); // creating-guard held
    expect(m.created.tabs).toHaveLength(3);
    expect(m.created.tabs.every((t) => t.windowId === 500)).toBe(true);
  });

  it('active:true activates the tab and focuses the window', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await createAgentTab('https://a.com', { active: true });
    expect(m.created.tabs[0]).toMatchObject({ active: true, windowId: 500 });
    expect(m.created.updates).toContainEqual([500, { focused: true }]);
  });

  it('a background create restores focus to the user window, never the agent one', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await createAgentTab('https://a.com'); // background (active:false) create
    // Focus yanked back to the user's window; the new agent window never focused.
    expect(m.created.updates).toContainEqual([USER_WINDOW, { focused: true }]);
    expect(m.created.updates).not.toContainEqual([500, { focused: true }]);
  });

  it('boot cleanup closes leaked agent windows, sparing the tracked one', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await createAgentTab('https://a.com'); // window 500 (tracked)
    m.seedLeakedWindow(700, 'WebChat Agent'); // pre-rename orphan
    m.seedLeakedWindow(800, 'Web Agent'); // another stranded window
    const closed = await reapLeakedAgentWindowsOnBoot();
    expect(closed).toBe(2);
    expect(m.created.removedWindows.sort((a, b) => a - b)).toEqual([700, 800]);
    expect(getAgentWindowId()).toBe(500); // the live agent window survives
  });

  it('recovers the existing agent window after a SW restart — no duplicate', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await createAgentTab('https://a.com'); // creates window 500, persists id to session
    expect(m.created.windows).toHaveLength(1);
    // Simulate MV3 SW death: in-memory state cleared, but window 500 is still
    // live and its id is still in chrome.storage.session.
    __resetAgentWindow();
    __resetControlledTabs();
    const tab = await createAgentTab('https://b.com'); // must REUSE 500, not spawn a 2nd
    expect(m.created.windows).toHaveLength(1);
    expect(getAgentWindowId()).toBe(500);
    expect(typeof tab.id).toBe('number');
  });

  it('re-adopts the existing agent window via its tab group when storage.session was lost', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await createAgentTab('https://a.com'); // window 500 + "Web Agent" group
    expect(m.created.windows).toHaveLength(1);
    // The leak scenario: MV3 SW death AND storage.session lost. The window + its
    // group still exist in Chrome, but the persisted id is gone — recall misses, so
    // we must find 500 via its durable group instead of leaking a 2nd window.
    __resetAgentWindow();
    __resetControlledTabs();
    m.clearSession();
    const tab = await createAgentTab('https://b.com');
    expect(m.created.windows).toHaveLength(1); // reused via group, not leaked
    expect(getAgentWindowId()).toBe(500);
    expect(typeof tab.id).toBe('number');
  });

  it('self-heals when the window vanishes at create time (probe passed, create fails)', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await createAgentTab('https://a.com'); // window 500
    // get(500) still 'passes' (onRemoved lag) but create() reports it gone:
    m.doomWindow(500);
    const tab = await createAgentTab('https://b.com'); // → forget 500, recreate 501
    expect(typeof tab.id).toBe('number');
    expect(m.created.windows).toHaveLength(2);
    expect(getAgentWindowId()).toBe(501);
  });
});

/**
 * closeIdleAgentWindow — the tail of the headless shells' idle sweep. Once the
 * content tabs are gone, the placeholder alone is not worth a whole Chrome
 * window (and its tab group) standing in the user's way.
 */
describe('closeIdleAgentWindow', () => {
  beforeEach(() => {
    __resetAgentWindow();
    __resetControlledTabs();
  });

  it('closes the window once only the placeholder is left', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    const tab = await createAgentTab('https://example.com');
    expect(await closeIdleAgentWindow()).toBe(false); // content tab still there
    m.removeTab(tab.id as number); // the janitor closed it
    expect(await closeIdleAgentWindow()).toBe(true);
    expect(m.created.removedWindows).toEqual([500]);
    // Forgotten, so the next task opens a fresh one instead of a dead id.
    expect(getAgentWindowId()).toBeUndefined();
    await createAgentTab('https://example.com/2');
    expect(m.created.windows).toHaveLength(2);
  });

  it('spares a window whose tab is still loading', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    const tab = await createAgentTab('https://example.com');
    m.removeTab(tab.id as number);
    // Chrome reports url:'' until the navigation commits — reading that as
    // "blank" would close the window around a page still on its way.
    m.seedLoadingTab(500, 'https://slow.example.com/');
    expect(await closeIdleAgentWindow()).toBe(false);
    expect(m.created.removedWindows).toEqual([]);
  });

  it('is a no-op when there is no agent window', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    expect(await closeIdleAgentWindow()).toBe(false);
    expect(m.created.removedWindows).toEqual([]);
  });

  it('finds the window across an SW restart, via the persisted id', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    const tab = await createAgentTab('https://example.com');
    m.removeTab(tab.id as number);
    __resetAgentWindow(); // MV3 recycled the worker; storage.session survives
    expect(await closeIdleAgentWindow()).toBe(true);
    expect(m.created.removedWindows).toEqual([500]);
  });
});
