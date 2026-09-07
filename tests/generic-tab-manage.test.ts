/**
 * manage_tabs — the multi-action tab-management tool (group/ungroup/activate/
 * move/pin/reload). Chrome-stubbed like controlled-tabs.test; verifies the
 * window-scoped group partition (never moves tabs across windows), the
 * controlled-tab skip, id parsing, and the error shapes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/background/controlled-tabs', () => ({
  // Tab 99 belongs to the agent's own group — group must skip it.
  isControlled: (id: number) => id === 99,
}));

import { parseTabIds } from '../src/tools/generic/tab-manage';
import { getRegistry } from '../src/runtime/registry.js';

type Def = {
  site: string;
  name: string;
  func: (p: unknown, k: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
const tool = (getRegistry() as Def[]).find(
  (d) => d.site === 'generic' && d.name === 'manage_tabs',
)!;

function makeChrome() {
  const tabWindows = new Map<number, number>(); // tabId → windowId
  const calls = {
    group: [] as unknown[],
    groupUpdate: [] as unknown[],
    ungroup: [] as unknown[],
    move: [] as unknown[],
    update: [] as unknown[],
    reload: [] as number[],
    exec: [] as { tabId: number; args: unknown[] }[],
    windowsUpdate: [] as unknown[],
  };
  let nextGroup = 500;
  const chrome = {
    tabs: {
      get: async (id: number) => {
        if (!tabWindows.has(id)) throw new Error(`no tab ${id}`);
        return { id, windowId: tabWindows.get(id) };
      },
      group: async (opts: unknown) => {
        calls.group.push(opts);
        return nextGroup++;
      },
      ungroup: async (ids: number[]) => {
        calls.ungroup.push(ids);
      },
      move: async (ids: number[], opts: unknown) => {
        calls.move.push([ids, opts]);
        return ids.map((id) => ({ id }));
      },
      update: async (id: number, props: unknown) => {
        calls.update.push([id, props]);
        return { id, windowId: tabWindows.get(id) ?? 1 };
      },
      reload: async (id: number) => {
        calls.reload.push(id);
      },
      query: async (q: { groupId?: number }) => (q.groupId === 700 ? [{ id: 7 }, { id: 8 }] : []),
    },
    tabGroups: {
      update: async (gid: number, props: unknown) => {
        calls.groupUpdate.push([gid, props]);
      },
    },
    scripting: {
      // back/forward inject history.go(±1); tab 2 is "not scriptable" → throws.
      executeScript: async ({ target, args }: { target: { tabId: number }; args: unknown[] }) => {
        if (target.tabId === 2) throw new Error('Cannot access a chrome:// URL');
        calls.exec.push({ tabId: target.tabId, args });
        return [{ result: undefined }];
      },
    },
    windows: {
      update: async (wid: number, props: unknown) => {
        calls.windowsUpdate.push([wid, props]);
      },
    },
  };
  return {
    chrome,
    calls,
    setTab: (id: number, windowId: number) => tabWindows.set(id, windowId),
  };
}

describe('parseTabIds', () => {
  it('accepts JSON arrays, comma and space separated strings; dedupes; drops junk', () => {
    expect(parseTabIds([1, 2, 2, '3'])).toEqual([1, 2, 3]);
    expect(parseTabIds('12, 34 56')).toEqual([12, 34, 56]);
    expect(parseTabIds('12,abc,-5,0')).toEqual([12]);
    expect(parseTabIds(undefined)).toEqual([]);
  });
});

describe('manage_tabs', () => {
  let m: ReturnType<typeof makeChrome>;
  beforeEach(() => {
    m = makeChrome();
    vi.stubGlobal('chrome', m.chrome);
  });

  it('group: partitions by window (one group per window, never moves tabs)', async () => {
    m.setTab(1, 10);
    m.setTab(2, 10);
    m.setTab(3, 20);
    const r = await tool.func(null, { action: 'group', tab_ids: '1,2,3', title: '资料' });
    expect((r.groups as unknown[]).length).toBe(2);
    expect(r.note).toContain('Across windows');
    // createProperties pins each group to the tabs' own window.
    expect(m.calls.group).toEqual([
      { tabIds: [1, 2], createProperties: { windowId: 10 } },
      { tabIds: [3], createProperties: { windowId: 20 } },
    ]);
    expect(m.calls.groupUpdate.map((c) => (c as unknown[])[1])).toEqual([
      { title: '资料' },
      { title: '资料' },
    ]);
  });

  it('group: skips the agent-controlled tab and reports dead ids', async () => {
    m.setTab(1, 10);
    m.setTab(99, 10); // controlled (mocked)
    const r = await tool.func(null, { action: 'group', tab_ids: '1,99,404', title: 'T' });
    expect(r.skipped_controlled).toEqual([99]);
    expect(r.not_found).toEqual([404]);
    expect(m.calls.group).toEqual([{ tabIds: [1], createProperties: { windowId: 10 } }]);
  });

  it('group: validates color — unknown color ignored with a note, valid one passed', async () => {
    m.setTab(1, 10);
    const bad = await tool.func(null, {
      action: 'group',
      tab_ids: '1',
      title: 'T',
      color: 'mauve',
    });
    expect(bad.color_note).toContain('mauve');
    expect(m.calls.groupUpdate.at(-1)![1]).toEqual({ title: 'T' });
    const ok = await tool.func(null, { action: 'group', tab_ids: '1', title: 'T', color: 'blue' });
    expect(ok.color_note).toBeUndefined();
    expect(m.calls.groupUpdate.at(-1)![1]).toEqual({ title: 'T', color: 'blue' });
  });

  it('group: requires tab_ids and title — and REJECTS, not "succeeds with an error field"', async () => {
    // These used to `return {error}`, which the executor wrapped as ok:true — an
    // agent reading the envelope saw success and carried on as if the tabs had
    // been grouped. Missing args must reject so the failure is a failure. F-47.
    await expect(tool.func(null, { action: 'group', title: 'T' })).rejects.toThrow(/tab_ids/);
    await expect(tool.func(null, { action: 'group', tab_ids: '1' })).rejects.toThrow(/title/);
  });

  it('accepts `tab_id` as an alias for `tab_ids`', async () => {
    // Every other tab tool takes the singular, and unknown args are ignored, so
    // the analogy used to produce a silent no-op instead of an error. F-47.
    m.setTab(1, 10);
    await tool.func(null, { action: 'reload', tab_id: 1 });
    expect(m.calls.reload).toEqual([1]);
  });

  it('ungroup: by explicit ids, or by group_id via query', async () => {
    await tool.func(null, { action: 'ungroup', tab_ids: '4,5' });
    expect(m.calls.ungroup).toEqual([[4, 5]]);
    const r = await tool.func(null, { action: 'ungroup', group_id: 700 });
    expect(m.calls.ungroup.at(-1)).toEqual([7, 8]);
    expect(r.ungrouped).toBe(2);
  });

  it('activate: focuses the tab AND its window', async () => {
    m.setTab(6, 30);
    const r = await tool.func(null, { action: 'activate', tab_ids: '6' });
    expect(r.activated).toBe(true);
    expect(m.calls.update).toEqual([[6, { active: true }]]);
    expect(m.calls.windowsUpdate).toEqual([[30, { focused: true }]]);
  });

  it('move: passes window_id/index through; pin/unpin/reload update each live tab', async () => {
    m.setTab(1, 10);
    m.setTab(2, 10);
    await tool.func(null, { action: 'move', tab_ids: '1,2', window_id: 20, index: 0 });
    expect(m.calls.move).toEqual([[[1, 2], { index: 0, windowId: 20 }]]);
    const pin = await tool.func(null, { action: 'pin', tab_ids: '1,404' });
    expect(pin.updated).toBe(1);
    expect(pin.not_found).toEqual([404]);
    expect(m.calls.update.at(-1)).toEqual([1, { pinned: true }]);
    await tool.func(null, { action: 'unpin', tab_ids: '1' });
    expect(m.calls.update.at(-1)).toEqual([1, { pinned: false }]);
    const rl = await tool.func(null, { action: 'reload', tab_ids: '1,2' });
    expect(rl.reloaded).toBe(2);
    expect(m.calls.reload).toEqual([1, 2]);
  });

  it('back/forward: injects history.go(±1) per live tab; unscriptable tab → errors, dead → not_found', async () => {
    m.setTab(1, 10);
    m.setTab(2, 10); // "not scriptable" in the mock → executeScript throws
    const back = await tool.func(null, { action: 'back', tab_ids: '1' });
    expect(back.navigated).toBe(1);
    expect(m.calls.exec).toEqual([{ tabId: 1, args: [-1] }]); // history.go(-1)
    const fwd = await tool.func(null, { action: 'forward', tab_ids: '1,2,404' });
    expect(fwd.navigated).toBe(1); // only tab 1 succeeds
    expect((fwd.errors as { id: number }[]).map((e) => e.id)).toEqual([2]);
    expect(fwd.not_found).toEqual([404]);
    expect(m.calls.exec.at(-1)).toEqual({ tabId: 1, args: [1] }); // history.go(1)
  });

  it('unknown action → error listing the available ones', async () => {
    const r = await tool.func(null, { action: 'explode' });
    expect(String(r.error)).toContain(
      'group / ungroup / activate / move / pin / unpin / reload / back / forward',
    );
  });
});
