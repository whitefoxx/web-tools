import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';

cli({
  site: 'generic',
  name: 'close_tab',
  access: 'read',
  local: true,
  description:
    'Close a tab you no longer need — dozens of open tabs slow the browser down, so drop pages as you finish with them rather than letting a long job pile them up. (A one-shot read never needs this: `get_page_text {url}` disposes of its own tab and tells you so with `tab_closed:true`.)',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help: 'The tab id to close',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    await chrome.tabs.remove(tab.id!);
    return { tabId: tab.id, closed: true };
  },
});
