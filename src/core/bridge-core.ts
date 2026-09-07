/**
 * Shared external-tool executor (core) — the single copy of the "run one tool
 * for an external agent" logic + write gates, used by BOTH bridge shells:
 *   • the FULL extension (src/background/bridge-client.ts) injects the rich
 *     synthetic CONTROL_TOOLS + executeAdapter (all adapters);
 *   • the LITE bridge injects an empty control set + executeGenericTool (generic
 *     tools only).
 *
 * `createBridge` closes over injected config so this module imports NOTHING from
 * the full shell (only the core-safe `lookupAdapter`). That is what lets the
 * lite shell reuse the write-gate + dispatch semantics without dragging the
 * agent / adapter / explore graph into its bundle.
 *
 * The transports (WS in bridge-client, Port MCP in external-mcp) call the
 * returned `runExternalTool` / `isExternalTool`; they own their own audit log
 * (recordCall) and SW-lifecycle wiring around it.
 */
import { lookupAdapter } from '../tools/manifest';

export type ToolResult = { ok: boolean; result?: unknown; error?: string };

/** A synthetic in-extension tool handled by the shell (not a registry adapter).
 * `write: true` ones respect the "allow external writes" kill switch. */
export interface ControlTool {
  write?: boolean;
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface CreateBridgeConfig {
  /** The tool executor: executeAdapter (full) or executeGenericTool (lite). Only
   * `ok`/`result`/`error` are read, so both result shapes satisfy it. */
  execute(opts: {
    tool: string;
    args: Record<string, unknown>;
    origin?: string;
  }): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** Synthetic control tools, dispatched before registry adapters. */
  controlTools: Record<string, ControlTool>;
  /** Current "allow external writes" policy (read live, not snapshotted). */
  getAllowWrites(): boolean;
  /** Sites where external WRITES are always blocked (read live). */
  getDenySites(): string[];
  /** Message returned when a write is blocked by the kill switch. */
  writeDisabledMsg: string;
  /** SW keep-alive pin for the duration of a call (F-8). */
  onBusy?(): void;
  onIdle?(): void;
  /** A call started / ended — used to cancel/re-arm the idle pool-tab reap. */
  onCallStart?(): void;
  onCallEnd?(): void;
}

export interface Bridge {
  runExternalTool(
    tool: string,
    args: Record<string, unknown>,
    origin?: string,
  ): Promise<ToolResult>;
  isExternalTool(tool: string): boolean;
}

export function createBridge(cfg: CreateBridgeConfig): Bridge {
  /** Can this bridge serve `tool`? (synthetic control tool or registered
   * adapter.) Transports check this BEFORE dispatch so an unknown tool stays a
   * protocol error, not a text result. */
  function isExternalTool(tool: string): boolean {
    return !!cfg.controlTools[tool] || !!lookupAdapter(tool);
  }

  /** Execute ONE external tool call: synthetic CONTROL_TOOLS first, then registry
   * adapters, with the SINGLE copy of the write gates ("allow external writes" +
   * per-site deny list). Pins the SW busy + cancels the idle reap for the duration. */
  async function runExternalTool(
    tool: string,
    args: Record<string, unknown>,
    origin = 'bridge',
  ): Promise<ToolResult> {
    cfg.onBusy?.();
    cfg.onCallStart?.();
    try {
      const ctrl = cfg.controlTools[tool];
      if (ctrl) {
        if (ctrl.write && !cfg.getAllowWrites()) return { ok: false, error: cfg.writeDisabledMsg };
        return await ctrl.run(args);
      }

      const adapter = lookupAdapter(tool);
      if (!adapter) return { ok: false, error: `tool not found: ${tool}` };
      if (adapter.access === 'write') {
        if (!cfg.getAllowWrites()) return { ok: false, error: cfg.writeDisabledMsg };
        const site = tool.slice(0, tool.indexOf('__'));
        if (cfg.getDenySites().includes(site)) {
          return { ok: false, error: `external writes to ${site} are blocked (manage this under "External control")` };
        }
      }
      try {
        const r = await cfg.execute({ tool, args, origin });
        return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    } finally {
      cfg.onIdle?.();
      cfg.onCallEnd?.();
    }
  }

  return { runExternalTool, isExternalTool };
}
