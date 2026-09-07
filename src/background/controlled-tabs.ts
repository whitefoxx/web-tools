/**
 * Controlled-tab registry (roadmap F1) + tab grouping (T1).
 *
 * Tracks which tabs web-agent opened / drives, and collects them into a
 * named, colored Chrome tab group so the user can tell agent-controlled tabs
 * apart from their own. Every tab the agent opens (the explore tab, tabs from
 * `generic__open_url`, and site-pool tabs in the agent window) is adopted here.
 *
 * Grouping is WINDOW-AWARE: tab groups are window-scoped in Chrome, and
 * `chrome.tabs.group`'s createProperties.windowId defaults to the *current*
 * window — worse, joining a group MOVES the tab into the group's window. With a
 * single global group id, a tab opened in the dedicated agent window would get
 * yanked back into the user's window, and an agent window whose only tab was
 * moved out closes itself (→ stale window id, "No window with id" on the next
 * create). So we keep one group per window and always create the group in the
 * tab's own window. See src/background/agent-window.ts.
 *
 * Foundation reused later by "list/search my tabs" (T4) and external control
 * (T7). All in-memory (SW lifetime); the groups themselves persist in Chrome
 * until their tabs close. Grouping is best-effort — the registry still works if
 * the `tabGroups` permission/API is unavailable.
 */

const DEFAULT_GROUP_TITLE = 'Web Agent';
const GROUP_COLOR: chrome.tabGroups.ColorEnum = 'blue';
/** Legacy titles still recognized for a given current title. 'WebChat Agent' is
 * the pre-rename name (commit 40d565c): pre-rename groups (+ their windows) must
 * still be recognized for recovery + orphan cleanup, or they linger forever as
 * un-adoptable duplicates. Keyed by title so the WebCLI shell does NOT inherit
 * the full shell's aliases. A reused legacy group is normalized in addToGroup. */
const LEGACY_TITLES: Readonly<Record<string, readonly string[]>> = {
  'Web Agent': ['WebChat Agent'],
};

/**
 * A store `name` and a tab-strip label want opposite things. The store name sells
 * the extension to someone who has never seen it ("WebCLI - Browser Control for
 * Agents"); a tab GROUP title is rendered inline in the tab strip, where 30-odd
 * characters is a wall that shoves every tab off screen. So the label is the
 * manifest name UP TO the first dash separator — descriptive in the store, short
 * in the strip.
 *
 * The happy accident worth keeping: the leading token is exactly what the name was
 * BEFORE it gained a descriptor, so groups created by older builds are still
 * titled "WebCLI", still adopted, still reaped. Renaming the extension needs no
 * migration as long as the part before the dash holds still — which is also why
 * a rename that changes that token DOES need a LEGACY_TITLES entry.
 */
function shortLabel(name: string): string {
  return name.split(/\s+[-–—]\s+/)[0].trim() || name.trim();
}

/**
 * The group label is THIS EXTENSION'S NAME (shortened as above) — "Web Agent" for
 * the full shell, "WebCLI" for the pure-bridge shell, "WebCLI (dev)" for its
 * dev-identity build (docs/webcli.md §13).
 *
 * Tab groups are BROWSER-global, not per-extension: `tabGroups.query` sees every
 * group in the browser and `windows.remove` closes any window. With both shells
 * sharing one title, each shell's orphan reaper (reapOrphanAgentWindows, which
 * runs once per SW life on the first agent tab) saw the OTHER shell's agent
 * window as a leaked duplicate and closed it — killing tabs an external agent was
 * mid-session on ("tab N no longer exists (closed?)" on the next scroll_page).
 * Per-shell titles keep the two invisible to each other, and the user sees which
 * extension is driving which window.
 *
 * Lazy + memoized: the manifest read must not happen at module load (this file is
 * imported by node tests with a partial `chrome` mock); the fallback keeps
 * behavior identical wherever the manifest is unavailable.
 */
/**
 * The same string, for anything else that must name THIS shell to the user —
 * today the "is working" badge the cockpit overlay paints on a driven page
 * (tools/generic/_agent-cursor.ts). Deliberately one source: a second hardcoded
 * product name is how the badge ended up telling localmd Connect's users that
 * "Web Agent" was driving their browser.
 */
export function productShortName(): string {
  return groupTitle();
}

let cachedGroupTitle: string | null = null;
function groupTitle(): string {
  if (cachedGroupTitle !== null) return cachedGroupTitle;
  let title = DEFAULT_GROUP_TITLE;
  try {
    const name = chrome.runtime?.getManifest?.()?.name;
    if (typeof name === 'string' && name.trim()) title = shortLabel(name);
  } catch {
    /* no manifest (tests) — keep the default */
  }
  cachedGroupTitle = title;
  return title;
}

/** Titles that mark a tab group as owned by THIS shell (current + its legacy
 * aliases). Never includes the other shell's title — see groupTitle(). */
function agentGroupTitles(): readonly string[] {
  const t = groupTitle();
  return [t, ...(LEGACY_TITLES[t] ?? [])];
}

/** tabIds the agent controls. */
const controlled = new Set<number>();
/** The live "Web Agent" group id in each window (groups are window-scoped). */
const groupIdByWindow = new Map<number, number>();
let hooked = false;

/** All agent-owned tab groups (any recognized title), optionally scoped to one
 * window. `tabGroups.query`'s `title` is an exact match and can't take a set, so
 * we query all and filter — the group count is tiny. [] if the API is missing. */
async function queryAgentGroups(windowId?: number): Promise<chrome.tabGroups.TabGroup[]> {
  if (!chrome.tabGroups) return [];
  const all = await chrome.tabGroups.query(windowId !== undefined ? { windowId } : {});
  const titles = agentGroupTitles();
  return all.filter((g) => titles.includes(g.title ?? ''));
}

function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  // Prune closed tabs so the registry doesn't leak / report stale ids.
  chrome.tabs.onRemoved.addListener((tabId) => controlled.delete(tabId));
  // Chrome auto-removes an empty group; forget its id so we recreate next time.
  chrome.tabGroups?.onRemoved?.addListener((g) => {
    for (const [windowId, gid] of groupIdByWindow) {
      if (gid === g.id) groupIdByWindow.delete(windowId);
    }
  });
  // A whole window closing → drop its group entry. The per-tab/per-group removed
  // events usually self-clean, but bulk teardown may not emit them reliably.
  chrome.windows?.onRemoved?.addListener((windowId) => groupIdByWindow.delete(windowId));
}

async function addToGroup(tabId: number, windowId: number): Promise<void> {
  let existing = groupIdByWindow.get(windowId);
  let existingTitle: string | undefined;
  if (existing === undefined) {
    // After an MV3 SW restart the in-memory map is empty, but an agent group may
    // ALREADY exist in this window — reuse it instead of spawning a duplicate
    // (the root cause of the same-named-group pile-up). Also adopts a legacy
    // "WebChat Agent" group so it gets consolidated + relabeled below.
    const groups = await queryAgentGroups(windowId);
    if (groups[0] !== undefined) {
      existing = groups[0].id;
      existingTitle = groups[0].title;
    }
  }
  // Joining an existing group is only safe when that group lives in the tab's
  // own window (guaranteed here: the map is keyed by window). When creating,
  // pin the new group to the tab's window — otherwise Chrome defaults to the
  // current window and MOVES the tab there (see file header).
  const gid = await chrome.tabs.group(
    existing !== undefined
      ? { groupId: existing, tabIds: tabId }
      : { tabIds: tabId, createProperties: { windowId } },
  );
  groupIdByWindow.set(windowId, gid);
  // Label a freshly-created group, or normalize a reused LEGACY-named one — but
  // not a group we reused from the in-memory map (existingTitle undefined), which
  // is already ours and correctly labeled (avoids a redundant update per adopt).
  const title = groupTitle();
  if (gid !== existing || (existingTitle !== undefined && existingTitle !== title)) {
    await chrome.tabGroups.update(gid, { title, color: GROUP_COLOR });
  }
}

async function groupTab(tabId: number): Promise<void> {
  if (!chrome.tabGroups) return; // permission/flag missing — skip grouping, keep tracking
  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;
  try {
    await addToGroup(tabId, windowId);
  } catch {
    // Stale group id for this window (its tabs all closed) — drop and recreate once.
    groupIdByWindow.delete(windowId);
    await addToGroup(tabId, windowId);
  }
}

/** Mark a tab as agent-controlled and add it to the Web Agent tab group
 * of its own window. */
export async function adoptTab(tabId: number): Promise<void> {
  ensureHooks();
  controlled.add(tabId);
  try {
    await groupTab(tabId);
  } catch {
    /* grouping is best-effort (tab gone, permission missing, …) */
  }
}

/** After an MV3 SW restart the in-memory registry is empty, but the agent window
 * (its "Web Agent" group + tabs) still exists in Chrome. Rebuild tracking for
 * `windowId`: re-seed the group id (so we rejoin it instead of spawning a
 * duplicate group) and re-mark its tabs controlled. Best-effort. */
export async function recoverWindowTracking(windowId: number): Promise<void> {
  ensureHooks();
  try {
    const groups = await queryAgentGroups(windowId);
    if (groups[0]?.id !== undefined) groupIdByWindow.set(windowId, groups[0].id);
    const tabs = await chrome.tabs.query({ windowId });
    for (const t of tabs) if (typeof t.id === 'number') controlled.add(t.id);
  } catch {
    /* best-effort — registry simply stays empty until the next adopt */
  }
}

/** Find an existing agent window by its durable "Web Agent" tab group —
 * Chrome's OWN marker, which survives MV3 SW restarts independently of our
 * in-memory id / `storage.session`. Lets `ensureAgentWindowId` re-adopt the
 * existing window instead of leaking a fresh one when the persisted id is missing
 * (the suspected window-leak cause). Returns the group's windowId (the agent
 * window only ever holds agent tabs, so the group is unique to it), or undefined
 * if there's no agent group / the API is unavailable. */
export async function findAgentGroupWindow(): Promise<number | undefined> {
  try {
    const groups = await queryAgentGroups();
    const wid = groups[0]?.windowId;
    return typeof wid === 'number' ? wid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Close leaked / orphan agent windows — the fix for the same-named tab-group
 * pile-up. Agent tabs live in a dedicated background window (agent-window.ts)
 * kept alive by an `about:blank` placeholder, so a window that leaks (recovery
 * missed it — after the group-title rename, or a lost storage.session id) never
 * dies on its own and its "Web Agent" group lingers in Chrome's tab-group list
 * forever.
 *
 * Finds every window carrying an agent-titled group and closes those that are
 * NOT `spareWindowId` and are PURELY agent-owned — every tab is either in an
 * agent group or a blank placeholder. A window holding ANY foreign tab is spared
 * (safety valve: the user never puts their own tabs in the agent window, but if
 * one ever ends up there we never yank it). Best-effort; returns #windows closed.
 */
export async function reapOrphanAgentWindows(spareWindowId?: number): Promise<number> {
  if (!chrome.tabGroups || !chrome.windows) return 0;
  let closed = 0;
  try {
    const groups = await queryAgentGroups();
    const agentGroupIds = new Set(groups.map((g) => g.id));
    const windowIds = new Set(
      groups.map((g) => g.windowId).filter((w): w is number => typeof w === 'number'),
    );
    for (const wid of windowIds) {
      if (wid === spareWindowId) continue;
      let tabs: chrome.tabs.Tab[];
      try {
        tabs = await chrome.tabs.query({ windowId: wid });
      } catch {
        continue; // window vanished between query and now
      }
      if (tabs.length === 0) continue;
      const pureAgent = tabs.every(
        (t) =>
          (typeof t.groupId === 'number' && agentGroupIds.has(t.groupId)) ||
          t.url === '' ||
          t.url === 'about:blank' ||
          t.pendingUrl === 'about:blank',
      );
      if (!pureAgent) continue; // a foreign tab lives here — never close this window
      try {
        await chrome.windows.remove(wid);
        groupIdByWindow.delete(wid);
        for (const t of tabs) if (typeof t.id === 'number') controlled.delete(t.id);
        closed++;
      } catch {
        /* raced with a close — fine */
      }
    }
  } catch {
    /* best-effort — leaked windows just get cleaned on a later pass */
  }
  return closed;
}

/** Stop tracking a tab (does not close or ungroup it). */
export function releaseTab(tabId: number): void {
  controlled.delete(tabId);
}

/** Is this tab one the agent controls? */
export function isControlled(tabId: number): boolean {
  return controlled.has(tabId);
}

/** Snapshot of currently-controlled tab ids. */
export function controlledTabIds(): number[] {
  return [...controlled];
}

/** Test-only: reset module state between cases. */
export function __resetControlledTabs(): void {
  controlled.clear();
  groupIdByWindow.clear();
  hooked = false;
  cachedGroupTitle = null; // re-read the (mocked) manifest name per case
}
