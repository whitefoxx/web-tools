/**
 * Standalone executor for GENERIC tools (`generic__*`) — the core the LITE
 * bridge shell runs on. It is the dispatcher's `site === 'generic'` branch,
 * extracted with the small pure helpers it needs, and deliberately imports
 * NOTHING from the full shell (no adapter pool, userScripts, pipeline, explore,
 * secrets, health). That zero-coupling is what keeps the lite bundle light — it
 * is enforced by construction, not by tree-shaking faith.
 *
 * The FULL shell does not use this file: `tools/dispatcher.ts` keeps its own
 * (byte-identical) generic branch so its behavior is unchanged. The few helpers
 * below are duplicated from the dispatcher on purpose — churn-minimization on
 * the shipping extension is worth more than DRY here (project rule). Keep the
 * two copies in sync if the generic-execution contract changes.
 */
import { lookupAdapter, type AdapterDef } from '../tools/manifest';
import { RateLimitedError, AuthRequiredError, EmptyResultError } from '../runtime/errors.js';
import { log } from '../runtime/log';

export interface ToolExecResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  errorKind?: 'rate_limited' | 'auth_required' | 'empty' | 'tool_not_found' | 'tab' | 'generic';
  durationMs: number;
}

// ── inter-call pacing (anti-bot; mirrors dispatcher.humanPace) ──────────────
// Its own state map: the lite executor is a separate bundle, so there is never
// a second copy live in the same shell.
const MIN_INTERVAL_MS = 2500;
const HUMAN_PAUSE_MIN_MS = 600;
const HUMAN_PAUSE_MAX_MS = 1800;
const lastCallTsByBucket = new Map<string, number>();

async function humanPace(bucket: string): Promise<void> {
  const now = Date.now();
  const last = lastCallTsByBucket.get(bucket) ?? 0;
  const elapsed = now - last;
  const jitter =
    HUMAN_PAUSE_MIN_MS + Math.floor(Math.random() * (HUMAN_PAUSE_MAX_MS - HUMAN_PAUSE_MIN_MS));
  let totalWait = jitter;
  if (elapsed < MIN_INTERVAL_MS) totalWait += MIN_INTERVAL_MS - elapsed;
  await new Promise((r) => setTimeout(r, totalWait));
  lastCallTsByBucket.set(bucket, Date.now());
}

/** Execute one generic tool. Rejects non-generic tools (the lite shell has no
 * adapter machinery), so an accidental `<site>__<name>` call fails fast and
 * clearly instead of half-running. Never throws — always a ToolExecResult. */
export async function executeGenericTool(opts: {
  tool: string;
  args: Record<string, unknown>;
}): Promise<ToolExecResult> {
  const t0 = Date.now();
  const adapter = lookupAdapter(opts.tool);
  if (!adapter) return failed(t0, `tool not found: ${opts.tool}`, 'tool_not_found');

  const argError = validateArgs(adapter, opts.args ?? {});
  if (argError) return failed(t0, argError, 'generic');

  if (adapter.site !== 'generic') {
    return failed(
      t0,
      `${opts.tool} is not a generic tool — the lite bridge only offers generic browser tools, no site adapters.`,
      'generic',
    );
  }

  // Tools that never touch a website skip the anti-bot pacing: there is nobody
  // on the other side to convince, and the wait is the whole latency of reading
  // the extension's own storage. See AdapterDef.local.
  if (!adapter.local) await humanPace('generic');
  log('execute-generic', `executing ${opts.tool} (tab-less)`, { args: opts.args });
  try {
    const result = await adapter.func(null, withArgDefaults(adapter, opts.args ?? {}));
    log('execute-generic', `success ${opts.tool}`, { durationMs: Date.now() - t0 });
    return { ok: true, result, durationMs: Date.now() - t0 };
  } catch (e) {
    return classifyError(t0, e);
  }
}

// ── pure helpers (mirrors dispatcher.ts) ────────────────────────────────────

function classifyError(t0: number, e: unknown): ToolExecResult {
  if (e instanceof RateLimitedError) {
    return {
      ok: false,
      error: `Rate-limited at ${e.domain} (redirected to ${e.redirectedUrl}). Do not retry — wait 15–30 minutes before trying again.`,
      errorKind: 'rate_limited',
      durationMs: Date.now() - t0,
    };
  }
  if (e instanceof AuthRequiredError) {
    return {
      ok: false,
      error: `Authentication required at ${e.domain}: ${e.message}`,
      errorKind: 'auth_required',
      durationMs: Date.now() - t0,
    };
  }
  if (e instanceof EmptyResultError) {
    return {
      ok: false,
      error: `No results from ${e.source}: ${e.message}`,
      errorKind: 'empty',
      durationMs: Date.now() - t0,
    };
  }
  return failed(t0, msgOf(e), 'generic');
}

function failed(t0: number, error: string, kind: ToolExecResult['errorKind']): ToolExecResult {
  return { ok: false, error, errorKind: kind, durationMs: Date.now() - t0 };
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Merge an adapter's declared arg defaults under the caller-supplied args. */
function withArgDefaults(
  adapter: AdapterDef,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of adapter.args ?? []) {
    if (a.default !== undefined) out[a.name] = a.default;
  }
  return { ...out, ...args };
}

/** Strict on missing required args; lenient (but flags) on unknown extras. */
function validateArgs(adapter: AdapterDef, args: Record<string, unknown>): string | null {
  const argDefs = adapter.args ?? [];
  const expectedNames = new Set(argDefs.map((a) => a.name));
  const provided = Object.keys(args);
  const unknown = provided.filter((p) => !expectedNames.has(p));
  const missing = argDefs.filter((a) => a.required && !(a.name in args)).map((a) => a.name);

  if (missing.length === 0) return null;

  const toolName = `${adapter.site}__${adapter.name}`;
  const expectedDoc = argDefs
    .map((a) => {
      const type = a.type ?? 'string';
      const flag = a.required ? 'required' : 'optional';
      const def = a.default !== undefined ? ` default=${JSON.stringify(a.default)}` : '';
      const help = a.help ? ` — ${a.help}` : '';
      return `  - ${a.name} (${type}, ${flag})${def}${help}`;
    })
    .join('\n');

  const lines: string[] = [
    `Argument error — ${toolName} could not run.`,
    `Missing required argument(s): ${missing.map((n) => `"${n}"`).join(', ')}`,
  ];
  if (unknown.length > 0) {
    lines.push(
      `You passed unrecognized argument(s) ${unknown.map((n) => `"${n}"`).join(', ')} — likely a typo; fix them against the schema:`,
    );
  } else {
    lines.push('Schema:');
  }
  lines.push(expectedDoc);
  lines.push('');
  lines.push('Call again with the correct argument names. If unsure of an argument, run `describe_tool` first for the full spec.');
  return lines.join('\n');
}
