/**
 * Dedicated "agent window" — isolate agent-opened tabs from the user's window.
 *
 * Every tab web-agent opens — site-adapter pool tabs (dispatcher), the
 * explore tab, and `generic__open_url` tabs — goes into ONE separate Chrome
 * window, so agent tabs never mix into the window the user is working in. Shared
 * by BOTH the bridge (external control) and the SidePanel agent, since both create tabs
 * through the same seams (dispatcher tab pool / open-url / explore).
 *
 * Lazy + best-effort: the window is created on the first agent tab and reused
 * after; if the user closes it we forget the id and make a fresh one next time.
 * A placeholder `about:blank` (adopted into the "Web Agent" tab group, so the
 * window stays labeled) keeps the window alive between tasks — the reaper closes
 * the agent's content tabs, the placeholder stays, so the window doesn't churn
 * open/closed every task.
 *
 * The id is ALSO persisted to `chrome.storage.session` (survives SW restarts,
 * cleared on browser close — exactly the window's lifetime). MV3 kills the SW on
 * idle, so without this the next task would forget the in-memory id and leak a
 * fresh empty agent window every restart. On the first call after a restart we
 * recall the id, revalidate it, and re-adopt the existing window + its tabs.
 *
 * Nothing here touches `chrome.*` at module load (only inside the async helpers /
 * lazily-installed listener), so this stays importable in node tests.
 */

import {
  adoptTab,
  recoverWindowTracking,
  findAgentGroupWindow,
  reapOrphanAgentWindows,
} from './controlled-tabs';

const WINDOW_ID_KEY = 'agentWindowId';

/** The shared agent window's id, if one is currently alive. */
let agentWindowId: number | undefined;
/** Guards concurrent creates (parallel pre-run opens many tabs at once). */
let creating: Promise<number> | null = null;
let hooked = false;
/** Reap leaked duplicate agent windows once per SW life, on the first ensure. */
let reapedThisLife = false;

/** Fire-and-forget: collapse any leaked duplicate agent windows, sparing the one
 * we just resolved. Runs once per SW lifetime (the first agent tab of a task) so
 * same-named-group duplicates that appeared while the SW was down get cleaned as
 * soon as the agent next works. */
function maybeReapOrphans(): void {
  if (reapedThisLife) return;
  reapedThisLife = true;
  void reapOrphanAgentWindows(agentWindowId).catch(() => {});
}

function persistWindowId(id: number | undefined): void {
  try {
    if (id === undefined) void chrome.storage?.session?.remove(WINDOW_ID_KEY);
    else void chrome.storage?.session?.set({ [WINDOW_ID_KEY]: id });
  } catch {
    /* storage.session may be unavailable (tests) — recovery just no-ops */
  }
}

async function recallWindowId(): Promise<number | undefined> {
  try {
    const got = await chrome.storage.session.get(WINDOW_ID_KEY);
    const id = got[WINDOW_ID_KEY];
    return typeof id === 'number' ? id : undefined;
  } catch {
    return undefined;
  }
}

function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  // User closed the agent window → forget its id so we recreate next time.
  chrome.windows?.onRemoved?.addListener((wid) => {
    if (wid === agentWindowId) {
      agentWindowId = undefined;
      persistWindowId(undefined);
    }
  });
}

/** The live agent window id, or undefined if none exists yet (no async probe).
 * Used by the tab pool to scope tab-reuse to the agent window only. */
export function getAgentWindowId(): number | undefined {
  return agentWindowId;
}

/** Resolve the agent window id — recovering it across an MV3 SW restart (the
 * in-memory id is gone but the window + its "Web Agent" group persist), else
 * creating a fresh one. Exported so the tab pool can AWAIT recovery before
 * scoping tab-reuse to the window: `getAgentWindowId()` is sync and returns
 * undefined until this runs, which would make the pool skip the window's existing
 * tabs and open duplicates after a restart (see dispatcher findExisting). */
export async function ensureAgentWindowId(): Promise<number> {
  ensureHooks();
  // Recover across an MV3 SW restart: the in-memory id is gone but the window (+
  // its tabs/group) persists. Re-adopt it instead of leaking a fresh empty one.
  // Idempotent + recovery skips once the window is known, so concurrent callers
  // and the create single-flight below stay correct.
  if (agentWindowId === undefined && !creating) {
    // Recall the persisted id (fast path). If it's missing — storage.session can
    // be lost across an MV3 SW restart, the suspected window-leak cause — fall back
    // to Chrome's OWN durable marker, the "Web Agent" tab group, and re-adopt
    // that existing window instead of leaking a fresh empty one every restart.
    const candidate = (await recallWindowId()) ?? (await findAgentGroupWindow());
    if (candidate !== undefined) {
      try {
        await chrome.windows.get(candidate);
        agentWindowId = candidate;
        persistWindowId(candidate);
        await recoverWindowTracking(candidate);
      } catch {
        persistWindowId(undefined); // the candidate window is gone
      }
    }
  }
  if (agentWindowId !== undefined) {
    try {
      await chrome.windows.get(agentWindowId);
      maybeReapOrphans();
      return agentWindowId;
    } catch {
      agentWindowId = undefined; // window is gone — fall through to recreate
      persistWindowId(undefined);
    }
  }
  if (creating) return creating;
  creating = (async () => {
    // Remember the user's foreground window so a background agent-window create
    // can't steal focus: Chrome/macOS surfaces a newly-created window on top even
    // with focused:false, so we yank focus back to the user's window afterward.
    let prevFocused: number | undefined;
    try {
      prevFocused = (await chrome.windows.getLastFocused()).id;
    } catch {
      /* no focused window to preserve — nothing to restore */
    }
    const win = await chrome.windows.create({ url: 'about:blank', focused: false });
    if (win.id === undefined) throw new Error('agent window created without an id');
    agentWindowId = win.id;
    persistWindowId(win.id);
    if (prevFocused !== undefined && prevFocused !== win.id) {
      try {
        await chrome.windows.update(prevFocused, { focused: true });
      } catch {
        /* the user's window may be gone — best-effort */
      }
    }
    // Adopt the placeholder so the window carries the "Web Agent" group label
    // even when idle (and reads as controlled in list_tabs).
    const placeholder = win.tabs?.[0]?.id;
    if (typeof placeholder === 'number') {
      try {
        await adoptTab(placeholder);
      } catch {
        /* grouping is best-effort */
      }
    }
    maybeReapOrphans();
    return win.id;
  })().finally(() => {
    creating = null;
  });
  return creating;
}

/** chrome.tabs.create failed because the target window is gone (user closed the
 * agent window, or it vanished between our probe and the create). */
function isMissingWindowError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /No window with id|no current window|No tab with id/i.test(msg);
}

/** Open a background tab at `url` inside the dedicated agent window (creating the
 * window lazily). Same return shape as `chrome.tabs.create` so callers can still
 * `adoptTab(tab.id)` afterwards. When `active`, the tab is activated in the agent
 * window and the window is brought to the front (so an explicit open_url is
 * actually visible); otherwise it opens in the background and never steals focus.
 *
 * Self-healing: the agent window can disappear at any moment (the user may close
 * it; `onRemoved` can lag; there's an inherent probe→create race). If the create
 * reports the window is gone, we forget the stale id and retry once in a fresh
 * window. */
export async function createAgentTab(
  url: string,
  opts: { active?: boolean } = {},
): Promise<chrome.tabs.Tab> {
  for (let attempt = 0; ; attempt++) {
    const windowId = await ensureAgentWindowId();
    try {
      const tab = await chrome.tabs.create({ url, active: opts.active ?? false, windowId });
      if (opts.active) {
        try {
          await chrome.windows.update(windowId, { focused: true });
        } catch {
          /* best-effort focus */
        }
      }
      return tab;
    } catch (e) {
      if (attempt === 0 && isMissingWindowError(e)) {
        if (agentWindowId === windowId) {
          agentWindowId = undefined; // stale → recreate on retry
          persistWindowId(undefined);
        }
        continue;
      }
      throw e;
    }
  }
}

/** Boot-time cleanup (SW start / extension reload): collapse leaked duplicate
 * agent windows down to at most the one we still track. Spares the in-memory id
 * if a task already opened one this life, else the persisted id (validated) so an
 * SW *wake* mid-session doesn't kill an in-flight window; on a browser restart
 * (storage.session cleared) it spares nothing — every stale agent window closes
 * and the next task opens one fresh. Best-effort; returns #windows closed. */
export async function reapLeakedAgentWindowsOnBoot(): Promise<number> {
  let spare = agentWindowId ?? (await recallWindowId());
  if (spare !== undefined) {
    try {
      await chrome.windows.get(spare);
    } catch {
      if (spare === (await recallWindowId())) persistWindowId(undefined);
      spare = undefined; // the tracked window is already gone
    }
  }
  reapedThisLife = true; // the lazy per-life pass is now redundant
  return reapOrphanAgentWindows(spare);
}

/**
 * Close the agent window once the only thing left in it is the `about:blank`
 * placeholder — the tail of the cleanup, for the shells that have no reason to
 * keep an empty window standing.
 *
 * The placeholder exists so the window survives BETWEEN tasks instead of
 * churning open and closed around each one (see the file header), and in the
 * full extension that is the right trade: a SidePanel task can start at any
 * moment, with its user right there watching. The headless shells are the other
 * case entirely — an external agent goes quiet for hours, and what it leaves
 * behind is a whole extra Chrome window holding one blank tab in a coloured tab
 * group, which is exactly the leftover a user reads as "it never cleaned up".
 * Re-opening the window on the next call costs a fraction of a second.
 *
 * Only `about:blank` counts as empty. A tab that is still LOADING reports an
 * empty `url` with its destination in `pendingUrl`, so treating "no url" as
 * blank would close a window around a page that was still on its way. Returns
 * whether the window was closed.
 */
export async function closeIdleAgentWindow(): Promise<boolean> {
  const windowId = agentWindowId ?? (await recallWindowId());
  if (windowId === undefined) return false;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch {
    return false; // window already gone
  }
  const blank = (t: chrome.tabs.Tab): boolean =>
    t.url === 'about:blank' || t.pendingUrl === 'about:blank';
  if (!tabs.length || !tabs.every(blank)) return false;
  try {
    await chrome.windows.remove(windowId);
  } catch {
    return false; // raced with a close — the onRemoved hook cleans up
  }
  if (agentWindowId === windowId) agentWindowId = undefined;
  if ((await recallWindowId()) === windowId) persistWindowId(undefined);
  return true;
}

/** Test-only: reset module state between cases. */
export function __resetAgentWindow(): void {
  agentWindowId = undefined;
  creating = null;
  hooked = false;
  reapedThisLife = false;
}
