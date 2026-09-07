import { cli } from '../../runtime/registry.js';
import { assertHttpUrl } from './_helpers';
import { getActiveExploreSession } from '../../core/explore-gate';
import { adoptTab } from '../../background/controlled-tabs';
import { createAgentTab } from '../../background/agent-window';
import { fetchLlmsTxt } from './llms-txt';

/** Registrable second-level site label from a hostname. chat.deepseek.com →
 * deepseek, www.zhihu.com → zhihu, m.example.com → example, weibo.com.cn →
 * weibo, example.co.uk → example. Heuristic (no public-suffix list): drop a
 * leading www, take the second-to-last label, stepping back once more past a
 * known two-part suffix. */
export function siteFromHost(hostname: string): string {
  const labels = hostname
    .replace(/^www\./i, '')
    .split('.')
    .filter(Boolean);
  if (labels.length <= 2) return labels[0] || hostname;
  const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);
  const sld = labels[labels.length - 2];
  if (SECOND_LEVEL.has(sld) && labels.length >= 3) return labels[labels.length - 3];
  return sld;
}

cli({
  site: 'generic',
  name: 'open_url',
  access: 'read',
  description:
    'Open a URL in a new tab and LEAVE IT OPEN — for when you will then act on the page (get_interactives → click / type_into / scroll_page) or want to show it to the user. Returns the `tabId` those tools take. **If all you need is the page CONTENT, do not open it first — call `get_page_text {url}` instead: it opens, waits, reads and cleans up in one call** (and `get_page_text {url, keep_open:true}` gives you the text AND a live tabId, so "read then act" is also one call). active:true brings the tab to the foreground for the user to look at; default false opens it in the background.',
  args: [
    {
      name: 'url',
      type: 'string',
      required: true,
      help: 'The full URL to open (must start with http:// or https://)',
    },
    {
      name: 'active',
      type: 'bool',
      help: 'Whether to bring the tab to the foreground. Default false = open in the background and work there; true = put the page in front of the user to look at (use it only when showing them something, not for your own reading)',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const url = assertHttpUrl(kwargs.url);
    const active = !!kwargs.active;
    // During an explore session, navigate the dedicated explore tab instead of
    // spawning a new one, so the session-wide network capture stays on it and
    // the synthesized adapter targets a single, stable tab.
    const session = getActiveExploreSession();
    if (session) {
      // Resolve the site from the host once so site memory + adapter naming have
      // a stable identifier. Take the registrable second-level label (not the
      // first), so chat.deepseek.com / www.zhihu.com / m.example.com → deepseek
      // / zhihu / example (handles two-part suffixes like .com.cn / .co.uk).
      try {
        const site = siteFromHost(new URL(url).hostname);
        if (site) session.setSite(site);
      } catch {
        /* non-fatal */
      }
      await chrome.tabs.update(session.tabId, { url, ...(active ? { active: true } : {}) });
      return { tabId: session.tabId, url, active, explore: true };
    }
    // Zero-config site hint (⑥): fetch the origin's /llms.txt in PARALLEL with the
    // tab creation (cached per origin), so a site that publishes an LLM guide hands
    // the model a map up front. Only attached when actually found — most sites 404
    // (cached), so this adds nothing to the result for them.
    const [tab, llmsTxt] = await Promise.all([createAgentTab(url, { active }), fetchLlmsTxt(url)]);
    // F1/T1: tabs the agent opens go into the Web Agent tab group, so the
    // user can tell them apart from their own.
    if (typeof tab.id === 'number') await adoptTab(tab.id);
    return {
      tabId: typeof tab.id === 'number' ? tab.id : null,
      // Marks "this call CREATED a durable tab" — the dispatcher's run-tab janitor
      // keys off this, not off the tool name, so every tool that leaves a tab
      // behind (get_page_text keep_open:true …) is reaped the same way.
      created_tab: true,
      // `||`, not `??`: a just-created tab often reports url:"" (still loading) —
      // `??` let that empty string through, which broke the dispatcher's
      // adapter_hint (empty url short-circuits) and told the model nothing.
      url: tab.url || url,
      active,
      ...(llmsTxt ? { llms_txt: llmsTxt } : {}),
    };
  },
});
