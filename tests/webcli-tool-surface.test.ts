/**
 * WebCLI tool-surface invariants — guards the "one core, two shells" seam at the
 * level that actually bit us: what the tool CATALOG says and contains.
 *
 * `tools/generic/_generic.ts` is the exact set the agent-free shell registers and
 * hands to external agents (localmd over Port MCP, Claude Code / Codex over the WS
 * bridge). Those agents have nothing but these strings to go on — no system
 * prompt, no SidePanel, no run lifecycle. Two failure modes, both real (see
 * docs/adapter-hot-plug.md §10.47 and docs/webcli.md §10):
 *
 *  ① a description promises FULL-SHELL behavior that does not exist here — most
 *    of all "tabs are reaped automatically at the end of this task": WebCLI runs
 *    tools through core/execute-generic.ts, which has no run-tab janitor and no
 *    "task" to end. It contradicted the shell's own instructions ("close the tabs
 *    you open"), and contradictory guidance is how you get leaked tabs.
 *  ② a tool is LISTED that cannot work here, so the agent burns calls on it.
 *
 * Both are invisible to type-checking and to every other test, so they are pinned
 * here. If you are adding a tool or rewording a description and this fails: the
 * fix is the wording / the placement (put full-shell-only tools in `_all.ts`),
 * not the assertion.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';

type ToolDef = {
  site: string;
  name: string;
  description?: string;
  args?: { name: string; help?: string }[];
};

let webcliTools: ToolDef[] = [];

beforeAll(async () => {
  // Registration is pure data, but a few modules touch chrome namespaces at import.
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: { addListener: () => {} } },
    windows: { onRemoved: { addListener: () => {} } },
    runtime: { getManifest: () => ({ name: 'WebCLI' }) },
  });
  await import('../src/tools/generic/_generic');
  const { getRegistry } = await import('../src/runtime/registry.js');
  webcliTools = (getRegistry() as ToolDef[]).filter((d) => d.site === 'generic');
});

/** Every string an external agent reads for one tool. */
const textOf = (t: ToolDef): string =>
  [t.description ?? '', ...(t.args ?? []).map((a) => a.help ?? '')].join('\n');

describe('WebCLI catalog — no promises the agent-free shell cannot keep', () => {
  it('never claims tabs are cleaned up for you', () => {
    // WebCLI has no janitor: a tabId stays valid until the agent closes it, and a
    // tab it forgets leaks. Only the FULL shell reaps, and that promise belongs in
    // its system prompt — not in a description both shells serve.
    const banned =
      /auto-?reap|reaped automatically|回收|at task end|end of th(is|e) task|this task opened|until the (user starts the )?next task/i;
    const offenders = webcliTools.filter((t) => banned.test(textOf(t))).map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it('never describes the Explore tab as an unconditional default', () => {
    // The explore gate is null in this shell (core/explore-gate), so "omit tab_id
    // to use the Explore session tab" is an instruction that can only ever error.
    // Mentioning Explore is fine — presenting it as the fallback is not.
    const banned = /omit (it )?to (use|default)|in Explore mode omit/i;
    const offenders = webcliTools
      .filter((t) => /explore/i.test(textOf(t)) && banned.test(textOf(t)))
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it('never points at a tool that is not registered here', () => {
    const present = new Set(webcliTools.map((t) => t.name));
    const referenced = new Set<string>();
    for (const t of webcliTools) {
      for (const m of textOf(t).matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b(?=\s*[({[]|\b)/g)) {
        referenced.add(m[1]);
      }
    }
    // Only judge names that ARE tools somewhere in the product — anything else in
    // that shape is ordinary snake_case prose (max_wait_ms, full_page, …).
    const fullShellOnly = [
      'read_more',
      'find_adapters',
      'load_adapter',
      'get_highlights',
      'explore_start',
      'capture_submission',
      'await_user_action',
      'web_task',
    ];
    const dangling = fullShellOnly.filter((n) => referenced.has(n) && !present.has(n));
    expect(dangling).toEqual([]);
  });
});

describe('WebCLI catalog — membership', () => {
  it('excludes tools that can never succeed without the agent loop', () => {
    const names = new Set(webcliTools.map((t) => t.name));
    // read_more pages through the oversize stash, which ONLY the agent's history
    // truncation writes (agent/engine-history.ts) — dead weight in WebCLI, and its
    // transport truncates without a stash id anyway.
    expect(names.has('read_more')).toBe(false);
    // Explore-authoring + marketplace tools belong to the full shell (_all.ts).
    for (const n of ['find_adapters', 'load_adapter', 'get_highlights']) {
      expect(names.has(n)).toBe(false);
    }
  });

  it('keeps the primitives external agents actually drive', () => {
    const names = new Set(webcliTools.map((t) => t.name));
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
      // page-context JavaScript — the shared-base escape hatch (architecture.md §A.2)
      'eval_js',
      // recon primitives promoted to the base (architecture.md §A.6)
      'find_structured_data',
      'get_a11y_tree',
      'capture_network',
      'find_in_dom',
      // site scripts — a stateful base primitive (architecture.md §A.2)
      'create_site_script',
      'list_site_scripts',
      'get_site_script',
      'set_site_script_enabled',
      'delete_site_script',
      'preview_site_script',
    ]) {
      expect(names.has(n), `${n} missing from the WebCLI set`).toBe(true);
    }
  });

  it('the surface is exactly 39 tools (change deliberately)', () => {
    expect(webcliTools).toHaveLength(39);
  });
});

describe('manifest.webcli.json — the Chrome Web Store hard limits', () => {
  // Learned the mechanical way: a 0.2.0 upload was REJECTED at the dashboard for
  // a 134-char description ("exceeds maximum size limit of 132 characters"). A
  // rejection costs a round trip through build + zip + upload, and the limit is
  // a plain number — so it belongs in a test, not in a checklist someone reads.
  const manifest = JSON.parse(
    readFileSync(new URL('../manifest.webcli.json', import.meta.url), 'utf8'),
  ) as { name: string; description: string; version: string };

  it('description fits the 132-character ceiling', () => {
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  it('name stays inside the safe display width', () => {
    // 45 is the store's practical cut-off for the item title (docs/webcli-releases.md §3).
    expect(manifest.name.length).toBeLessThanOrEqual(45);
  });

  it('name still leads with "WebCLI"', () => {
    // The name doubles as the tab-group title and controlled-tabs.ts cuts at the
    // first dash; changing the leading token orphans every existing group.
    expect(manifest.name.startsWith('WebCLI')).toBe(true);
  });

  it('version is three dot-separated numbers, as the store requires', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('WebCLI catalog — the core profile is a real subset', () => {
  it('every CORE_TOOLS name is a tool this shell registers', async () => {
    // A typo in the profile list would silently shrink `core` by one tool and
    // leave no trace anywhere — the filter just never matches that name.
    const { CORE_TOOLS } = await import('../src/core/tool-profile');
    const names = new Set(webcliTools.map((t) => t.name));
    const unknown = CORE_TOOLS.filter((n) => !names.has(n));
    expect(unknown).toEqual([]);
  });

  it('core is smaller than full, and full hides nothing', async () => {
    const { CORE_TOOLS, isInProfile } = await import('../src/core/tool-profile');
    expect(CORE_TOOLS.length).toBeLessThan(webcliTools.length);
    for (const t of webcliTools) {
      expect(isInProfile(`generic__${t.name}`, 'full')).toBe(true);
    }
  });
});

describe('WebCLI catalog — reading a page is one call', () => {
  it('get_page_text leads with the one-call read and offers keep_open', () => {
    const t = webcliTools.find((x) => x.name === 'get_page_text')!;
    expect(t.description).toMatch(/ONE call/i);
    expect((t.args ?? []).map((a) => a.name)).toContain('keep_open');
  });

  it('open_url sends content-only reads to get_page_text instead', () => {
    const t = webcliTools.find((x) => x.name === 'open_url')!;
    expect(t.description).toMatch(/get_page_text/);
  });
});
