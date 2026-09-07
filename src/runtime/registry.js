/**
 * Adapter registry — mirrors the @jackwener/opencli/registry surface so an
 * UNMODIFIED opencli adapter can `import { cli, Strategy, getRegistry } from
 * '@jackwener/opencli/registry'` and register itself here (the import is
 * resolved to this file by the Vite alias in vite.config.ts).
 *
 * Each adapter calls cli({...}) at module top-level; importing the adapter
 * file is what registers it.
 *
 * Differences from opencli's registry that are intentional:
 *   - getRegistry() returns an ARRAY (opencli returns a Map). Nothing in our
 *     codebase or in adapter `func` bodies calls getRegistry(); it's read only
 *     by our host code (manifest.ts / api-system-prompt.ts), which expects an
 *     array. Adapters that somehow iterate it still work (arrays are iterable).
 *   - We don't run opencli's normalizeCommand() strategy→browser/navigateBefore
 *     decoding; the extension dispatcher derives tab handling from `site`
 *     instead. We still STORE strategy/navigateBefore/domain verbatim so the
 *     dispatcher can honor them later without a registry change.
 */

/**
 * Strategy values, byte-aligned with opencli's enum (PUBLIC/LOCAL/COOKIE/
 * INTERCEPT/UI). The two legacy values our first adapters used (DIRECT/AUTO)
 * are kept as aliases so older vendored files keep registering.
 */
export const Strategy = Object.freeze({
  PUBLIC: 'public',
  LOCAL: 'local',
  COOKIE: 'cookie',
  INTERCEPT: 'intercept',
  UI: 'ui',
  // legacy aliases (pre-opencli-alignment)
  DIRECT: 'direct',
  AUTO: 'auto',
});

const _registry = [];

/** Monotonically increasing counter bumped on every successful
 * registration / unregistration. Engines compare a per-session snapshot to
 * this to detect "the tool catalog changed since I last anchored my prompt /
 * pulled my tools array", so the user sees newly installed adapters in their
 * IN-PROGRESS session without having to start a new conversation. */
let _version = 0;
export function getRegistryVersion() {
  return _version;
}

/** Recognized opencli command fields, copied through verbatim so the stored
 * definition is a faithful superset. Anything not listed is still tolerated
 * (we spread the original first), this list just documents intent. */
export function cli(def) {
  if (!def || typeof def !== 'object') {
    throw new Error('cli() expects a definition object');
  }
  if (!def.site || !def.name) {
    throw new Error(
      `cli() definition missing site/name: ${JSON.stringify({ site: def.site, name: def.name })}`,
    );
  }
  // opencli permits func-less commands whose logic lives in a declarative
  // `pipeline` (these run via runtime/opencli/pipeline.ts). Installed func
  // adapters land here with neither: the captured def can't carry the func
  // closure across the sandbox→IDB→SW serialization, so dispatcher routes
  // them to `_userScriptSource` (string source re-evaled in the page). Only
  // warn when ALL three execution paths are absent — then it genuinely
  // can't run.
  const hasPipeline = Array.isArray(def.pipeline) && def.pipeline.length > 0;
  const hasUserScriptSource = typeof def._userScriptSource === 'string' && def._userScriptSource.length > 0;
  if (typeof def.func !== 'function' && !hasPipeline && !hasUserScriptSource) {
    console.warn(`[registry] ${def.site}/${def.name} registered with neither func nor pipeline — it cannot execute.`);
  }
  // De-dupe on (site, name) so re-importing an adapter (HMR / double _all)
  // doesn't double-register. Last write wins, matching opencli's Map.put.
  const key = `${def.site}/${def.name}`;
  const existingIdx = _registry.findIndex((d) => `${d.site}/${d.name}` === key);
  const stored = { access: 'read', ...def };
  if (existingIdx >= 0) _registry[existingIdx] = stored;
  else _registry.push(stored);
  _version++;
  return stored;
}

export function getRegistry() {
  return _registry.slice();
}

export function findAdapter(site, name) {
  return _registry.find((d) => d.site === site && d.name === name);
}

/**
 * Remove a registered adapter by (site, name). Used when a runtime-installed
 * adapter is uninstalled or disabled. Returns true if something was removed.
 * Built-in adapters can be removed too (caller's responsibility not to), so
 * the install manager only ever unregisters ones it marked `_installed`.
 */
export function unregister(site, name) {
  const idx = _registry.findIndex((d) => d.site === site && d.name === name);
  if (idx < 0) return false;
  _registry.splice(idx, 1);
  _version++;
  return true;
}

/** opencli compat: `${site}/${name}`. Some adapters import this helper. */
export function fullName(cmd) {
  return `${cmd.site}/${cmd.name}`;
}

/** opencli compat: low-level register. We route it through cli() so dedupe +
 * defaults apply uniformly. */
export function registerCommand(cmd) {
  return cli(cmd);
}

/* ───────── lifecycle hooks (opencli /registry re-exports these) ─────────
 * opencli runs onStartup before discovery and onBeforeExecute/onAfterExecute
 * around each command. The extension dispatcher doesn't run a hook pipeline
 * yet, so these register the fn (kept for a future dispatcher pass) and are
 * otherwise no-ops — present so adapters that import them resolve cleanly. */
const _hooks = { startup: [], beforeExecute: [], afterExecute: [] };
export function onStartup(fn) {
  _hooks.startup.push(fn);
}
export function onBeforeExecute(fn) {
  _hooks.beforeExecute.push(fn);
}
export function onAfterExecute(fn) {
  _hooks.afterExecute.push(fn);
}
export function getHooks() {
  return _hooks;
}
