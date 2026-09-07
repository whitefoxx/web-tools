import { cli } from '../../runtime/registry.js';
import { isControlled } from '../../background/controlled-tabs';

/**
 * manage_tabs — the tab-MANAGEMENT side of the generic tab toolkit (list_tabs /
 * open_url / close_tab / get_active_tab cover open+read+close). One multi-action
 * tool instead of six single-action ones, same rationale as `notes` (§30):
 * every registered tool costs system-prompt tokens in every session.
 *
 * All actions are browser-local and reversible (no site data is touched), so
 * access stays 'read' like close_tab. Groups are WINDOW-SCOPED in Chrome —
 * `group` partitions the given tabs by window and creates one group per window
 * rather than silently moving tabs across windows (the controlled-tabs T1
 * lesson). The agent's own controlled tabs are skipped so an "organize my tabs"
 * task can't tear apart the Web Agent group mid-run.
 */

const GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const;

/** tab_ids arrives from the LLM as a JSON array or a comma/space separated
 * string — accept both, drop non-numeric junk. Exported for tests. */
export function parseTabIds(v: unknown): number[] {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/);
  const out: number[] = [];
  for (const item of raw) {
    const n = Number(item);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

cli({
  site: 'generic',
  name: 'manage_tabs',
  access: 'read',
  local: true,
  description:
    'Manage tabs (only touches the browser UI, never site data; all reversible). action: "group" = put tab_ids into a new tab group, partitioned by window (title required, color optional; across windows one group is created per window, tabs are not moved); "ungroup" = ungroup (pass tab_ids or group_id); "activate" = focus a tab and its window (bring the user there to look); "move" = move tabs (window_id across windows / index to reorder); "pin"/"unpin" = pin/unpin; "reload" = refresh; "back"/"forward" = go back/forward in a tab\'s history (use it to return to a list after clicking into a detail page, instead of re-running open_url). Pair with list_tabs (which returns windowId/groupId and the group listing) to see the current state before acting.',
  args: [
    {
      name: 'action',
      type: 'string',
      required: true,
      help: 'group | ungroup | activate | move | pin | unpin | reload | back | forward',
    },
    {
      name: 'tab_ids',
      type: 'string',
      help: 'List of tab ids, comma-separated (e.g. "12,34") or a JSON array; a single id also works (`tab_id` is accepted too); activate uses only the first',
    },
    {
      name: 'title',
      type: 'string',
      help: 'Required for group: the group name',
    },
    {
      name: 'color',
      type: 'string',
      help: `Optional for group: ${GROUP_COLORS.join('/')}`,
    },
    {
      name: 'group_id',
      type: 'int',
      help: 'Optional for ungroup: dissolve an entire group (instead of tab_ids)',
    },
    {
      name: 'window_id',
      type: 'int',
      help: 'Optional for move: target window id (omit to move within the window)',
    },
    {
      name: 'index',
      type: 'int',
      help: 'Optional for move: target position (0-based; default -1 = end)',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const action = String(kwargs.action ?? '');
    // `tab_id` is accepted as an alias: this is the ONLY tab tool whose arg is
    // plural, and validateArgs ignores unknown extras — so a caller reaching for
    // the singular by analogy with every other tab tool used to get an empty id
    // list and a silent no-op. (Found the hard way: a `reload` that never ran
    // was mistaken for a broken site script — findings.md F-47.)
    const ids = parseTabIds(kwargs.tab_ids ?? kwargs.tab_id);

    // Resolve which ids are still alive + their windows; report the dead ones instead of
    // letting one stale id fail the whole batch.
    async function resolveTabs(): Promise<{
      tabs: chrome.tabs.Tab[];
      notFound: number[];
    }> {
      const tabs: chrome.tabs.Tab[] = [];
      const notFound: number[] = [];
      for (const id of ids) {
        try {
          tabs.push(await chrome.tabs.get(id));
        } catch {
          notFound.push(id);
        }
      }
      return { tabs, notFound };
    }

    switch (action) {
      case 'group': {
        const title = typeof kwargs.title === 'string' ? kwargs.title.trim() : '';
        if (!ids.length) throw new Error('group requires tab_ids');
        if (!title) throw new Error('group requires title (the group name)');
        const color = GROUP_COLORS.includes(kwargs.color as (typeof GROUP_COLORS)[number])
          ? (kwargs.color as chrome.tabGroups.ColorEnum)
          : undefined;
        const { tabs, notFound } = await resolveTabs();
        const skippedControlled = tabs
          .filter((t) => isControlled(t.id as number))
          .map((t) => t.id as number);
        const eligible = tabs.filter((t) => !isControlled(t.id as number));
        // Groups are window-scoped: one group per window, never move tabs.
        const byWindow = new Map<number, number[]>();
        for (const t of eligible) {
          const w = t.windowId as number;
          byWindow.set(w, [...(byWindow.get(w) ?? []), t.id as number]);
        }
        const groups: { group_id: number; window_id: number; count: number }[] = [];
        for (const [windowId, tabIds] of byWindow) {
          const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
          await chrome.tabGroups.update(gid, { title, ...(color ? { color } : {}) });
          groups.push({ group_id: gid, window_id: windowId, count: tabIds.length });
        }
        return {
          action,
          title,
          groups,
          ...(groups.length > 1
            ? {
                note: 'Across windows: one group was created per window (a group cannot span windows)',
              }
            : {}),
          ...(skippedControlled.length ? { skipped_controlled: skippedControlled } : {}),
          ...(notFound.length ? { not_found: notFound } : {}),
          ...(kwargs.color && !color
            ? {
                color_note: `Unknown color "${String(kwargs.color)}" ignored; options: ${GROUP_COLORS.join('/')}`,
              }
            : {}),
        };
      }
      case 'ungroup': {
        let targets = ids;
        if (!targets.length && typeof kwargs.group_id === 'number') {
          const inGroup = await chrome.tabs.query({ groupId: kwargs.group_id });
          targets = inGroup.map((t) => t.id as number).filter((n) => Number.isFinite(n));
        }
        if (!targets.length) throw new Error('ungroup requires tab_ids or group_id');
        await chrome.tabs.ungroup(targets);
        return { action, ungrouped: targets.length };
      }
      case 'activate': {
        if (!ids.length) throw new Error('activate requires tab_ids');
        const tab = await chrome.tabs.get(ids[0]);
        await chrome.tabs.update(ids[0], { active: true });
        if (typeof tab.windowId === 'number') {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return { action, tabId: ids[0], activated: true };
      }
      case 'move': {
        if (!ids.length) throw new Error('move requires tab_ids');
        const index = typeof kwargs.index === 'number' ? kwargs.index : -1;
        const moved = await chrome.tabs.move(ids, {
          index,
          ...(typeof kwargs.window_id === 'number' ? { windowId: kwargs.window_id } : {}),
        });
        return { action, moved: Array.isArray(moved) ? moved.length : 1 };
      }
      case 'pin':
      case 'unpin': {
        if (!ids.length) throw new Error(`${action} requires tab_ids`);
        const { tabs, notFound } = await resolveTabs();
        for (const t of tabs) {
          await chrome.tabs.update(t.id as number, { pinned: action === 'pin' });
        }
        return {
          action,
          updated: tabs.length,
          ...(notFound.length ? { not_found: notFound } : {}),
        };
      }
      case 'reload': {
        if (!ids.length) throw new Error('reload requires tab_ids');
        const { tabs, notFound } = await resolveTabs();
        for (const t of tabs) await chrome.tabs.reload(t.id as number);
        return {
          action,
          reloaded: tabs.length,
          ...(notFound.length ? { not_found: notFound } : {}),
        };
      }
      case 'back':
      case 'forward': {
        // Navigate the tab's session history like the browser's back/forward
        // button. We inject `history.go(±1)` via chrome.scripting rather than
        // chrome.tabs.goBack/goForward: those throw a spurious "no history" even
        // when history exists on background agent-window / debugger-attached tabs
        // (real-machine finding F-41), whereas in-page history.go works reliably
        // and needs no extra permission. At a history boundary it's a harmless
        // no-op (same as the browser button); read the tab's URL to confirm a move.
        if (!ids.length) throw new Error(`${action} requires tab_ids`);
        const { tabs, notFound } = await resolveTabs();
        const delta = action === 'back' ? -1 : 1;
        const done: number[] = [];
        const errors: { id: number; error: string }[] = [];
        for (const t of tabs) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: t.id as number },
              func: (d: number) => {
                history.go(d);
              },
              args: [delta],
            });
            done.push(t.id as number);
          } catch (e) {
            // Tab not scriptable (chrome://, restricted) — report, don't fail the batch.
            errors.push({ id: t.id as number, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return {
          action,
          navigated: done.length,
          ...(errors.length ? { errors } : {}),
          ...(notFound.length ? { not_found: notFound } : {}),
        };
      }
      default:
        return {
          error: `Unknown action "${action}". Available: group / ungroup / activate / move / pin / unpin / reload / back / forward`,
        };
    }
  },
});
