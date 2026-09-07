/**
 * controlled-tabs (F1 registry + T1 grouping). Uses a minimal chrome stub since
 * the logic is chrome.tabs/tabGroups-heavy. Verifies: tracking, WINDOW-AWARE
 * group create + reuse (groups are window-scoped; creating pins
 * createProperties.windowId to the tab's own window so grouping never moves a
 * tab across windows — the agent-window bug), recreate-on-stale-group,
 * onRemoved pruning, graceful degradation when tabGroups is unavailable, plus
 * the same-named-group-pile-up fixes: dedupe against an existing group after an
 * SW restart, legacy-title ("WebChat Agent") adoption, and orphan-window reaping.
 *
 * The stub tracks real group/tab/window state so query() reflects create/join/
 * remove — the dedupe + reap paths query Chrome, so a stateless stub can't
 * exercise them faithfully.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  adoptTab,
  releaseTab,
  isControlled,
  controlledTabIds,
  reapOrphanAgentWindows,
  __resetControlledTabs,
} from '../src/background/controlled-tabs';

interface GroupRec {
  id: number;
  windowId: number;
  title: string;
  color: string;
}
interface TabRec {
  id: number;
  windowId: number;
  url: string;
  groupId?: number;
}

function makeChrome(withGroups = true) {
  const onRemovedCbs: Array<(id: number) => void> = [];
  const groupOnRemovedCbs: Array<(g: { id: number }) => void> = [];
  const winOnRemovedCbs: Array<(id: number) => void> = [];
  let nextGroup = 100;
  const tabWindows = new Map<number, number>(); // tabId → windowId (default 1)
  const tabs = new Map<number, TabRec>();
  const groups = new Map<number, GroupRec>();
  const calls = { group: [] as unknown[], update: [] as unknown[], removeWindow: [] as number[] };

  const chrome: Record<string, unknown> = {
    tabs: {
      onRemoved: { addListener: (cb: (id: number) => void) => onRemovedCbs.push(cb) },
      get: async (id: number) => {
        const t = tabs.get(id);
        if (t) return t;
        return { id, windowId: tabWindows.get(id) ?? 1 };
      },
      query: async (q: { windowId?: number } = {}) => {
        const all = [...tabs.values()];
        return q.windowId !== undefined ? all.filter((t) => t.windowId === q.windowId) : all;
      },
      group: async (opts: {
        groupId?: number;
        tabIds: number;
        createProperties?: { windowId: number };
      }) => {
        calls.group.push(opts);
        // Joining a group Chrome no longer has → "No group with id" (the stale /
        // auto-removed case). Removing the group record IS how we model staleness.
        if (opts.groupId !== undefined && !groups.has(opts.groupId)) {
          throw new Error(`no group ${opts.groupId}`);
        }
        let gid: number;
        let windowId: number;
        if (opts.groupId !== undefined) {
          gid = opts.groupId;
          windowId = groups.get(gid)!.windowId;
        } else {
          gid = nextGroup++;
          windowId = opts.createProperties?.windowId ?? 1;
          groups.set(gid, { id: gid, windowId, title: '', color: 'grey' });
        }
        const t = tabs.get(opts.tabIds) ?? {
          id: opts.tabIds,
          windowId,
          url: 'about:blank',
        };
        t.groupId = gid;
        t.windowId = windowId;
        tabs.set(opts.tabIds, t);
        return gid;
      },
    },
    windows: {
      onRemoved: { addListener: (cb: (id: number) => void) => winOnRemovedCbs.push(cb) },
      get: async (id: number) => ({ id }),
      remove: async (id: number) => {
        calls.removeWindow.push(id);
        for (const [tid, t] of tabs) if (t.windowId === id) tabs.delete(tid);
        for (const [gid, g] of groups) if (g.windowId === id) groups.delete(gid);
      },
    },
  };
  if (withGroups) {
    chrome.tabGroups = {
      onRemoved: { addListener: (cb: (g: { id: number }) => void) => groupOnRemovedCbs.push(cb) },
      query: async (q: { windowId?: number; title?: string } = {}) => {
        let gs = [...groups.values()];
        if (q.windowId !== undefined) gs = gs.filter((g) => g.windowId === q.windowId);
        if (q.title !== undefined) gs = gs.filter((g) => g.title === q.title);
        return gs;
      },
      update: async (id: number, props: { title?: string; color?: string }) => {
        calls.update.push([id, props]);
        const g = groups.get(id);
        if (g) Object.assign(g, props);
      },
    };
  }
  return {
    chrome,
    calls,
    groups,
    tabs,
    setTabWindow: (tabId: number, windowId: number) => tabWindows.set(tabId, windowId),
    /** Pre-seed a group + its tabs (simulates state that survives an SW restart). */
    seedGroup: (id: number, windowId: number, title: string, tabIds: number[] = []) => {
      groups.set(id, { id, windowId, title, color: 'blue' });
      for (const tid of tabIds)
        tabs.set(tid, { id: tid, windowId, url: 'about:blank', groupId: id });
      if (id >= nextGroup) nextGroup = id + 1;
    },
    /** Pre-seed a loose tab (e.g. a foreign / non-agent tab in a window). */
    seedTab: (id: number, windowId: number, url: string, groupId?: number) =>
      tabs.set(id, { id, windowId, url, groupId }),
    fireRemoved: (id: number) => onRemovedCbs.forEach((cb) => cb(id)),
    fireGroupRemoved: (id: number) => {
      groups.delete(id); // Chrome removed it — query must stop returning it
      groupOnRemovedCbs.forEach((cb) => cb({ id }));
    },
    /** Simulate a group Chrome auto-removed (empty) — join attempts now throw. */
    setFailGroup: (id: number) => groups.delete(id),
  };
}

describe('controlled-tabs', () => {
  beforeEach(() => __resetControlledTabs());

  it('tracks a tab and creates the group in the tab own window with title + color', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await adoptTab(1);
    expect(isControlled(1)).toBe(true);
    expect(controlledTabIds()).toEqual([1]);
    // createProperties.windowId pinned to the tab's window — NOT the current
    // window (Chrome's default), which would move the tab across windows.
    expect(m.calls.group).toEqual([{ tabIds: 1, createProperties: { windowId: 1 } }]);
    expect(m.calls.update).toEqual([[100, { title: 'Web Agent', color: 'blue' }]]);
  });

  it('reuses the same-window group for later tabs (no second update)', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await adoptTab(1);
    await adoptTab(2);
    expect(controlledTabIds().sort()).toEqual([1, 2]);
    expect(m.calls.group).toEqual([
      { tabIds: 1, createProperties: { windowId: 1 } },
      { groupId: 100, tabIds: 2 },
    ]);
    expect(m.calls.update).toHaveLength(1); // group styled once
  });

  it('keeps one group per window — a tab in another window gets its own group', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    m.setTabWindow(1, 7); // agent window
    await adoptTab(1); // → group 100 in window 7
    m.setTabWindow(2, 9); // user's window
    await adoptTab(2); // → NEW group 101 in window 9 (never joins window 7's group)
    m.setTabWindow(3, 7);
    await adoptTab(3); // → rejoins window 7's group
    expect(m.calls.group).toEqual([
      { tabIds: 1, createProperties: { windowId: 7 } },
      { tabIds: 2, createProperties: { windowId: 9 } },
      { groupId: 100, tabIds: 3 },
    ]);
    expect(m.calls.update).toHaveLength(2); // styled each window's group once
  });

  it('recreates the group when the old one is stale', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await adoptTab(1); // group 100 in window 1
    m.setFailGroup(100); // 100 now gone (Chrome auto-removed it)
    await adoptTab(3); // join(100) throws → retry → new group 101 in window 1
    expect(m.calls.group).toEqual([
      { tabIds: 1, createProperties: { windowId: 1 } },
      { groupId: 100, tabIds: 3 },
      { tabIds: 3, createProperties: { windowId: 1 } },
    ]);
    expect(m.calls.update).toHaveLength(2); // styled the new group too
  });

  it('forgets a group when Chrome removes it (empty group auto-close)', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await adoptTab(1); // group 100 in window 1
    m.fireGroupRemoved(100);
    await adoptTab(2); // must create a fresh group, not join the dead one
    expect(m.calls.group[1]).toEqual({ tabIds: 2, createProperties: { windowId: 1 } });
  });

  it('reuses an EXISTING agent group after an SW restart (no duplicate group)', async () => {
    // Post-restart: the in-memory map is empty but Chrome still has the "Web Agent"
    // group — adopt must JOIN it, not spawn a duplicate (the pile-up root cause).
    const m = makeChrome();
    m.seedGroup(100, 1, 'Web Agent', [1]);
    vi.stubGlobal('chrome', m.chrome);
    await adoptTab(2);
    expect(m.calls.group).toEqual([{ groupId: 100, tabIds: 2 }]); // joined, not created
    expect(m.calls.update).toHaveLength(0); // already correctly labeled — no relabel
  });

  it('adopts + relabels a legacy "WebChat Agent" group', async () => {
    const m = makeChrome();
    m.seedGroup(100, 1, 'WebChat Agent', [1]); // pre-rename orphan group
    vi.stubGlobal('chrome', m.chrome);
    await adoptTab(2);
    expect(m.calls.group).toEqual([{ groupId: 100, tabIds: 2 }]); // reuse the legacy group
    expect(m.calls.update).toEqual([[100, { title: 'Web Agent', color: 'blue' }]]); // normalized
  });

  it('prunes the registry when a tab is removed', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await adoptTab(1);
    await adoptTab(2);
    m.fireRemoved(1);
    expect(isControlled(1)).toBe(false);
    expect(controlledTabIds()).toEqual([2]);
  });

  it('still tracks tabs when tabGroups is unavailable', async () => {
    const m = makeChrome(false);
    vi.stubGlobal('chrome', m.chrome);
    await expect(adoptTab(7)).resolves.toBeUndefined();
    expect(isControlled(7)).toBe(true);
    expect(m.calls.group).toEqual([]); // never attempted
  });

  it('releaseTab stops tracking without touching the tab', async () => {
    const m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
    await adoptTab(5);
    releaseTab(5);
    expect(isControlled(5)).toBe(false);
  });

  describe('reapOrphanAgentWindows', () => {
    it('closes leaked agent-only windows, sparing the live one', async () => {
      const m = makeChrome();
      // Live agent window (spared) + two leaked ones (new + legacy title).
      m.seedGroup(100, 1, 'Web Agent', [11]);
      m.seedGroup(200, 2, 'Web Agent', [21]);
      m.seedGroup(300, 3, 'WebChat Agent', [31]);
      vi.stubGlobal('chrome', m.chrome);
      const closed = await reapOrphanAgentWindows(1);
      expect(closed).toBe(2);
      expect(m.calls.removeWindow.sort()).toEqual([2, 3]);
      expect(m.groups.has(100)).toBe(true); // live window untouched
    });

    it('spares a window that holds any foreign (non-agent) tab', async () => {
      const m = makeChrome();
      m.seedGroup(200, 2, 'Web Agent', [21]); // agent tab
      m.seedTab(22, 2, 'https://example.com'); // the user's own tab, ungrouped
      vi.stubGlobal('chrome', m.chrome);
      const closed = await reapOrphanAgentWindows(undefined);
      expect(closed).toBe(0);
      expect(m.calls.removeWindow).toEqual([]);
    });

    it('closes a placeholder-only agent window (about:blank in the group)', async () => {
      const m = makeChrome();
      m.seedGroup(200, 2, 'Web Agent', [21]); // 21 is about:blank in the group
      vi.stubGlobal('chrome', m.chrome);
      const closed = await reapOrphanAgentWindows(undefined);
      expect(closed).toBe(1);
      expect(m.calls.removeWindow).toEqual([2]);
    });
  });

  /**
   * Per-shell group title. Tab groups are BROWSER-global, so when the full shell
   * ("Web Agent") and WebCLI shared one title each one's orphan reaper closed the
   * OTHER's agent window — killing the tabs an external agent was working on.
   */
  describe('per-shell group title', () => {
    const withName = (m: ReturnType<typeof makeChrome>, name: string): void => {
      (m.chrome as Record<string, unknown>).runtime = { getManifest: () => ({ name }) };
    };

    it('labels the group with THIS extension name', async () => {
      const m = makeChrome();
      withName(m, 'WebCLI');
      vi.stubGlobal('chrome', m.chrome);
      await adoptTab(1);
      expect(m.calls.update).toEqual([[100, { title: 'WebCLI', color: 'blue' }]]);
    });

    it('never touches the other shell agent window (its title is foreign)', async () => {
      const m = makeChrome();
      withName(m, 'WebCLI');
      m.seedGroup(700, 70, 'Web Agent', [71]); // the FULL shell's agent window
      m.seedGroup(800, 80, 'WebCLI', [81]); // our own leaked one
      vi.stubGlobal('chrome', m.chrome);
      const closed = await reapOrphanAgentWindows(undefined);
      expect(closed).toBe(1);
      expect(m.calls.removeWindow).toEqual([80]); // window 70 survives
    });

    // A store name is descriptive ("WebCLI - Browser Control for Agents"); a tab
    // group title is rendered inline in the tab strip, so it is cut at the first
    // dash separator. The cut also means the descriptor could be added WITHOUT a
    // migration: the label stayed "WebCLI", so groups from older builds are still
    // recognized — which is what these two cases lock down.
    it('cuts the store descriptor off the tab-group label', async () => {
      const m = makeChrome();
      withName(m, 'WebCLI - Browser Control for Agents');
      vi.stubGlobal('chrome', m.chrome);
      await adoptTab(1);
      expect(m.calls.update).toEqual([[100, { title: 'WebCLI', color: 'blue' }]]);
    });

    it('still adopts a group created before the name gained its descriptor', async () => {
      const m = makeChrome();
      withName(m, 'WebCLI - Browser Control for Agents');
      m.seedGroup(100, 1, 'WebCLI', [1]); // written by a pre-rename build
      vi.stubGlobal('chrome', m.chrome);
      await adoptTab(2);
      // Joined the existing group rather than piling a second one beside it.
      expect(m.calls.group).toEqual([{ groupId: 100, tabIds: 2 }]);
    });

    it('keeps "(dev)" — the dev build must not share the store build label', async () => {
      const m = makeChrome();
      withName(m, 'WebCLI (dev) - Browser Control for Agents');
      vi.stubGlobal('chrome', m.chrome);
      await adoptTab(1);
      expect(m.calls.update).toEqual([[100, { title: 'WebCLI (dev)', color: 'blue' }]]);
    });

    it('a shell with a non-legacy title does not inherit "WebChat Agent"', async () => {
      const m = makeChrome();
      withName(m, 'WebCLI');
      m.seedGroup(300, 3, 'WebChat Agent', [31]); // legacy = the full shell's alias
      vi.stubGlobal('chrome', m.chrome);
      expect(await reapOrphanAgentWindows(undefined)).toBe(0);
    });

    it('falls back to "Web Agent" when the manifest is unreadable', async () => {
      const m = makeChrome();
      (m.chrome as Record<string, unknown>).runtime = {
        getManifest: () => {
          throw new Error('no manifest');
        },
      };
      vi.stubGlobal('chrome', m.chrome);
      await adoptTab(1);
      expect(m.calls.update).toEqual([[100, { title: 'Web Agent', color: 'blue' }]]);
    });
  });
});
