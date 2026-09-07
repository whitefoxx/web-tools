/**
 * WebMCP — talk to tools a PAGE declares for agents, instead of clicking its UI.
 *
 * Why this exists (docs/devtools-mcp-comparison.md §2⑨): Chrome is shipping
 * `navigator.modelContext`, where a site registers callable tools for agents.
 * If that ecosystem takes, part of what a site adapter does is provided by the
 * site itself. Reading a page's tool registry costs one `executeScript` — no
 * CDP, no new permission — so shipping the pair now is a cheap option on a
 * standard that may or may not land. Adapters keep covering the other 99.9% of
 * the web that will never register anything.
 *
 * The API surface is genuinely unsettled (`provideContext`/`clearContext` were
 * dropped from the draft in March 2026, leaving `registerTool`/`unregisterTool`),
 * and page registration is not guaranteed to be enumerable from script at all.
 * So the probe is DEFENSIVE by design: it tries the known shapes in order,
 * reports WHICH one answered, and — the case that matters — distinguishes
 * "no WebMCP here" from "the API object exists but exposes no way to list what
 * was registered". Those need different follow-ups from the agent, and folding
 * them together would be the same silent-substitution class as §10.47.
 *
 * MAIN world is mandatory: `navigator` is per-world, so an ISOLATED-world script
 * sees its own bare navigator and would report "not supported" on every page.
 */
import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';

interface ProbeResult {
  /** The page exposes an agent-tool API object at all. */
  api_present: boolean;
  /** Where the tool list came from, when one was readable. */
  source?: string;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  /** Surfaces we looked at, so a miss is diagnosable rather than mysterious. */
  probed: string[];
  note?: string;
}

cli({
  site: 'generic',
  name: 'list_webmcp_tools',
  access: 'read',
  description:
    'List the tools a page declares for AI agents via the WebMCP API (navigator.modelContext). Some sites expose their own actions this way — "add to cart", "search flights" — and calling one is far more reliable than driving the UI, because you are using the interface the site meant for you rather than its buttons. Check this FIRST on a page you are about to automate: if it returns tools, use call_webmcp_tool; if it returns none, fall back to get_interactives + click as usual. Most sites today declare nothing, and that is an expected, cheap answer — not an error.',
  args: [{ name: 'tab_id', type: 'int', required: true, help: 'Target tab id' }],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      world: 'MAIN',
      func: webmcpInPage,
      args: ['list', '', ''],
    });
    const r = (injected[0]?.result ?? null) as ProbeResult | null;
    if (!r) throw new Error('executeScript returned no result');
    return {
      tabId: tab.id!,
      url: tab.url ?? '',
      supported: r.tools.length > 0,
      api_present: r.api_present,
      count: r.tools.length,
      tools: r.tools,
      // WHICH accessor answered. Dropping this on the floor made the "we report
      // the source" contract a lie for one real-machine run — the probe computed
      // it and the tool never forwarded it (findings F-42).
      ...(r.source ? { source: r.source } : {}),
      probed: r.probed,
      ...(r.note ? { note: r.note } : {}),
      ...(r.tools.length === 0
        ? {
            hint: r.api_present
              ? 'The page has the WebMCP API object but did not expose a readable tool list — it may register tools lazily (try again after interacting), or its registrations may not be enumerable from script. Drive the UI with get_interactives + click.'
              : 'This page declares no agent tools (the normal case today). Drive the UI with get_interactives + click.',
          }
        : {}),
    };
  },
});

cli({
  site: 'generic',
  name: 'call_webmcp_tool',
  // A page tool can do anything the site can do — post, buy, delete. It is a
  // write by definition, and gets the same confirmation gate as any other.
  access: 'write',
  description:
    'Call one of the tools a page declares via WebMCP (discover them with list_webmcp_tools first). Pass the tool name and its input as a JSON object string matching that tool\'s inputSchema. Returns the tool\'s own result. This performs a real action on the site — treat it exactly as seriously as clicking the button it replaces.',
  args: [
    { name: 'tab_id', type: 'int', required: true, help: 'Target tab id' },
    {
      name: 'name',
      type: 'string',
      required: true,
      help: 'Tool name exactly as returned by list_webmcp_tools',
    },
    {
      name: 'input',
      type: 'string',
      help: 'Arguments as a JSON object string, e.g. {"query":"laptop","max":10}. Match the tool\'s inputSchema. Default {}',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const name = String(kwargs.name ?? '').trim();
    if (!name) throw new Error('name is required — run list_webmcp_tools to see what this page offers');
    const rawInput = kwargs.input == null || kwargs.input === '' ? '{}' : String(kwargs.input);
    try {
      const parsed = JSON.parse(rawInput);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
    } catch {
      throw new Error(`input must be a JSON object string, e.g. {"query":"laptop"} — got: ${rawInput.slice(0, 120)}`);
    }
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      world: 'MAIN',
      func: webmcpInPage,
      args: ['call', name, rawInput],
    });
    const r = injected[0]?.result as Record<string, unknown> | undefined;
    if (!r) throw new Error('executeScript returned no result');
    if (r.error) throw new Error(String(r.error));
    return { tabId: tab.id!, name, ...r };
  },
});

/**
 * Runs IN the page, MAIN world. Self-contained (executeScript serializes it).
 * `mode` is 'list' or 'call'; everything it returns must be JSON-serializable,
 * so tool descriptors are flattened and their callables dropped.
 */
async function webmcpInPage(
  mode: string,
  toolName: string,
  inputJson: string,
): Promise<Record<string, unknown>> {
  const nav = navigator as unknown as Record<string, unknown>;
  const win = window as unknown as Record<string, unknown>;
  const probed: string[] = [];

  /** Read one candidate surface, tolerating getters that throw and accessors
   * that are functions vs. plain properties. */
  const candidates: Array<{ source: string; value: unknown }> = [];
  const push = (source: string, holder: Record<string, unknown>, key: string): void => {
    probed.push(source);
    try {
      const v = holder[key];
      if (v == null) return;
      candidates.push({ source, value: typeof v === 'function' ? (v as () => unknown).call(holder) : v });
    } catch {
      /* a throwing accessor is not a registry */
    }
  };

  const mc = nav.modelContext as Record<string, unknown> | undefined;
  const apiPresent = !!mc && typeof mc === 'object';
  if (apiPresent) {
    // Documented-ish accessors first, polyfill internals last.
    for (const k of ['listTools', 'getTools', 'tools', 'availableTools', '_tools', '__tools', 'registeredTools']) {
      push(`navigator.modelContext.${k}`, mc as Record<string, unknown>, k);
    }
  } else {
    probed.push('navigator.modelContext');
  }
  const wm = win.webmcp as Record<string, unknown> | undefined;
  if (wm && typeof wm === 'object') {
    for (const k of ['tools', 'listTools']) push(`window.webmcp.${k}`, wm, k);
  }
  const ag = win.agent as Record<string, unknown> | undefined;
  if (ag && typeof ag === 'object') push('window.agent.tools', ag, 'tools');

  /** Coerce whatever the surface handed back into a list of descriptor objects:
   * an array, a Map/Set of them, or a name→descriptor record. */
  const toList = (v: unknown): unknown[] | null => {
    if (Array.isArray(v)) return v;
    if (v instanceof Map) return Array.from(v.values());
    if (v instanceof Set) return Array.from(v.values());
    if (v && typeof v === 'object') {
      const vals = Object.values(v as Record<string, unknown>);
      if (vals.length && vals.every((x) => x && typeof x === 'object')) return vals;
    }
    return null;
  };

  let found: { source: string; list: unknown[] } | null = null;
  for (const c of candidates) {
    let v = c.value;
    if (v && typeof (v as { then?: unknown }).then === 'function') {
      try {
        v = await (v as Promise<unknown>);
      } catch {
        continue;
      }
    }
    const list = toList(v);
    if (list && list.length && list.some((t) => t && typeof t === 'object' && 'name' in (t as object))) {
      found = { source: c.source, list };
      break;
    }
  }

  if (mode === 'list') {
    const tools = (found?.list ?? [])
      .map((t) => t as Record<string, unknown>)
      .filter((t) => typeof t.name === 'string')
      .map((t) => ({
        name: String(t.name),
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        ...(t.inputSchema !== undefined
          ? { inputSchema: t.inputSchema }
          : t.input_schema !== undefined
            ? { inputSchema: t.input_schema }
            : t.parameters !== undefined
              ? { inputSchema: t.parameters }
              : {}),
      }));
    const out: Record<string, unknown> = { api_present: apiPresent, tools, probed };
    if (found) out.source = found.source;
    if (apiPresent && !found) {
      out.note =
        'navigator.modelContext exists but exposed no readable tool list — registrations may be write-only from script on this build.';
    }
    // Structured-clone safety: an inputSchema could carry something exotic.
    try {
      JSON.stringify(out);
      return out;
    } catch {
      return {
        api_present: apiPresent,
        probed,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        note: 'inputSchema omitted (not serializable)',
      };
    }
  }

  // ── call mode ───────────────────────────────────────────────────────────
  if (!found) {
    return {
      error: apiPresent
        ? 'this page exposes no readable WebMCP tool list — run list_webmcp_tools'
        : 'this page declares no WebMCP tools',
    };
  }
  const desc = found.list
    .map((t) => t as Record<string, unknown>)
    .find((t) => t && t.name === toolName);
  if (!desc) {
    const names = found.list
      .map((t) => (t as Record<string, unknown>)?.name)
      .filter((n) => typeof n === 'string');
    return { error: `no tool named "${toolName}" on this page. Available: ${names.join(', ') || '(none)'}` };
  }
  const fnKey = ['execute', 'call', 'run', 'handler', 'invoke'].find(
    (k) => typeof desc[k] === 'function',
  );
  if (!fnKey) return { error: `tool "${toolName}" exposes no callable (looked for execute/call/run/handler/invoke)` };

  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return { error: 'input was not valid JSON' };
  }

  try {
    const raw = await (desc[fnKey] as (a: unknown) => unknown).call(desc, input);
    // The shape agreed on by the current tooling is {status, output, errorText};
    // anything else is passed through under `output` rather than being dropped.
    if (raw && typeof raw === 'object' && ('status' in raw || 'output' in raw || 'errorText' in raw)) {
      const o = raw as Record<string, unknown>;
      return JSON.parse(
        JSON.stringify({ called: fnKey, status: o.status, output: o.output, errorText: o.errorText }),
      );
    }
    return JSON.parse(JSON.stringify({ called: fnKey, output: raw ?? null }));
  } catch (e) {
    return { error: `tool "${toolName}" threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}
