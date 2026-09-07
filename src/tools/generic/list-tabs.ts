import { cli } from '../../runtime/registry.js';
import { isControlled } from '../../background/controlled-tabs';

/**
 * List the user's currently-open tabs (id / title / url / active / whether the
 * agent controls it). Backs "show me which tabs I have open", "find … in my tabs",
 * "summarize all the pages I have open". Pair with get_page_text to read any of them.
 * (Roadmap T2; also the basis for tab search in T4.)
 */
cli({
  site: 'generic',
  name: 'list_tabs',
  access: 'read',
  local: true,
  description:
    'List all currently open tabs (tabId / title / URL / windowId / active / pinned / group / whether controlled by this extension), with a groups list when groups exist. Use for "show me which tabs I have open", "find the one about X in my tabs", "summarize all the pages I have open"; also the entry point for checking the current state before manage_tabs (group/move/focus, etc.). Once you have a tabId, use get_page_text to grab its body text.',
  args: [
    {
      name: 'query',
      type: 'string',
      help: 'Optional: filter by whether the title or URL contains this keyword (case-insensitive)',
    },
    {
      name: 'current_window',
      type: 'bool',
      help: 'List only tabs in the current window; default false (all windows)',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const q = typeof kwargs.query === 'string' ? kwargs.query.trim().toLowerCase() : '';
    const tabs = await chrome.tabs.query(kwargs.current_window ? { currentWindow: true } : {});
    const rows = tabs
      .filter((t) => typeof t.id === 'number')
      .map((t) => ({
        tabId: t.id as number,
        title: t.title ?? '',
        url: t.url ?? '',
        windowId: t.windowId,
        active: !!t.active,
        // Sparse flags keep the per-tab × N payload lean for the model.
        ...(t.pinned ? { pinned: true } : {}),
        ...(typeof t.groupId === 'number' && t.groupId !== -1 ? { groupId: t.groupId } : {}),
        controlled: isControlled(t.id as number),
      }))
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.url.toLowerCase().includes(q));
    // Existing tab groups (name/color/window) so manage_tabs can extend/reuse them
    // instead of creating duplicates. tabGroups may be unavailable (old Chrome).
    let groups: { id: number; title: string; color: string; windowId: number }[] = [];
    try {
      groups =
        (await chrome.tabGroups?.query?.({}))?.map((g) => ({
          id: g.id,
          title: g.title ?? '',
          color: String(g.color ?? ''),
          windowId: g.windowId,
        })) ?? [];
    } catch {
      /* tabGroups unavailable — rows still carry groupId */
    }
    return { count: rows.length, tabs: rows, ...(groups.length ? { groups } : {}) };
  },
});
