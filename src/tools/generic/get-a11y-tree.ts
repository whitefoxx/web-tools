import { cli } from '../../runtime/registry.js';
import { getActiveExploreSession } from '../../core/explore-gate';
import { assertTabId } from './_helpers';
import { createPageShim } from '../../runtime/page';

/**
 * Explore-time semantic structure: the page's **accessibility tree** (the same
 * thing DevTools' Accessibility pane shows) via CDP `Accessibility.getFullAXTree`
 * over the explore session's existing debugger attachment. role + name + key
 * states, indented — far more stable + meaningful than raw DOM/classes (it's
 * class-independent), so the agent can see which regions/controls exist
 * (heading / link / button / list / article / combobox …), locate the data, and
 * choose robust anchors (role / aria / semantic tags / text) instead of
 * obfuscated classes.
 *
 * SHARED-BASE primitive (docs/architecture.md §A.6): tab-addressed, with the
 * explore session as a fallback when `tab_id` is omitted. Registered by
 * `_generic.ts`.
 */

interface AXValue {
  value?: unknown;
}
interface AXProperty {
  name: string;
  value?: AXValue;
}
interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

const STATE_KEYS = new Set([
  'focusable',
  'expanded',
  'checked',
  'selected',
  'disabled',
  'required',
  'level',
  'pressed',
  'haspopup',
]);

cli({
  site: 'generic',
  name: 'get_a11y_tree',
  access: 'read',
  description:
    "Get the page's accessibility tree (i.e. the Accessibility view in DevTools) — a semantic structure (role + name + state), class-independent and far more stable than the raw DOM. Use it to quickly see what meaningful sections/controls the page has (heading/link/button/list/article/combobox…), locate where the data is, and pick stable extraction anchors from it (role/aria/semantic tags/text).",
  args: [
    {
      name: 'tab_id',
      type: 'int',
      help: 'Target tab (required outside an explore session, where it defaults to the explore tab)',
    },
    { name: 'max_nodes', type: 'int', default: 500, help: 'Max nodes to output (default 500, cap 3000)' },
    { name: 'include_ignored', type: 'bool', help: 'Whether to include ignored nodes; default false' },
    { name: 'max_chars', type: 'int', default: 20000, help: 'Max characters to output (default 20000)' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    let tabId: number;
    if (kwargs.tab_id !== undefined && kwargs.tab_id !== null && kwargs.tab_id !== '') {
      await assertTabId(kwargs.tab_id);
      tabId = Number(kwargs.tab_id);
    } else if (session) {
      tabId = session.tabId;
    } else {
      return { error: 'provide tab_id, or start an explore session first' };
    }
    const maxNodes = Math.max(20, Math.min(Number(kwargs.max_nodes ?? 500) || 500, 3000));
    const maxChars = Math.max(1000, Math.min(Number(kwargs.max_chars ?? 20000) || 20000, 200000));
    const includeIgnored = !!kwargs.include_ignored;

    // PageShim attaches the debugger on demand (tolerating an existing
    // attachment, e.g. an explore recorder) and only detaches what it owns.
    const shim = await createPageShim(tabId);
    let resp: { nodes?: AXNode[] };
    try {
      await shim.cdp('Accessibility.enable');
      resp = (await shim.cdp('Accessibility.getFullAXTree', {})) as { nodes?: AXNode[] };
    } catch (e) {
      await shim.detach().catch(() => {});
      return { error: `accessibility tree unavailable: ${e instanceof Error ? e.message : String(e)}` };
    }
    await shim.detach().catch(() => {});
    const nodes = resp.nodes ?? [];
    if (nodes.length === 0) return { error: 'accessibility tree is empty (the page may not have finished loading)' };

    const byId = new Map<string, AXNode>();
    const isChild = new Set<string>();
    for (const n of nodes) {
      byId.set(n.nodeId, n);
      for (const c of n.childIds ?? []) isChild.add(c);
    }
    const roots = nodes.filter((n) => !isChild.has(n.nodeId));

    const str = (v?: AXValue): string => (v && v.value != null ? String(v.value) : '');
    const stateOf = (n: AXNode): string => {
      const parts: string[] = [];
      for (const p of n.properties ?? []) {
        if (!STATE_KEYS.has(p.name)) continue;
        const v = p.value?.value;
        if (v === false || v === 'false' || v == null) continue;
        parts.push(v === true || v === 'true' ? p.name : `${p.name}=${v}`);
      }
      return parts.length ? ` [${parts.join(', ')}]` : '';
    };

    const lines: string[] = [];
    let count = 0;
    let truncated = false;
    const seen = new Set<string>(); // guard against any cyclic childIds
    const walk = (id: string, depth: number): void => {
      if (count >= maxNodes) {
        truncated = true;
        return;
      }
      if (seen.has(id)) return;
      seen.add(id);
      const n = byId.get(id);
      if (!n) return;
      const ignored = n.ignored === true;
      if (ignored && !includeIgnored) {
        // Skip the ignored wrapper but keep its meaningful descendants, flattened
        // to this depth (DevTools collapses these as "Ignored").
        for (const c of n.childIds ?? []) walk(c, depth);
        return;
      }
      const role = str(n.role) || (ignored ? 'Ignored' : 'generic');
      const name = str(n.name);
      lines.push('  '.repeat(depth) + role + (name ? ` "${name.slice(0, 120)}"` : '') + stateOf(n));
      count++;
      for (const c of n.childIds ?? []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r.nodeId, 0);

    let outline = lines.join('\n');
    if (outline.length > maxChars) {
      outline = outline.slice(0, maxChars) + '\n…[truncated]';
      truncated = true;
    }
    return { nodeCount: count, truncated, outline };
  },
});
