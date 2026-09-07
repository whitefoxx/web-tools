/**
 * Tool-command descriptors — shared BASE types.
 *
 * `AdapterCommand` (a registered tool as a compact command descriptor: id + arg
 * schema) and its `ExploreAdapterArg` arg shape are produced by the generic tool
 * registry (`tools/manifest.ts` `allAdapterCommands`), which is part of the base.
 * They lived in `messages.ts` originally, but that pulled the whole message
 * catalog — and its full-only arms (plan / memory / notes / schedule /
 * adapter-health) — into the base closure through an inline type reference to
 * AdapterCommand in `manifest.ts`. Hoisting these two leaf shapes here severs
 * that edge (P4, docs/architecture.md §A); `messages.ts` re-exports them so its
 * existing importers are unaffected.
 */

/** One argument in a tool/command's parsed schema. */
export interface ExploreAdapterArg {
  name: string;
  type?: string;
  required?: boolean;
  help?: string;
  default?: unknown;
}

/** A registered tool as a compact command descriptor (tool id + arg schema),
 * for the workflow step editor / external catalog. */
export interface AdapterCommand {
  /** Dispatcher tool id, `${site}__${name}`. */
  tool: string;
  site: string;
  name: string;
  description?: string;
  access?: 'read' | 'write';
  args?: ExploreAdapterArg[];
  columns?: string[];
  kind: 'pipeline' | 'func' | 'unknown';
}
