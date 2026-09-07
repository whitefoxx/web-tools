import { cli } from '../../runtime/registry.js';
import { assertHttpUrl, assertTabId, waitForPageReady } from './_helpers';
import { createAgentTab } from '../../background/agent-window';
import {
  clipTab,
  CLIP_MAX_BYTES,
  type ClipImages,
  type ClipMode,
} from '../../localmd-connect/clip';

/**
 * localmd Connect only — the agent-driven half of the web clipper. The user-
 * driven half (context menu / shortcut / popup) produces the SAME payload and
 * parks it in the inbox (`list_inbox`). See src/localmd-connect/clip.ts.
 */
cli({
  site: 'generic',
  name: 'clip_page',
  access: 'read',
  description:
    'Clip a web page into a note-ready payload: page metadata (canonical URL, site, author, published/modified dates, description, language, og:image), the main content as Markdown (same dialect as get_page_text), and the images it references as absolute URLs (optionally inlined as data URLs, fetched with the user\'s cookies). Pass `url` to open, clip and close a tab, or `tab_id` to clip an open tab in place (never closed). mode "article" (default) picks the main content by text density; "full" keeps everything but boilerplate; "selection" clips what the user has selected in that tab and adds a TextQuote anchor {exact, prefix, suffix} for citing back. A PDF (a `.pdf` URL, arXiv\'s /pdf/, or an application/pdf response) comes back as the FILE instead — `{kind:"pdf", data (base64), size, title, url}` — fetched with the user\'s cookies, up to ~12MB: save it as a document, do not try to read text out of it here. The CALLER writes the note (path, frontmatter, image files) — this returns data only. Reach for fetch_url {format:"markdown"} instead when you only need to READ a server-rendered page; use this when the result is going to be saved.',
  args: [
    { name: 'url', type: 'string', help: 'Page to clip (http/https). One of url / tab_id' },
    {
      name: 'tab_id',
      type: 'int',
      help: 'An open tab to clip in place (required for mode "selection"). One of url / tab_id',
    },
    {
      name: 'mode',
      type: 'string',
      default: 'article',
      help: '"article" (main content, default) | "full" (whole page minus boilerplate) | "selection" (the user\'s current selection in tab_id)',
    },
    {
      name: 'images',
      type: 'string',
      default: 'list',
      help: '"list" (default: absolute URLs only) | "inline" (also fetch each as a data URL, ≤20 images / 3MB each / 12MB total — use when the note must keep its images) | "skip"',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'article mode: clip only this element instead of the auto-picked main content',
    },
    {
      name: 'max_bytes',
      type: 'int',
      help: `Markdown cap (default and max ${CLIP_MAX_BYTES}); \`truncated\` reports a cut`,
    },
    { name: 'max_wait_ms', type: 'int', help: 'url mode: max load wait (default 15000)' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const urlArg = typeof kwargs.url === 'string' && kwargs.url.trim() ? kwargs.url.trim() : null;
    const hasTabId = kwargs.tab_id != null && kwargs.tab_id !== '';
    if (!urlArg && !hasTabId) throw new Error('need either url or tab_id');
    if (urlArg && hasTabId) throw new Error('pass only one of url and tab_id');
    const mode = parseMode(kwargs.mode);
    const images = parseImages(kwargs.images);
    if (mode === 'selection' && !hasTabId) {
      throw new Error('mode "selection" needs tab_id (the tab where the user made the selection)');
    }
    const opts = {
      mode,
      images,
      selector:
        typeof kwargs.selector === 'string' && kwargs.selector.trim()
          ? kwargs.selector.trim()
          : undefined,
      maxBytes: kwargs.max_bytes != null ? Number(kwargs.max_bytes) : undefined,
    };

    if (hasTabId) {
      const tab = await assertTabId(kwargs.tab_id);
      await waitForPageReady(tab.id!, { maxWaitMs: 3000, quietMs: 600 });
      const clip = await clipTab(tab.id!, opts);
      return { ...clip, tabId: tab.id };
    }
    const url = assertHttpUrl(urlArg);
    const tab = await createAgentTab(url, { active: false });
    if (typeof tab.id !== 'number') throw new Error('failed to open tab');
    try {
      const wait = await waitForPageReady(tab.id, {
        maxWaitMs: Number(kwargs.max_wait_ms ?? 15_000),
        quietMs: 800,
      });
      const clip = await clipTab(tab.id, opts);
      return { ...clip, tab_closed: true as const, wait };
    } finally {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* already gone */
      }
    }
  },
});

function parseMode(v: unknown): ClipMode {
  const s = String(v ?? 'article').toLowerCase();
  if (s === 'article' || s === 'full' || s === 'selection') return s;
  throw new Error(`mode must be "article", "full" or "selection" (got ${JSON.stringify(v)})`);
}

function parseImages(v: unknown): ClipImages {
  const s = String(v ?? 'list').toLowerCase();
  if (s === 'list' || s === 'inline' || s === 'skip') return s;
  throw new Error(`images must be "list", "inline" or "skip" (got ${JSON.stringify(v)})`);
}
