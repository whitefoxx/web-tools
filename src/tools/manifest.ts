/**
 * Convert the adapter registry into OpenAI-style tool (function) schemas.
 *
 * Tool name format: `${site}__${name}` (double underscore).
 * - matches the OpenAI tool name regex `^[a-zA-Z0-9_-]{1,64}$`
 * - reversibly maps back to (site, name) via split('__')
 * - keeps dashes in command names (e.g. `xiaohongshu__creator-notes`)
 */

import { getRegistry } from '../runtime/registry.js';
import type { AdapterCommand } from './command-types';

export interface AdapterArg {
  name: string;
  type?: 'string' | 'int' | 'bool';
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  help?: string;
}

export interface AdapterDef {
  site: string;
  name: string;
  access?: 'read' | 'write';
  /** ④ Sensitive-resource opt-in: require a user confirmation EVERY time this
   * adapter runs — even a `read`, even in auto mode (bank / checkout / posting
   * sites where any call is sensitive). Set in the adapter's `cli({...})`. */
  confirmBeforeUse?: boolean;
  /**
   * This tool never contacts a WEBSITE — it reads or writes the browser's own
   * state (tabs, bookmarks, history) or the extension's own storage.
   *
   * Inter-call pacing exists to keep a site from noticing a machine driving it:
   * a jitter on every call plus a minimum gap between them, several seconds in
   * all. A tool with no site on the other end pays that for nothing, and it is
   * felt — reading the capture inbox took 1.3–5.5s to answer out of the
   * extension's own IndexedDB, which is long enough that a user pressing
   * "Ask localmd" concluded it had failed.
   *
   * Set it only where it is TRUE. Marking a tool that drives a page would take
   * away the pacing exactly where it is the point; the set is pinned by
   * tests/local-tools.test.ts so a new one is a deliberate act.
   */
  local?: boolean;
  description?: string;
  domain?: string;
  args?: AdapterArg[];
  columns?: string[];
  func: (page: unknown, kwargs: Record<string, unknown>) => Promise<unknown>;
}

/** Does a tool need a pre-run user confirmation (④)? A `confirmBeforeUse` adapter
 * ALWAYS confirms (even read / auto mode); otherwise a WRITE confirms unless the
 * user turned on auto-approve. Pure; unit-tested. The gate lives in
 * makeExecuteTool; the model-facing protocol is in the system prompt. */
export function needsConfirmation(
  adapter: { access?: 'read' | 'write'; confirmBeforeUse?: boolean } | undefined,
  autoApprove: boolean,
): boolean {
  if (adapter?.confirmBeforeUse) return true;
  if (autoApprove) return false;
  return adapter?.access === 'write';
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
}

const TYPE_MAP: Record<string, string> = {
  string: 'string',
  int: 'integer',
  bool: 'boolean',
};

export function openAiToolsFromRegistry(): OpenAITool[] {
  const out: OpenAITool[] = [];
  for (const def of getRegistry() as AdapterDef[]) {
    const properties: Record<string, { type: string; description?: string }> = {};
    const required: string[] = [];
    for (const arg of def.args ?? []) {
      const type = TYPE_MAP[arg.type ?? 'string'] ?? 'string';
      properties[arg.name] = {
        type,
        ...(arg.help ? { description: arg.help } : {}),
      };
      if (arg.required) required.push(arg.name);
    }
    out.push({
      type: 'function',
      function: {
        name: `${def.site}__${def.name}`,
        description: def.description ?? '',
        parameters: { type: 'object', properties, required },
      },
    });
  }
  return out;
}

/** Every registered tool as a compact command descriptor (tool id + arg schema),
 * for the workflow step editor (T6b) / external catalog. */
export function allAdapterCommands(): AdapterCommand[] {
  return (getRegistry() as AdapterDef[]).map((d) => ({
    tool: `${d.site}__${d.name}`,
    site: d.site,
    name: d.name,
    description: d.description,
    access: d.access,
    args: d.args as AdapterCommand['args'],
    columns: d.columns,
    kind: 'unknown',
  }));
}

export function lookupAdapter(toolName: string): AdapterDef | null {
  const sep = toolName.indexOf('__');
  if (sep < 0) return null;
  const site = toolName.slice(0, sep);
  const name = toolName.slice(sep + 2);
  for (const def of getRegistry() as AdapterDef[]) {
    if (def.site === site && def.name === name) return def;
  }
  return null;
}
