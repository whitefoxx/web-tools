/**
 * Which tools skip the anti-bot pacing.
 *
 * `local: true` claims a tool never contacts a WEBSITE — it reads or writes the
 * browser's own state or the extension's own storage — and so has nobody on the
 * other side to look human to. The claim buys several seconds a call, and the
 * cost of getting it wrong is silent: a page-driving tool marked local loses the
 * pacing exactly where pacing is the point.
 *
 * So the set is pinned. Adding one is a deliberate act, and the second test is
 * the one that matters: nothing that touches a page or the network may be in it.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

type ToolDef = { site: string; name: string; local?: boolean; description?: string };
let tools: ToolDef[] = [];

beforeAll(async () => {
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
    windows: { onRemoved: { addListener: () => {} } },
    runtime: { getManifest: () => ({ name: 'localmd Connect' }) },
    storage: { onChanged: { addListener: () => {} } },
  });
  await import('../src/tools/generic/_localmd');
  const { getRegistry } = await import('../src/runtime/registry.js');
  tools = (getRegistry() as ToolDef[]).filter((d) => d.site === 'generic');
});

/** Browser state, extension storage, and our own catalogue — no site involved. */
const EXPECTED_LOCAL = [
  'ack_inbox',
  'add_to_reading_list',
  'close_tab',
  'create_bookmark',
  'create_site_script',
  'delete_bookmark',
  'delete_highlights',
  'delete_site_script',
  'get_active_tab',
  'get_highlights',
  'get_kb_folders',
  'get_site_script',
  'list_bookmarks',
  'list_inbox',
  'list_reading_list',
  'list_recently_closed',
  'list_saved_pages',
  'list_site_scripts',
  'list_tabs',
  'manage_tabs',
  'remove_from_reading_list',
  'search_bookmarks',
  'search_history',
  'set_reading_list_read',
  'set_site_script_enabled',
  'sync_kb_folders',
  'sync_saved_pages',
];

describe('the pacing exemption', () => {
  it('is exactly this set (change deliberately)', () => {
    const local = tools
      .filter((t) => t.local)
      .map((t) => t.name)
      .sort();
    expect(local).toEqual(EXPECTED_LOCAL);
  });

  it('never exempts a tool that drives a page or reaches the network', () => {
    // The dangerous direction. These all put a request or an injection in front
    // of a real site, which is what the pacing is there for.
    const touchesSite = [
      'open_url',
      'get_page_text',
      'get_html',
      'get_dom_outline',
      'list_links',
      'query_dom',
      'find_in_page',
      'find_in_dom',
      'wait_for_selector',
      'screenshot',
      'scroll_page',
      'get_interactives',
      'click',
      'type_into',
      'press_key',
      'select_option',
      'hover',
      'drag_and_drop',
      'file_upload',
      'handle_dialog',
      'fill_form',
      'web_search',
      'fetch_url',
      'list_webmcp_tools',
      'call_webmcp_tool',
      'clip_page',
      'preview_site_script',
    ];
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of touchesSite) {
      expect(byName.has(n), `${n} is not registered — fix this list`).toBe(true);
      expect(byName.get(n)!.local, `${n} must stay paced`).toBeFalsy();
    }
  });

  it('covers every tool: each one either touches a site or is marked local', () => {
    // Not an assertion about the split, but about nobody being forgotten — a
    // tool absent from both lists above has never been thought about.
    const accounted = new Set([
      ...EXPECTED_LOCAL,
      ...tools.filter((t) => !t.local).map((t) => t.name),
    ]);
    for (const t of tools) expect(accounted.has(t.name), `${t.name} unaccounted for`).toBe(true);
  });
});

describe('the executors honour it', () => {
  it('both generic branches check `local` before pacing', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // Only the base executor lives in this repo; the full shell's dispatcher.ts
    // (web-agent) carries the same `local` check and is asserted there.
    for (const f of ['src/core/execute-generic.ts']) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8');
      expect(src, `${f} paces unconditionally`).toMatch(
        /if \(!adapter\.local\) await humanPace\('generic'\)/,
      );
    }
  });
});
