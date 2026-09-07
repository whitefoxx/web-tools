import { cli } from '../../runtime/registry.js';
import { isControlled } from '../../background/controlled-tabs';

/**
 * Resolve the tab the USER is currently looking at (active tab of the last
 * focused window), so requests like "summarize this page" / "this page…" have a
 * concrete target. Skips the extension's own agent-controlled tabs (T1 group).
 * Pair with get_page_text to read it. (Roadmap T2.)
 */
cli({
  site: 'generic',
  name: 'get_active_tab',
  access: 'read',
  local: true,
  description:
    'Return the tabId / title / URL of the tab the user is currently looking at (the active tab of the most recently focused window). Use it for requests that refer to the current page, like "summarize this page" or "this page…" — once you have the tabId, read the body with get_page_text. Skips tabs this extension controls itself.',
  args: [],
  func: async () => {
    // Only a tab the USER owns counts — never fall back to an agent-controlled
    // tab (e.g. the explore about:blank), or "summarize this page" targets us.
    const pick = (tabs: chrome.tabs.Tab[]): chrome.tabs.Tab | undefined =>
      tabs.find((t) => typeof t.id === 'number' && !isControlled(t.id));
    let tab = pick(await chrome.tabs.query({ active: true, lastFocusedWindow: true }));
    if (!tab) tab = pick(await chrome.tabs.query({ active: true }));
    if (!tab || typeof tab.id !== 'number') {
      return { error: 'No active user tab found (the current active tab may be one this extension controls)' };
    }
    return { tabId: tab.id, title: tab.title ?? '', url: tab.url ?? '' };
  },
});
