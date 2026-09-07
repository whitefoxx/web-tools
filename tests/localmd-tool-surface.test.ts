/**
 * localmd Connect tool-surface invariants — the third shell's version of
 * tests/webcli-tool-surface.test.ts, guarding the same two failure modes at the
 * catalog level (external agents have nothing but these strings to go on):
 *
 *  ① a description promises behavior this shell does not have (tab reaping, an
 *    Explore-tab fallback, a secrets vault);
 *  ② a description names a tool this shell does not register — e.g. the
 *    full-shell-only `load_adapter` / `read_more`, or the retired site-adapter
 *    tools (`find_adapters` / `run_adapter`, gone from this shell 2026-09-06).
 *
 * If you are adding a tool or rewording a description and this fails: the fix
 * is the wording / the placement (_localmd.ts is the shell's registration
 * entry), not the assertion.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';

type ToolDef = {
  site: string;
  name: string;
  description?: string;
  args?: { name: string; help?: string }[];
};

let localmdTools: ToolDef[] = [];

beforeAll(async () => {
  // Registration is pure data, but a few modules touch chrome namespaces at import.
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
    windows: { onRemoved: { addListener: () => {} } },
    runtime: { getManifest: () => ({ name: 'localmd Connect' }) },
  });
  await import('../src/tools/generic/_localmd');
  const { getRegistry } = await import('../src/runtime/registry.js');
  localmdTools = (getRegistry() as ToolDef[]).filter((d) => d.site === 'generic');
});

/** Every string an external agent reads for one tool. */
const textOf = (t: ToolDef): string =>
  [t.description ?? '', ...(t.args ?? []).map((a) => a.help ?? '')].join('\n');

describe('localmd Connect catalog — no promises this shell cannot keep', () => {
  it('never claims tabs are cleaned up for you', () => {
    // Same contract as WebCLI: no janitor, no "task" to end — a tabId stays
    // valid until the agent closes it (docs/webcli.md §10 applies verbatim).
    const banned =
      /auto-?reap|reaped automatically|回收|at task end|end of th(is|e) task|this task opened|until the (user starts the )?next task/i;
    const offenders = localmdTools.filter((t) => banned.test(textOf(t))).map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it('never describes the Explore tab as an unconditional default', () => {
    // The explore gate is null here (core/explore-gate): find_in_dom IS
    // registered in this shell, so its wording must present tab_id as the
    // normal path and the Explore fallback as full-shell-conditional.
    const banned = /omit (it )?to (use|default)|in Explore mode omit/i;
    const offenders = localmdTools
      .filter((t) => /explore/i.test(textOf(t)) && banned.test(textOf(t)))
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it('never points at a tool that is not registered here', () => {
    const present = new Set(localmdTools.map((t) => t.name));
    const referenced = new Set<string>();
    for (const t of localmdTools) {
      for (const m of textOf(t).matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b(?=\s*[({[]|\b)/g)) {
        referenced.add(m[1]);
      }
    }
    // Only judge names that ARE tools somewhere in the product but not in THIS
    // shell (so a description here must not lean on them): the full-shell-only
    // load_adapter / read_more / find_adapters (the last still exists in the
    // full shell, but site adapters were retired from THIS shell 2026-09-06).
    const notInThisShell = [
      'load_adapter',
      'find_adapters',
      'read_more',
      'eval_js',
      'explore_start',
      'capture_submission',
      'await_user_action',
      'web_task',
    ];
    const dangling = notInThisShell.filter((n) => referenced.has(n) && !present.has(n));
    expect(dangling).toEqual([]);
  });
});

describe('localmd Connect catalog — membership', () => {
  it('keeps every WebCLI primitive', () => {
    const names = new Set(localmdTools.map((t) => t.name));
    for (const n of [
      'open_url',
      'get_page_text',
      'get_html',
      'get_dom_outline',
      'list_links',
      'query_dom',
      'find_in_page',
      'wait_for_selector',
      'screenshot',
      'scroll_page',
      'close_tab',
      'get_active_tab',
      'list_tabs',
      'manage_tabs',
      'get_interactives',
      'click',
      'type_into',
      'press_key',
      'select_option',
      'hover',
      'drag_and_drop',
      'file_upload',
      'handle_dialog',
      'web_search',
      'fetch_url',
      'fill_form',
      'list_webmcp_tools',
      'call_webmcp_tool',
    ]) {
      expect(names.has(n), `${n} missing from the localmd Connect set`).toBe(true);
    }
  });

  it('adds exactly the site-script + capture surface', () => {
    const names = new Set(localmdTools.map((t) => t.name));
    for (const n of [
      'find_in_dom',
      // page-context JavaScript, tab-addressed (§15 — reach a site by building
      // a skill from the base primitives, not a shipped adapter catalog)
      'eval_js',
      // recon primitives promoted to the shared base (architecture.md §A.6)
      'find_structured_data',
      'get_a11y_tree',
      'capture_network',
      'create_site_script',
      'list_site_scripts',
      'get_site_script',
      'set_site_script_enabled',
      'delete_site_script',
      'preview_site_script',
      // knowledge-base capture (docs/localmd-connect.md §14)
      'clip_page',
      'list_inbox',
      'ack_inbox',
      // the browser's own data, behind optional permissions (§14.4 Phase 2)
      'search_bookmarks',
      'list_bookmarks',
      'create_bookmark',
      'search_history',
      'list_reading_list',
      'add_to_reading_list',
      'list_recently_closed',
      'delete_bookmark',
      'remove_from_reading_list',
      'set_reading_list_read',
      // what the user marked while reading (§14.4 Phase 3)
      'get_highlights',
      'delete_highlights',
      // the browser's memory of what the folder holds, and its correction
      'list_saved_pages',
      'sync_saved_pages',
      // which knowledge base is open, mirrored from localmd
      'sync_kb_folders',
      'get_kb_folders',
    ]) {
      expect(names.has(n), `${n} missing from the localmd Connect set`).toBe(true);
    }
  });

  it('excludes the full-shell-only and retired adapter tools', () => {
    const names = new Set(localmdTools.map((t) => t.name));
    // read_more needs the agent's oversize stash. `get_highlights` used to be on
    // this list and is not any more: this shell grew its own in-page highlighter
    // (§14.4 Phase 3) and re-registers the tool with colours and notes. eval_js
    // left this list on 2026-09-05: this shell registers its own tab-addressed
    // variant (the page-context primitive of docs/localmd-connect.md §15).
    // find_adapters / run_adapter / load_adapter: site adapters were RETIRED
    // from this shell 2026-09-06 — reaching a site is a skill the agent builds
    // from the base primitives (architecture.md §A.5), not a shipped catalog.
    for (const n of ['load_adapter', 'read_more', 'find_adapters', 'run_adapter']) {
      expect(names.has(n), `${n} must not register in localmd Connect`).toBe(false);
    }
  });

  it('the surface is exactly 58 tools (change deliberately)', () => {
    expect(localmdTools).toHaveLength(58);
  });

  it('write-capable additions are flagged access:write', () => {
    // run_adapter can execute write adapters; site-script mutations change what
    // runs on the user's pages. The calling app keys its confirm UX off this.
    const byName = new Map(
      localmdTools.map((t) => [t.name, (t as { access?: string }).access ?? 'read']),
    );
    for (const n of [
      'create_site_script',
      'set_site_script_enabled',
      'delete_site_script',
      'ack_inbox', // mutates extension state (drops captured items)
      'sync_saved_pages', // rewrites what the badge claims about the user's pages
      'sync_kb_folders', // changes what the popup says a capture will go into
      'create_bookmark', // changes the user's own bookmark bar
      'delete_bookmark',
      'add_to_reading_list',
      'remove_from_reading_list',
      'set_reading_list_read',
      'delete_highlights', // removes the user's own annotations
    ]) {
      expect(byName.get(n), `${n} must be access:write`).toBe('write');
    }
    for (const n of [
      'list_site_scripts',
      'get_site_script', // reads back a saved script's source
      'preview_site_script',
      'clip_page', // reads a page; the CALLER writes the note
      'list_inbox',
      'search_bookmarks',
      'list_bookmarks',
      'search_history',
      'list_reading_list',
      'list_recently_closed',
      'get_highlights',
    ]) {
      expect(byName.get(n), `${n} must stay access:read`).toBe('read');
    }
  });
});

describe('manifest.localmd.json — the Chrome Web Store hard limits', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../manifest.localmd.json', import.meta.url), 'utf8'),
  ) as {
    name: string;
    description: string;
    version: string;
    key?: string;
    permissions: string[];
    optional_permissions?: string[];
  };

  it('description fits the 132-character ceiling', () => {
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  it('name stays inside the safe display width', () => {
    expect(manifest.name.length).toBeLessThanOrEqual(45);
  });

  it('name still leads with "localmd Connect"', () => {
    // The name doubles as the tab-group title and controlled-tabs.ts cuts at
    // the first dash; changing the leading token orphans every existing group
    // (and must stay distinct from "WebCLI" / "Web Agent").
    expect(manifest.name.startsWith('localmd Connect')).toBe(true);
  });

  it('version is three dot-separated numbers, as the store requires', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('pins its identity with an inline key', () => {
    // The self-generated dev identity (extension-key-localmd.pem) — a stable id
    // for unpacked loads. See docs/localmd-connect.md.
    expect(typeof manifest.key).toBe('string');
    expect((manifest.key ?? '').length).toBeGreaterThan(100);
  });

  it('requests the site-script/capture permissions WebCLI does not', () => {
    // userScripts = persistent site scripts; contextMenus = the capture menu.
    for (const p of ['userScripts', 'contextMenus']) {
      expect(manifest.permissions, `${p} missing`).toContain(p);
    }
  });

  it('does NOT request `offscreen` — no adapter eval to host since P5-B', () => {
    // The offscreen document was the panel-free adapter-eval venue. Site
    // adapters were retired from this shell 2026-09-06 (P5-B), and nothing else
    // here creates an offscreen document — so the permission (and the emitted
    // offscreen.html/js, which pulled sidepanel/sandbox-host) are gone. An
    // unused permission is a Web Store review flag; the full extension keeps it.
    expect(manifest.permissions).not.toContain('offscreen');
  });

  it('keeps the browser-data permissions OPTIONAL', () => {
    // The same capabilities shipped in the full extension and were deleted a
    // month later (e31fde0): asked for up front they turn the install prompt
    // into "read and change your browsing history". Optional moves that
    // decision to the moment it buys the user something. If one of these ever
    // appears in `permissions`, that decision has been silently reversed.
    for (const p of ['bookmarks', 'history', 'readingList', 'sessions']) {
      expect(manifest.optional_permissions, `${p} must be optional`).toContain(p);
      expect(manifest.permissions, `${p} must NOT be required`).not.toContain(p);
    }
  });

  it('does NOT request `alarms` — the shipping build has no daemon to redial', () => {
    // The WS bridge lives behind __LOCALMD_DEV__, and its one-minute redial
    // timer is the only thing that ever wanted `alarms`. The dev build adds the
    // permission back in vite.config.ts; the SHIPPING manifest must not carry a
    // permission nothing in the shipped bundle uses — a reviewer asks about
    // every one of them, and this shell already asks for userScripts and
    // debugger on a brand-new item.
    expect(manifest.permissions).not.toContain('alarms');
  });
});
