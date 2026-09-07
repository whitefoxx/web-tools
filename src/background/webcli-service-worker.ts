/**
 * WebCLI service worker — the entry point of the pure-bridge extension
 * (manifest.webcli.json / "WebCLI"). NO in-browser agent, NO site adapters, NO
 * SidePanel: it registers only the GENERIC browser tools and exposes them to
 * external agents over ONE transport — the WS bridge (Claude Code / Codex via
 * the local daemon).
 *
 * Web-app access (the runtime-registered relay + Port MCP for user-added
 * origins, 0.2.0's headline) was REMOVED in 0.3.0: that use case moved wholesale
 * to the localmd Connect shell, which serves it with the adapter/site-script
 * surface web apps actually want. The shared machinery stays in `core/`
 * (web-origins, external-mcp-core) — this shell just no longer wires it. See
 * docs/webcli.md §15 (superseded) and docs/localmd-connect.md §8.
 *
 * Everything heavy (agent engine, adapter pool, explore, marketplace, SidePanel
 * UI, schedules) is absent BY CONSTRUCTION: this file imports only `core/*`, the
 * shared-base tool set, `site-scripts/*` (a base primitive now — see below), and
 * the clean tab/keepalive helpers. That is what keeps the bundle a fraction of
 * the full SW. See docs/webcli.md and docs/architecture.md §A.2.
 */
import { log, warn } from '../runtime/log';
import { openAiToolsFromRegistry } from '../tools/manifest';
import { executeGenericTool } from '../core/execute-generic';
import { createBridge } from '../core/bridge-core';
import { createWsBridge } from '../core/ws-bridge';
import {
  loadToolProfile,
  isInProfile,
  coerceProfile,
  TOOL_PROFILE_KEY,
  type ToolProfile,
} from '../core/tool-profile';
import { WEB_ORIGINS_KEY, isRelayScriptId } from '../core/web-origins';
import { createIdleSweep } from '../core/idle-sweep';
import { onBridgeBusy, onBridgeIdle } from './runtime-state';
import { closeIdleAgentWindow } from './agent-window';

// Register the generic browser tools (side-effect cli({...}) registration). This
// is the LITE subset — no explore/marketplace/selection tools. See _generic.ts.
import '../tools/generic/_generic';
// Site scripts are a shared-base primitive now (docs/architecture.md §A.2): the
// persistent user rules must be re-applied when the SW boots, exactly as the
// full and localmd SWs do. The popup (src/webcli/) is the user's standing control.
import { syncSiteScriptsOnBoot } from '../site-scripts/register';

const SCOPE = 'webcli-sw';
// WebCLI defaults to 9376 — a distinct port from the full extension's bridge
// (8787), so both can run side by side without competing for a daemon's single
// connection. The DEV build (`npm run build:webcli:dev`, docs/webcli.md §13) needs
// the same separation from the STORE build of WebCLI itself — a developer runs
// both at once — so it takes 9377 and announces itself under a distinct client
// name, making it unambiguous in the daemon's logs which install answered a call.
const CLIENT_NAME = __WEBCLI_DEV__ ? 'webcli-dev' : 'webcli';
const DEFAULT_PORT = __WEBCLI_DEV__ ? 9377 : 9376;
const BRIDGE_CALL_TIMEOUT_MS = 240_000;
const ENABLED_KEY = 'bridgeEnabled';
const PORT_KEY = 'bridgePort';
const REDIAL_ALARM = 'webcli-redial';

log(SCOPE, 'WebCLI service worker booting');

// Re-apply the user's persistent site scripts (best-effort; needs "Allow user
// scripts"). A no-op when there are none or the toggle is off.
void syncSiteScriptsOnBoot().catch((e) => warn(SCOPE, 'syncSiteScriptsOnBoot failed', e));

// The shared external-tool executor: GENERIC tools only, no synthetic control
// tools. The write gate is deliberately open here (allowWrites always true,
// empty deny list): WebCLI has no UI to approve a prompt against, and its whole
// contract is "an external agent drives this browser". `call_webmcp_tool` is the
// one generic tool marked `access:'write'` — in the FULL shell it meets the
// normal confirmation gate; here the calling agent is the one accountable.
// The busy hooks pin the MV3 worker while a call is in flight (F-8), reusing
// the same keepalive as the full shell.
// Tidy-up, once the calling agent has been quiet for this long. There is exactly
// ONE thing this shell may clean up: the agent WINDOW, once the only thing left
// in it is the blank placeholder. The tabs themselves are the caller's — it holds
// their ids and closes them with close_tab — and taking one away because a task
// paused would break the promise the whole external-control contract rests on.
// An empty window promises nothing. See §10.48.
const IDLE_SWEEP_MS = 10_000;
const idleSweep = createIdleSweep(async () => {
  if (await closeIdleAgentWindow()) log(SCOPE, 'idle sweep closed the empty agent window');
}, IDLE_SWEEP_MS);

const bridge = createBridge({
  execute: executeGenericTool,
  controlTools: {},
  getAllowWrites: () => true,
  getDenySites: () => [],
  writeDisabledMsg: '',
  onBusy: onBridgeBusy,
  onIdle: onBridgeIdle,
  onCallStart: idleSweep.onCallStart,
  onCallEnd: idleSweep.onCallEnd,
});

// WebCLI has no External access audit UI, so calls are not persisted — a no-op
// recorder satisfies the transport's audit sink.
const recordCall = (): void => {};

// ── tool-set profile (core/tool-profile) ──
// Both catalog builders are synchronous, so the profile is cached here and kept
// fresh by the storage listener below. It only narrows what is ADVERTISED —
// every registered tool stays callable by name whatever the profile says.
let toolProfile: ToolProfile = 'full';
const inProfile = (toolId: string): boolean => isInProfile(toolId, toolProfile);

// ── WS bridge (Claude Code / Codex via the local `bridge/` daemon) ──
const wsBridge = createWsBridge({
  defaultPort: DEFAULT_PORT,
  clientName: CLIENT_NAME,
  clientVersion: () => chrome.runtime.getManifest().version,
  buildCatalog: () => openAiToolsFromRegistry().filter((t) => inProfile(t.function.name)),
  runCall: (tool, args) => bridge.runExternalTool(tool, args),
  recordCall,
  callTimeoutMs: BRIDGE_CALL_TIMEOUT_MS,
});

async function loadBridgePrefs(): Promise<{ enabled: boolean; port: number }> {
  let enabled = true; // ON by default (no UI to enable it)
  let port = DEFAULT_PORT;
  try {
    const got = await chrome.storage.local.get([ENABLED_KEY, PORT_KEY]);
    if (got[ENABLED_KEY] === false) enabled = false;
    port = Number(got[PORT_KEY]) || DEFAULT_PORT;
  } catch {
    /* storage unavailable — fall back to defaults */
  }
  return { enabled, port };
}

// Start the WS bridge on every SW start (incl. an MV3 wake) so it re-establishes
// after a recycle. The profile is read BEFORE start() so the first catalog push
// already reflects it — pushing the full set and correcting it a moment later
// would leave whatever the peer cached first.
void (async () => {
  toolProfile = await loadToolProfile();
  const { enabled, port } = await loadBridgePrefs();
  wsBridge.start(enabled, port);
})();

// A profile change re-pushes the catalog, so an already-connected agent sees the
// new surface without a reconnect.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[TOOL_PROFILE_KEY]) return;
  const next = coerceProfile(changes[TOOL_PROFILE_KEY].newValue);
  if (next === toolProfile) return;
  toolProfile = next;
  log(SCOPE, `tool profile → ${next}`);
  wsBridge.refreshCatalog();
});

// Reconnect safety net (fixes the "daemon started after the extension" gap): a
// disconnected SW has no heartbeat to keep it warm, so MV3 recycles it before the
// backoff retry fires and it never redials. A 1-minute alarm wakes the SW and
// redials — poke() is a no-op when already connected. The alarm firing on a
// cold-started SW also re-runs the top-level start() above; the handler covers
// the alive-but-disconnected case. (This is why WebCLI keeps the `alarms` perm.)
chrome.alarms.create(REDIAL_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === REDIAL_ALARM) wsBridge.poke();
});

// ── Web-app access removal cleanup (0.3.0) ──
// 0.2.0 installs may carry two artifacts of the removed feature: the stored
// origin allowlist, and (belt-and-braces — an extension update already clears
// dynamic scripts) leftover relay content-script registrations. Sweep both once
// per install/update so nothing keeps pointing at the now-absent web-relay.js.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.remove(WEB_ORIGINS_KEY);
  void chrome.scripting
    .getRegisteredContentScripts()
    .then((scripts) => {
      const stale = scripts.filter((s) => isRelayScriptId(s.id)).map((s) => s.id);
      if (stale.length) {
        log(SCOPE, `removing ${stale.length} leftover relay content script(s)`);
        return chrome.scripting.unregisterContentScripts({ ids: stale });
      }
    })
    .catch(() => {
      /* nothing registered — fine */
    });
});

// Status query for the toolbar popup (src/webcli/popup.ts): report the live
// daemon-connection state + port + tool-profile counts.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'WEBCLI_STATUS') {
    const s = wsBridge.status();
    // Counts come from the live registry, never a constant in the popup — the
    // number the user reads has to move when the tool set does.
    const all = openAiToolsFromRegistry();
    sendResponse({
      connected: s.connected,
      enabled: s.enabled,
      port: s.port,
      profile: toolProfile,
      toolsTotal: all.length,
      toolsAdvertised: all.filter((t) => inProfile(t.function.name)).length,
    });
    return true;
  }
  return undefined;
});

chrome.runtime.onStartup.addListener(() => log(SCOPE, 'onStartup'));
