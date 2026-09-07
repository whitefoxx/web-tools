/**
 * The browser-side entry points of the knowledge-base features: a context
 * menu, two keyboard commands and the popup buttons all funnel into
 * `captureToInbox`, which turns "the user pressed a thing on this page" into an
 * inbox item and makes sure localmd hears about it (src/localmd-connect/inbox.ts).
 *
 * Two behaviours on purpose:
 *   • a CLIP keeps the user where they are. localmd gets a poke if a tab of it
 *     is open; if none is, one opens in the BACKGROUND so the item is written
 *     soon rather than on some future visit. The badge count is the visible
 *     receipt either way.
 *   • an ASK moves the user to localmd (focus, opening it if needed) — the
 *     whole point is to start talking, and the conversation happens there,
 *     with the KB in context, never in an overlay on the page.
 */
import { makeInboxItem, putInboxItem, type InboxItem } from './inbox';
import { clipTab, type ClipPayload, type PdfClipPayload } from './clip';
import { captureFullPageOnTab, captureRegionOnTab } from './region-shot';

export type CaptureAction =
  | 'clip_page'
  | 'clip_selection'
  | 'ask_page'
  | 'ask_selection'
  | 'screenshot_region'
  | 'screenshot_page';

export const MENU_IDS: Record<CaptureAction, string> = {
  clip_page: 'localmd-clip-page',
  clip_selection: 'localmd-clip-selection',
  ask_page: 'localmd-ask-page',
  ask_selection: 'localmd-ask-selection',
  screenshot_region: 'localmd-screenshot-region',
  screenshot_page: 'localmd-screenshot-page',
};

export const COMMAND_IDS: Record<string, CaptureAction> = {
  'clip-page': 'clip_page',
  'ask-localmd': 'ask_page',
  'screenshot-region': 'screenshot_region',
  'screenshot-page': 'screenshot_page',
};

/** Menu id → action (pure). */
export function actionForMenuId(id: unknown): CaptureAction | null {
  for (const [action, menuId] of Object.entries(MENU_IDS)) {
    if (menuId === id) return action as CaptureAction;
  }
  return null;
}

/** (Re)create the context menu. Menus persist across SW restarts, so this
 * runs on onInstalled only; removeAll first keeps an update from stacking
 * duplicates. */
export async function installCaptureMenus(): Promise<void> {
  await new Promise<void>((resolve) => chrome.contextMenus.removeAll(() => resolve()));
  const pageCtx: chrome.contextMenus.ContextType[] = ['page', 'frame', 'link', 'image'];
  chrome.contextMenus.create({
    id: MENU_IDS.clip_page,
    title: 'Clip page to localmd',
    contexts: pageCtx,
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
  chrome.contextMenus.create({
    id: MENU_IDS.ask_page,
    title: 'Chat in localmd about this page',
    contexts: pageCtx,
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
  chrome.contextMenus.create({
    id: MENU_IDS.screenshot_page,
    title: 'Screenshot the whole page to localmd',
    contexts: pageCtx,
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
  chrome.contextMenus.create({
    id: MENU_IDS.screenshot_region,
    title: 'Screenshot a region to localmd',
    contexts: pageCtx,
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
  chrome.contextMenus.create({
    id: MENU_IDS.clip_selection,
    title: 'Clip selection to localmd',
    contexts: ['selection'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
  chrome.contextMenus.create({
    id: MENU_IDS.ask_selection,
    title: 'Chat in localmd about this selection',
    contexts: ['selection'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
}

/** The user's current tab — the active tab of the last focused window. */
export async function userActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab && typeof tab.id === 'number' ? tab : null;
}

function isClippable(tab: chrome.tabs.Tab): boolean {
  return /^https?:\/\//.test(tab.url ?? '');
}

/**
 * Capture from `tab` into the inbox. Returns the stored item; throws with a
 * user-readable message when the page cannot be captured (a chrome:// page, no
 * selection). `selectionText` is the menu's own copy of the selection, used
 * for an ask when the page script cannot run.
 */
/** What an "ask" carries besides the passage: the prompt that was run on it and
 *  the answer that came back, when the user is continuing from one. Optional on
 *  the wire — an older localmd ignores them and opens the conversation with the
 *  passage alone. */
export interface AskContext {
  prompt?: string;
  answer?: string;
}

export async function captureToInbox(
  action: CaptureAction,
  tab: chrome.tabs.Tab,
  selectionText?: string,
  context?: AskContext,
): Promise<InboxItem> {
  if (!isClippable(tab)) throw new Error('Only http(s) pages can be captured');
  const tabId = tab.id!;
  const url = tab.url ?? '';
  const title = tab.title ?? url;
  if (action === 'clip_page' || action === 'clip_selection') {
    const clip: ClipPayload | PdfClipPayload = await clipTab(tabId, {
      mode: action === 'clip_selection' ? 'selection' : 'article',
      images: 'inline',
    });
    const item = makeInboxItem('clip', {
      url: clip.url || url,
      title: clip.title || title,
      tabId,
      payload: clip,
    });
    await putInboxItem(item);
    return item;
  }
  if (action === 'screenshot_page') {
    const shot = await captureFullPageOnTab(tabId);
    const item = makeInboxItem('screenshot', {
      url,
      title,
      tabId,
      payload: { ...shot, page_title: title, page_url: url },
    });
    await putInboxItem(item);
    return item;
  }
  if (action === 'screenshot_region') {
    const shot = await captureRegionOnTab(tab);
    // Cancelled, or downloaded instead: nothing for the inbox, and not an error.
    if (!shot) throw new Error('cancelled');
    const item = makeInboxItem('screenshot', {
      url,
      title,
      tabId,
      payload: { ...shot, page_title: title, page_url: url },
    });
    await putInboxItem(item);
    return item;
  }
  const selection = action === 'ask_selection' ? (selectionText ?? '').trim() : '';
  const prompt = context?.prompt?.trim();
  const answer = context?.answer?.trim();
  const item = makeInboxItem('ask', {
    url,
    title,
    tabId,
    payload: {
      ...(selection ? { selection } : {}),
      // Carried so the conversation starts where the reader already is rather
      // than from the passage again: they have read an answer, and what they
      // want next is the NEXT thing about it.
      ...(prompt ? { prompt } : {}),
      ...(answer ? { answer } : {}),
    },
  });
  await putInboxItem(item);
  return item;
}

/**
 * Find an open localmd tab, preferring the one in the focused window.
 *
 * `origins` must be the origins localmd ITSELF is served from, not the origins
 * allowed to reach the extension. Those are different lists — the dev build's
 * allowlist also carries this repo's fixture server, and handing that list here
 * made "Ask localmd" focus a test page.
 */
export async function findLocalmdTab(origins: string[]): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: origins.map((o) => `${o}/*`) });
  if (!tabs.length) return null;
  const focused = await chrome.windows.getLastFocused().catch(() => null);
  const inFocused = tabs.filter((t) => t.windowId === focused?.id);
  // Only ever one origin per build (see LOCALMD_APP_ORIGINS), so this is a
  // choice between tabs of the SAME app: the one in the window they are looking
  // at, else the one they used most recently. `tabs[0]` is whatever order the
  // query returned, which is the oldest and therefore the least likely answer.
  return mostRecent(inFocused.length ? inFocused : tabs);
}

function mostRecent(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab {
  // `lastAccessed` needs Chrome 121; this extension requires 138, but a tab
  // that has never been activated may still not carry one.
  return tabs.reduce((best, t) =>
    ((t as { lastAccessed?: number }).lastAccessed ?? 0) >
    ((best as { lastAccessed?: number }).lastAccessed ?? 0)
      ? t
      : best,
  );
}

/**
 * Make sure a localmd tab exists; `focus` brings it (and its window) to the
 * front. Opens the FIRST origin (the shipping one) when none is open. Returns
 * whether a tab had to be opened — the caller uses it to know a poke could
 * not have been heard yet.
 *
 * Same contract as findLocalmdTab: these are localmd's OWN origins.
 */
export async function ensureLocalmdTab(
  origins: string[],
  focus: boolean,
): Promise<{ tab: chrome.tabs.Tab; opened: boolean }> {
  const existing = await findLocalmdTab(origins);
  if (existing && typeof existing.id === 'number') {
    if (focus) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
    return { tab: existing, opened: false };
  }
  const tab = await chrome.tabs.create({ url: `${origins[0]}/`, active: focus });
  return { tab, opened: true };
}

/** Paint the pending count on the toolbar icon (empty text clears it). */
export function paintInboxBadge(count: number): void {
  try {
    void chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count > 0) void chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  } catch {
    /* no action API in this context */
  }
}
