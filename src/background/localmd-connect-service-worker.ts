/**
 * localmd Connect service worker — the entry point of the third shell
 * (manifest.localmd.json / "localmd Connect"), the paid companion extension for
 * localmd.app. It exposes the generic browser tools (incl. eval_js + the recon
 * primitives) PLUS persistent SITE SCRIPTS that localmd's own agent drives —
 * create/list/enable/delete/preview (userScripts registration,
 * src/site-scripts/*). Site adapters (find_adapters / run_adapter) were retired
 * 2026-09-06: reaching a site is a skill the agent builds from the base
 * primitives and the user saves in their own skills dir (docs/architecture.md
 * §A.5).
 *
 * ONE WAY IN, and it is a web page. The shipping build reaches the outside world
 * only through the relay, on a FIXED origin list compiled in below — there is no
 * user-editable allowlist and no WS daemon, so nothing outside the browser can
 * connect at all. The daemon bridge exists only under `__LOCALMD_DEV__`, where a
 * CLI agent (Claude Code / Codex) drives this shell for testing; in the shipped
 * bundle that whole branch is dead code the bundler drops, which is why the
 * store manifest does not even ask for `alarms`.
 *
 *   • knowledge-base CAPTURE — clip_page for the agent, and a context menu /
 *     shortcut / popup path for the user that parks clips and "ask localmd"
 *     requests in an inbox localmd drains (src/localmd-connect/inbox.ts,
 *     docs/localmd-connect.md §14).
 *
 * Still absent BY CONSTRUCTION: the agent engine, sessions, explore, SidePanel,
 * schedules, secrets, page-llm — localmd brings its own agent; this shell only
 * executes tools. See docs/localmd-connect.md.
 */
import { log, warn } from '../runtime/log';
import { openAiToolsFromRegistry } from '../tools/manifest';
import { executeGenericTool } from '../core/execute-generic';
import { createIdleSweep } from '../core/idle-sweep';
import { closeIdleAgentWindow } from './agent-window';
import { createBridge } from '../core/bridge-core';
import { createWsBridge } from '../core/ws-bridge';
import { createExternalMcpHandler } from '../core/external-mcp-core';
import { askModelViaApp, wakeApp, type AskModelResult } from '../localmd-connect/ask-model';
import { cachedAnswer, promptKey, rememberAnswer } from '../localmd-connect/prompt-cache';
import {
  RELAY_PORT_NAME,
  normalizeOriginInput,
  relayScriptIdFor,
  isRelayScriptId,
} from '../core/web-origins';
import { onBridgeBusy, onBridgeIdle } from './runtime-state';
import {
  syncSiteScriptsOnBoot,
  siteScriptsRunnable,
  refreshSiteScript,
  unregisterSiteScriptById,
} from '../site-scripts/register';
import { listSiteScripts, setSiteScriptEnabled, deleteSiteScript } from '../site-scripts/store';
import { inboxCount, onInboxChange, LOCALMD_FRAME_BYTES } from '../localmd-connect/inbox';
import { loadKbFolders } from '../localmd-connect/kb-folders';
import { lookupInKb } from '../localmd-connect/kb-index';
import { loadHighlights, pageKey } from '../selection/highlights-store';
import { loadPageTools, savePageTools, mergePageTools } from '../localmd-connect/page-settings';
import { showToast, toastCopy } from '../localmd-connect/page-toast';
import {
  actionForMenuId,
  captureToInbox,
  type AskContext,
  COMMAND_IDS,
  ensureLocalmdTab,
  installCaptureMenus,
  paintInboxBadge,
  userActiveTab,
  type CaptureAction,
} from '../localmd-connect/capture-actions';

// Register the localmd Connect tool surface (side-effect cli({...}) registration):
// the 28 generic tools + eval_js + recon (find_in_dom / find_structured_data /
// get_a11y_tree / capture_network) + site scripts.
import '../tools/generic/_localmd';

const SCOPE = 'localmd-sw';
// 9378 (dev only) — distinct from the full bridge (8787), WebCLI (9376) and
// WebCLI-dev (9377), so every shell can run side by side while testing.
const CLIENT_NAME = 'localmd-connect-dev';
const DEFAULT_PORT = 9378;
const BRIDGE_CALL_TIMEOUT_MS = 240_000;
const ENABLED_KEY = 'bridgeEnabled';
const PORT_KEY = 'bridgePort';
const REDIAL_ALARM = 'localmd-redial';

/**
 * The origins allowed to reach the tools — COMPILED IN, not user-editable.
 *
 * This shell serves exactly one web app, so an "add a site" box would only ever
 * be a way to grant a site the user was talked into typing. A fixed list also
 * means there is no stored state to migrate, seed, or repair.
 *
 * The localhost entries are DEV ONLY, deliberately: `localhost:5173` is Vite's
 * default port, so shipping it would hand full cookie-authenticated browser
 * control to whatever dev server a user happens to be running. 8123 is this
 * repo's fixture server (docs/tests/fixtures).
 */
const ALLOWED_ORIGINS: string[] = __LOCALMD_DEV__
  ? ['https://localmd.app', 'http://localhost:5173', 'http://localhost:8123']
  : ['https://localmd.app'];

/**
 * Where localmd IS, for this build — a different question from the one above.
 * ALLOWED_ORIGINS says who may reach the tools; this says which page a capture
 * should go to, and there is exactly ONE right answer per build: a dev build
 * drives the dev app, a shipping build drives the published one.
 *
 * Two earlier versions of this line were wrong in the same way — they treated
 * the answer as a SEARCH over several candidates. First it was the whole
 * allowlist, so "Ask localmd" focused this repo's fixture server. Then it was
 * both app origins with a most-recently-used tiebreak, so a dev build still
 * jumped to production whenever a localmd.app tab happened to be open. The
 * build already knows which app it belongs to; nothing needs to be inferred
 * from what the user has open.
 */
const LOCALMD_APP_ORIGINS: string[] = __LOCALMD_DEV__
  ? ['http://localhost:5173']
  : ['https://localmd.app'];

log(SCOPE, 'localmd Connect service worker booting');

// Re-register enabled site scripts on every SW start (extension updates clear
// dynamically registered user scripts; IDB is the source of truth).
void syncSiteScriptsOnBoot();

// Tidy-up, once the calling app has been quiet for this long. Two things, and
// neither is a tab the caller holds: the site-tab POOL (opened by the adapter
// executor, its ids never leave it) and the agent WINDOW when the only thing
// left in it is the blank placeholder. Both used to survive until the browser
// closed — the full shell reaps its pool on the same signal, this shell simply
// never armed one. See §10.48.
const IDLE_SWEEP_MS = 10_000;
const idleSweep = createIdleSweep(async () => {
  if (await closeIdleAgentWindow()) log(SCOPE, 'idle sweep closed the empty agent window');
}, IDLE_SWEEP_MS);

// The shared external-tool executor. Same open write gate as WebCLI: this shell
// has no UI to approve a prompt against — the confirm step for write adapters
// and css/js site scripts is DELEGATED to the calling app (localmd) by contract.
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

// No audit UI in this shell — a no-op recorder satisfies both transports.
const recordCall = (): void => {};

// ── WS bridge — DEV BUILD ONLY (bridge daemon on 9378) ──
// The shipping extension has no way in from outside the browser. This branch
// exists so a CLI agent can drive the shell while developing it, and
// `__LOCALMD_DEV__` is a build-time literal, so the bundler drops the whole
// thing — createWsBridge included — from dist-localmd/.
const wsBridge = __LOCALMD_DEV__
  ? createWsBridge({
      defaultPort: DEFAULT_PORT,
      clientName: CLIENT_NAME,
      clientVersion: () => chrome.runtime.getManifest().version,
      // No tool profile in this shell: localmd defers/gates tools on its own
      // side, so the full registry (including loaded adapters) is advertised.
      buildCatalog: () => openAiToolsFromRegistry(),
      runCall: (tool, args) => bridge.runExternalTool(tool, args),
      recordCall,
      callTimeoutMs: BRIDGE_CALL_TIMEOUT_MS,
    })
  : null;

if (__LOCALMD_DEV__ && wsBridge) {
  const ws = wsBridge;
  void (async () => {
    let enabled = true; // ON by default (no UI to enable it)
    let port = DEFAULT_PORT;
    try {
      const got = await chrome.storage.local.get([ENABLED_KEY, PORT_KEY]);
      if (got[ENABLED_KEY] === false) enabled = false;
      port = Number(got[PORT_KEY]) || DEFAULT_PORT;
    } catch {
      /* storage unavailable — fall back to defaults */
    }
    ws.start(enabled, port);
  })();

  // Reconnect safety net — same rationale as WebCLI's redial alarm (a
  // disconnected SW has no heartbeat; MV3 recycles it before backoff fires).
  chrome.alarms.create(REDIAL_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === REDIAL_ALARM) ws.poke();
  });
}

/** Outbound frame ceiling for THIS shell. The core's 1MB default was sized for
 * text; a clip with inlined images or a sized full-page screenshot is
 * legitimately several MB, and postMessage does not care. Inbound stays 1MB. */
const MAX_OUTBOUND_BYTES = LOCALMD_FRAME_BYTES;
/** How many of a page's highlights the popup's menu carries. Beyond this the
 *  menu points at the annotations page, which is built for a long list. */
const POPUP_MARKS = 50;
const INBOX_NOTIFICATION = 'notifications/localmd/inbox';
/** "The user picked another knowledge base in the popup." A request, not an
 *  instruction: only localmd can open a folder, and only its next
 *  `sync_kb_folders` says whether it did. */
const OPEN_KB_NOTIFICATION = 'notifications/localmd/open-kb';

// ── Port MCP for localmd — allowed origins over the relay, NO web_task ──
const LOCALMD_CONNECT_INSTRUCTIONS =
  "localmd Connect exposes the user's logged-in Chrome as browser tools " +
  'and persistent SITE SCRIPTS (no in-extension agent — you are the agent). Call tools/list for the exact surface. ' +
  'REACH A MAINSTREAM SITE BY BUILDING THE EXTRACTION LIVE with eval_js {tab_id, code}: it runs async JS in the page\'s own origin (its ' +
  'cookies, globals and JS APIs; returns JSON). Robustness ladder — stop at the first that works: (1) the site\'s ' +
  "own JSON API — fetch(api, {credentials:'include'}) — zero selectors, most durable; (2) embedded page state " +
  '(__NEXT_DATA__ / __NUXT__ / a <script type=json>); (3) the site\'s OWN UI as the data source when a private ' +
  'API is locked behind a token/signature/pot — drive the panel or list a user clicks and read the DOM (a YouTube ' +
  "transcript comes from its 'Show transcript' panel, NOT the pot-locked caption API, which now fails); (4) last " +
  'resort, scrape the DOM with STABLE selectors (data-testid / aria / semantic tags / href) — never random ' +
  'build-hash classes. REDUCE TO ROWS INSIDE THE PAGE — return the data you need, not the whole payload. A read ' +
  'that must POST (GraphQL / InnerTube) needs allow_write:true. When it works, save it as a KB skill so next time ' +
  'is one call, not a rebuild. ' +
  'SITE SCRIPTS persist across sessions: create_site_script {matches, hide_selectors, css, js} makes a rule run on ' +
  'every matching page load (ad removal, decluttering, enhancement). Verify with preview_site_script first ' +
  '(selector match counts, js dry-run), and by contract you MUST show your user what will be injected and get ' +
  'confirmation before creating css/js scripts. The user can disable/delete any script from the extension popup. ' +
  'JUST READING A PAGE IS ONE CALL: fetch_url {url, format:"markdown"} needs no tab — use it FIRST for ' +
  'server-rendered content. If it comes back empty, the page is JS-rendered: get_page_text {url} opens a real tab, ' +
  'reads and closes it. READ THEN ACT is one call too: get_page_text {url, keep_open:true} returns text AND a live ' +
  'tabId. Interaction loop: get_interactives {tab_id} → click/type_into {tab_id, ref} → re-read with get_page_text ' +
  '{tab_id}; fill_form sets many fields in one pass. When the links on a page matter (you may follow one next), ' +
  'read with format:"markdown" — links and images come back as absolute URLs; plain text drops them. Prefer text ' +
  'over screenshot (images cost many tokens); when you must, size it (max_width:1024, format:"webp"). ' +
  'SAVING A PAGE INTO THE KNOWLEDGE BASE: clip_page {url|tab_id, mode, images} returns metadata (canonical URL, ' +
  'site, author, dates, description) + main-content Markdown + image URLs (images:"inline" fetches them as data ' +
  'URLs) — YOU write the note and its image files; mode:"selection" clips what the user selected and carries a ' +
  'TextQuote anchor for citing back. THE USER CAN ALSO CAPTURE FROM THE BROWSER (context menu, shortcut, popup): ' +
  'those land in an inbox — the extension sends notifications/localmd/inbox {count} when it changes; call ' +
  'list_inbox, write each clip / answer each "ask" (attach its tab), then ack_inbox {ids}. ' +
  "THE BROWSER'S OWN DATA is a source too, behind permissions the user grants in the extension popup: " +
  'search_bookmarks / list_bookmarks (what they saved), search_history (what they actually read — reaches things no ' +
  'note ever captured), list_reading_list (read-it-later, a stronger signal of intent than history), ' +
  'list_recently_closed (the session that just ended). All paginated — pass next_cursor back. A tool that answers ' +
  '"permission_required: X" is NOT broken and must NOT be retried: tell the user to switch on X under "Browser data" ' +
  'in the popup, which is the only place it can be granted. create_bookmark and add_to_reading_list change the ' +
  "user's browser — confirm first, and so do delete_bookmark / remove_from_reading_list / " +
  'set_reading_list_read. A delete returns what it removed, so create_bookmark or add_to_reading_list puts it back. ' +
  'Finished with a reading-list page (you clipped it)? set_reading_list_read keeps the record; removing loses it. ' +
  'WHAT THE USER HIGHLIGHTED is the strongest signal of all: they marked it by hand. get_highlights {url|query} ' +
  'returns each passage with its colour, the note they wrote on it, and an anchor to find it again; clip_page ' +
  "already carries a page's highlights, so a clip and its annotations arrive together. delete_highlights removes " +
  "them (confirm first — it deletes the user's own annotations) once they are safely in the knowledge base. " +
  'TABS ARE YOURS: a tabId you are handed stays valid until you close_tab it — nothing reclaims one behind your ' +
  'back — so close background tabs when done. A result with "tab_closed": true already disposed of its own tab. ' +
  'Tools that return "tool not found" are not part of localmd Connect.';

// ── Waking the app for a question that needs it ──
// The relay lives inside a localmd tab, so for someone reading an article the
// normal state is "nobody is connected". Clips already answer that by opening
// the app in the background; a selection quick action needs the answer BACK, so
// it also has to wait for the page to finish its handshake. Event-driven rather
// than polled: `onClientReady` above is exactly that moment.
const clientWaiters = new Set<() => void>();
/** How long a freshly opened tab gets to load the app and connect. */
const APP_WAKE_MS = 20_000;

function onNextClientReady(): void {
  for (const w of [...clientWaiters]) w();
  clientWaiters.clear();
}

function waitForClient(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      clientWaiters.delete(done);
      reject(new Error('no handshake'));
    }, APP_WAKE_MS);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    clientWaiters.add(done);
  });
}

/**
 * Post the relay's own `ready` frame into a tab again.
 *
 * Injected rather than sent, because the whole problem is that there is no port
 * to send anything on. The relay content script in that tab is alive (the
 * service worker re-injects it into open tabs at boot, and a ping answers) — it
 * is the APP that has not started a new conversation, and `ready:true` is the
 * signal it already understands for "the relay is attached, talk to me".
 */
async function nudgeRelay(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (ext: string) => {
      window.postMessage(
        { webcli: 'mcp', dir: 'to-page', ext, ready: true },
        window.location.origin,
      );
    },
    args: [chrome.runtime.id],
  });
}

/**
 * One selection prompt, answered — from the last ten answers when the exact
 * same filled prompt has been asked before.
 *
 * Cached on the FILLED prompt, which already carries the template, the passage
 * and the output language, so one saved prompt is separated from another for
 * free and any change to any of them misses. `fresh` is the way back: the
 * popover's "cached" tag re-runs through here with it set.
 */
async function answerSelection(
  ask: { prompt: string; label?: string; url?: string },
  fresh: boolean,
): Promise<AskModelResult & { cached?: boolean }> {
  const key = promptKey(ask.prompt);
  if (!fresh) {
    const hit = await cachedAnswer(key);
    if (hit) {
      log(SCOPE, `selection ${ask.label ?? 'ask'} → cached`, { out: hit.length });
      return { ok: true, result: hit, cached: true };
    }
  }
  const r = await askModelViaApp(
    {
      // Addressed to THIS build's app, not to whoever connected last. The dev
      // allowlist also admits localmd.app so the published app can be driven
      // for testing, and "the most recent page" would have quietly sent a dev
      // build's question there — the third time that mistake has been
      // available to make (see LOCALMD_APP_ORIGINS).
      request: (method, params) =>
        handleExternalConnect.request(method, params, { origins: LOCALMD_APP_ORIGINS }),
      wakeApp: wakeLocalmdForRequest,
    },
    ask,
  );
  log(SCOPE, `selection ${ask.label ?? 'ask'} → ${r.ok ? 'ok' : r.error}`, {
    in: ask.prompt.length,
    out: r.ok ? r.result.length : 0,
  });
  if (r.ok) void rememberAnswer(key, r.result, ask.label);
  return r;
}

function wakeLocalmdForRequest(): Promise<void> {
  return wakeApp({
    // In the background: the user is reading a page and asked about a passage
    // on it. Taking them to localmd would answer the question somewhere they
    // are not looking.
    ensureTab: async () => {
      const { tab, opened } = await ensureLocalmdTab(LOCALMD_APP_ORIGINS, false);
      return { tabId: typeof tab.id === 'number' ? tab.id : null, opened };
    },
    nudge: nudgeRelay,
    waitForClient,
  });
}

const handleExternalConnect = createExternalMcpHandler({
  runExternalTool: (tool, args, origin) => bridge.runExternalTool(tool, args, origin),
  isExternalTool: bridge.isExternalTool,
  recordCall,
  callTimeoutMs: BRIDGE_CALL_TIMEOUT_MS,
  serverName: CLIENT_NAME,
  serverVersion: () => chrome.runtime.getManifest().version,
  webTask: undefined, // no agent engine in this shell
  instructions: LOCALMD_CONNECT_INSTRUCTIONS,
  maxOutboundBytes: MAX_OUTBOUND_BYTES,
  // A page that just finished its handshake may have missed the live poke
  // (captured while it was loading, or before it existed) — tell it now.
  onClientReady: (notify) => {
    void inboxCount().then((count) => {
      if (count > 0) notify(INBOX_NOTIFICATION, { count });
    });
    onNextClientReady();
  },
  // The compiled-in list, checked as an EXACT origin (port included). Kept
  // async because the handler's contract is async — a relay connect can be the
  // event that WAKES this SW, so it buffers frames until this resolves.
  allowedOrigins: async () => new Set(ALLOWED_ORIGINS),
  scope: SCOPE,
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === RELAY_PORT_NAME) handleExternalConnect(port);
});

// ── Capture inbox: the push half ──
// Every change pokes each handshaken localmd page and repaints the badge. The
// badge is the user's receipt that a capture happened even with localmd closed.
onInboxChange((count) => {
  const reached = handleExternalConnect.broadcast(INBOX_NOTIFICATION, { count });
  paintInboxBadge(count);
  log(SCOPE, `inbox changed (${count} pending) — poked ${reached} page(s)`);
});
void inboxCount().then(paintInboxBadge);

// ── "This page is in your KB" ──
// One icon, two things it can say. Pending captures win (a number the user
// should act on); otherwise a page localmd has already written down gets "KB".
// Repainted when the active tab changes or navigates. Cheap: one storage read.
async function paintKbMark(tabId: number): Promise<void> {
  // The KB mark is per-TAB and the pending count is global, and Chrome shows
  // the per-tab one where it exists. So they no longer compete: a saved page
  // says KB, every other tab shows whatever is waiting.
  //
  // This used to bail while anything was pending, which meant one item stuck in
  // the queue hid the mark on every page, forever — and that is exactly how it
  // was first seen, as "the badge does not work".
  let url: string;
  try {
    url = (await chrome.tabs.get(tabId)).url ?? '';
  } catch {
    return; // the tab closed under us
  }
  const known = /^https?:/.test(url) ? await lookupInKb(url) : null;
  try {
    await chrome.action.setBadgeText({ tabId, text: known ? 'KB' : '' });
    if (known) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' });
  } catch {
    /* no action API here */
  }
}
chrome.tabs.onActivated.addListener(({ tabId }) => void paintKbMark(tabId));

// The mark is a read of the index, so it has to be repainted when the INDEX
// changes and not only when the tab does. localmd corrects the index whenever a
// note is deleted or moved (sync_saved_pages), and without this the tab the
// user is looking at keeps its green KB until they switch away and back — the
// same "the popup and the folder disagree" complaint one layer down.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.keys(changes).some((k) => k.startsWith('kbIndex:'))) return;
  // The active tab of every window: a background tab is repainted by
  // onActivated the moment it is looked at.
  void chrome.tabs
    .query({ active: true })
    .then((tabs) => {
      for (const t of tabs) if (typeof t.id === 'number') void paintKbMark(t.id);
    })
    .catch(() => undefined);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' || info.url) void paintKbMark(tabId);
});

/**
 * The tab a popup message is about.
 *
 * The popup NAMES it (`tabId`), because it can: `chrome.tabs.query({active,
 * currentWindow})` from a popup is unambiguous. Asking from here is not —
 * `lastFocusedWindow` can resolve to the popup's own surface while it has
 * focus, and then the extension decides the user is on no page at all, which
 * showed up as every popup button doing nothing. The fallback stays for the
 * keyboard commands, which have no popup to ask.
 */
async function tabFromMessage(msg: { tabId?: unknown }): Promise<chrome.tabs.Tab | null> {
  if (typeof msg.tabId === 'number') {
    try {
      return await chrome.tabs.get(msg.tabId);
    } catch {
      return null; // closed between the click and here
    }
  }
  return userActiveTab();
}

/** Run a capture action against a tab and route the user afterwards: a clip
 * makes sure a localmd tab EXISTS (background), an ask FOCUSES one. */
async function runCapture(
  action: CaptureAction,
  tab: chrome.tabs.Tab,
  selectionText?: string,
  context?: AskContext,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const copy = toastCopy(action);
  const tabId = typeof tab.id === 'number' ? tab.id : null;
  // Pin the worker for the duration. A region capture waits on a HUMAN dragging
  // a rectangle, which is easily longer than the idle timeout that recycles an
  // MV3 service worker — and a recycled worker drops the pending executeScript
  // and everything after it, silently.
  onBridgeBusy();
  // The page is where the user is looking, so it is where the receipt goes.
  // Without one, a capture that does not navigate is indistinguishable from
  // nothing having happened — which is how three working features were first
  // reported as broken.
  if (tabId !== null && copy.working) void showToast(tabId, copy.working, 'working');
  try {
    const item = await captureToInbox(action, tab, selectionText, context);
    const ask = action === 'ask_page' || action === 'ask_selection';
    await ensureLocalmdTab(LOCALMD_APP_ORIGINS, ask);
    if (tabId !== null) {
      const rows = (item.payload as { tabs?: unknown[] } | null)?.tabs;
      void showToast(tabId, copy.done(Array.isArray(rows) ? rows.length : undefined), 'ok');
    }
    return { ok: true, id: item.id };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    warn(SCOPE, `capture ${action} failed`, { error });
    // "cancelled" is the user closing the region overlay: not a failure, and
    // telling them they cancelled is noise.
    if (tabId !== null && error !== 'cancelled') void showToast(tabId, error, 'error');
    else if (tabId !== null) void showToast(tabId, '', 'ok'); // clear any working toast
    return { ok: false, error };
  } finally {
    onBridgeIdle();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void installCaptureMenus().catch((e) => warn(SCOPE, 'context menu install failed', e));
  void injectIntoOpenTabs();
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const action = actionForMenuId(info.menuItemId);
  if (!action || !tab || typeof tab.id !== 'number') return;
  void runCapture(action, tab, info.selectionText);
});
chrome.commands.onCommand.addListener((command) => {
  const action = COMMAND_IDS[command];
  if (!action) return;
  void userActiveTab().then((tab) => {
    if (tab) return runCapture(action, tab);
    warn(SCOPE, `command ${command}: no active tab`);
    return undefined;
  });
});

// ── Relay content-script registration ──
// Reconciled rather than re-created, and driven by the constant above rather
// than by storage: an extension UPDATE clears dynamic scripts, so this must run
// at every boot, but there is no user edit that can change what it wants.
async function syncRelayScripts(): Promise<void> {
  try {
    const desired = new Map<string, string>(); // script id → match pattern (host-level)
    for (const o of ALLOWED_ORIGINS) {
      try {
        const { pattern } = normalizeOriginInput(o);
        desired.set(relayScriptIdFor(pattern), pattern);
      } catch {
        /* unreachable: the list is a compile-time constant, not user input */
      }
    }
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const mine = registered.filter((s) => isRelayScriptId(s.id));
    const stale = mine.filter((s) => !desired.has(s.id)).map((s) => s.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
    const have = new Set(mine.map((s) => s.id));
    const missing = [...desired].filter(([id]) => !have.has(id));
    if (missing.length) {
      await chrome.scripting.registerContentScripts(
        missing.map(([id, pattern]) => ({
          id,
          js: ['web-relay.js'],
          matches: [pattern],
          runAt: 'document_start' as const,
          persistAcrossSessions: true,
        })),
      );
    }
    if (stale.length || missing.length) {
      log(SCOPE, `relay scripts synced (+${missing.length} −${stale.length})`, {
        origins: ALLOWED_ORIGINS.length,
      });
    }
  } catch (e) {
    log(SCOPE, 'relay script sync failed', { error: e instanceof Error ? e.message : String(e) });
  }
}
void syncRelayScripts();

// ── In-page highlighter registration ──
// One script, every http(s) page, registered once. It reads its own settings
// and disables itself, rather than being registered per host: registration then
// never churns when the blacklist changes, SPAs are covered for free, and a
// `storage.onChanged` listener switches tabs that are already open. See
// src/localmd-connect/page-settings.ts.
const PAGE_TOOLS_SCRIPT_ID = 'localmd-page-tools';

async function syncPageToolsScript(): Promise<void> {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    if (registered.some((r) => r.id === PAGE_TOOLS_SCRIPT_ID)) return;
    await chrome.scripting.registerContentScripts([
      {
        id: PAGE_TOOLS_SCRIPT_ID,
        js: ['page-tools.js'],
        matches: ['http://*/*', 'https://*/*'],
        runAt: 'document_idle',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
    log(SCOPE, 'in-page highlighter registered');
  } catch (e) {
    log(SCOPE, 'page-tools registration failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
void syncPageToolsScript();

/**
 * Reach the tabs that were ALREADY open.
 *
 * `registerContentScripts` only applies to future navigations, so an install or
 * an update leaves every open tab with an orphaned script — a localmd sitting
 * there with a dead relay, which is why captures appeared only after the page
 * was reloaded by hand. Both scripts carry a re-entry guard, so injecting into
 * a tab that already has a live one is a no-op.
 */
async function injectIntoOpenTabs(): Promise<void> {
  const jobs: Array<Promise<unknown>> = [];
  try {
    const relayTabs = await chrome.tabs.query({ url: ALLOWED_ORIGINS.map((o) => `${o}/*`) });
    for (const t of relayTabs) {
      if (typeof t.id !== 'number') continue;
      jobs.push(
        chrome.scripting
          .executeScript({ target: { tabId: t.id }, files: ['web-relay.js'] })
          .catch(() => undefined),
      );
    }
    const pageTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const t of pageTabs) {
      if (typeof t.id !== 'number') continue;
      jobs.push(
        chrome.scripting
          .executeScript({ target: { tabId: t.id }, files: ['page-tools.js'] })
          .catch(() => undefined),
      );
    }
    await Promise.all(jobs);
    log(SCOPE, `re-injected into ${jobs.length} open tab(s)`);
  } catch (e) {
    log(SCOPE, 'open-tab injection failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── popup messages: status + site-script management (the user's fallback) ──
// Reuses the message type strings from src/messages.ts (shapes match the
// SidePanel's) WITHOUT importing message-router — this shell routes only these.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'LOCALMD_STATUS') {
    const s = wsBridge?.status();
    const all = openAiToolsFromRegistry();
    sendResponse({
      // From the live registry — moves when adapters load, so the popup number
      // is never a stale constant.
      toolsTotal: all.length,
      // The one thing that can actually be wrong on a shipping install: without
      // the toggle, adapters and site scripts are stored but never run.
      siteScriptsRunnable: siteScriptsRunnable(),
      origins: ALLOWED_ORIGINS,
      // Dev builds only — the shipping popup has no daemon row to fill.
      ...(__LOCALMD_DEV__ && s
        ? { dev: true, connected: s.connected, enabled: s.enabled, port: s.port }
        : {}),
    });
    return true;
  }
  // The in-page highlighter's Clip / Ask buttons. The tab comes from the
  // sender, not from a query: the user pressed it on THAT page, which may not
  // be the active tab by the time this runs.
  if (msg?.type === 'LOCALMD_PAGE_CAPTURE') {
    const tab = sender.tab;
    const action = msg.action === 'ask_selection' ? 'ask_selection' : 'clip_selection';
    if (!tab || typeof tab.id !== 'number') {
      sendResponse({ ok: false, error: 'no tab behind this message' });
      return true;
    }
    void runCapture(action, tab, typeof msg.selection === 'string' ? msg.selection : undefined, {
      ...(typeof msg.prompt === 'string' ? { prompt: msg.prompt } : {}),
      ...(typeof msg.answer === 'string' ? { answer: msg.answer } : {}),
    }).then(sendResponse);
    return true;
  }
  // A quick action from the selection bar (Translate / Explain). This shell has
  // no model and no API key; localmd's model answers, over the direction of the
  // MCP connection that had never been used before this — the extension asking
  // the app (src/localmd-connect/ask-model.ts).
  if (msg?.type === 'LOCALMD_SELECTION_LLM') {
    const ask = {
      prompt: String(msg.prompt ?? '').trim(),
      ...(typeof msg.label === 'string' ? { label: msg.label } : {}),
      ...(typeof msg.url === 'string' ? { url: msg.url } : {}),
    };
    if (!ask.prompt) {
      sendResponse({ ok: false, error: 'nothing to ask about' });
      return true;
    }
    // Pin the worker: opening the app, waiting for its handshake and then
    // waiting on a model is comfortably longer than the idle timeout that
    // recycles an MV3 service worker — and a recycled worker drops the pending
    // sendResponse, which on the page reads as the popover thinking forever.
    onBridgeBusy();
    void answerSelection(ask, msg.fresh === true)
      .then(sendResponse, (e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
      .finally(onBridgeIdle);
    return true;
  }
  if (msg?.type === 'GET_PAGE_TOOLS') {
    void loadPageTools().then((s) => sendResponse({ settings: s }));
    return true;
  }
  if (msg?.type === 'SET_PAGE_TOOLS') {
    void savePageTools(mergePageTools(msg.settings)).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  // Popup capture buttons — same path as the menu, against the user's tab.
  // Which knowledge base a capture would go to — mirrored from localmd, so the
  // popup can name it and offer the others (§14.4n).
  if (msg?.type === 'LOCALMD_KB_STATE') {
    void loadKbFolders().then((kb) => sendResponse(kb));
    return true;
  }
  // The popup asking for another folder. The extension cannot open one — the
  // directory handle belongs to localmd's page — so it asks, and localmd does it
  // in the background. Deliberately WITHOUT bringing that tab forward: the user
  // is switching folders on their way to capturing THIS page, and taking them
  // somewhere else would lose it. The answer arrives as the next
  // `sync_kb_folders`, which the popup is watching for.
  if (msg?.type === 'LOCALMD_OPEN_KB') {
    const name = String(msg.name ?? '').trim();
    if (!name) {
      sendResponse({ ok: false, error: 'no folder named' });
      return true;
    }
    const reached = handleExternalConnect.broadcast(OPEN_KB_NOTIFICATION, { name });
    sendResponse(
      reached > 0
        ? { ok: true, reached }
        : { ok: false, reached, error: 'localmd is not connected — open it to switch folders' },
    );
    return true;
  }
  // "Take me to localmd" — the tab if there is one, a new one if not.
  if (msg?.type === 'LOCALMD_OPEN_APP') {
    void ensureLocalmdTab(LOCALMD_APP_ORIGINS, true)
      .then(({ opened }) => sendResponse({ ok: true, opened }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }
  if (msg?.type === 'LOCALMD_CAPTURE') {
    const action = String(msg.action) as CaptureAction;
    if (
      !(action in COMMAND_IDS) &&
      ![
        'clip_page',
        'clip_selection',
        'ask_page',
        'ask_selection',
        'screenshot_region',
        'screenshot_page',
      ].includes(action)
    ) {
      sendResponse({ ok: false, error: `unknown capture action ${action}` });
      return true;
    }
    void tabFromMessage(msg)
      .then((tab) =>
        tab
          ? runCapture(action, tab)
          : {
              ok: false as const,
              error: 'Could not tell which tab this is about — try again from the page.',
            },
      )
      .then(sendResponse);
    return true;
  }
  // Popup: everything it needs to say about the tab behind it, in one round
  // trip — what the page IS, whether the knowledge base already has it, and
  // what the user has marked on it. One message because the popup asks for all
  // of it at once, every time it opens.
  if (msg?.type === 'LOCALMD_PAGE_STATE') {
    void tabFromMessage(msg).then(async (tab) => {
      const url = tab?.url ?? '';
      const web = /^https?:/.test(url);
      const marks = web ? await loadHighlights(pageKey(url)) : [];
      sendResponse({
        url,
        title: tab?.title ?? '',
        capturable: web,
        entry: web ? await lookupInKb(url) : null,
        highlights: marks.length,
        // The passages themselves, so the popup can offer them rather than
        // only counting them. Storage order, which is the order they were
        // made — people highlight as they read, so it is usually reading
        // order too, and it is at least STABLE, which a re-sort would not be.
        // Capped: a page may hold 200, and the popup shows the rest through
        // the annotations page.
        marks: marks.slice(0, POPUP_MARKS).map((m) => ({
          id: m.id,
          exact: m.exact,
          ...(m.color ? { color: m.color } : {}),
          ...(m.note ? { note: m.note } : {}),
        })),
        pending: await inboxCount(),
      });
    });
    return true;
  }
  if (msg?.type === 'LIST_SITE_SCRIPTS') {
    void listSiteScripts().then(
      (scripts) =>
        sendResponse({
          type: 'LIST_SITE_SCRIPTS_RESP',
          scripts,
          runnable: siteScriptsRunnable(),
        }),
      () => sendResponse({ type: 'LIST_SITE_SCRIPTS_RESP', scripts: [], runnable: false }),
    );
    return true;
  }
  if (msg?.type === 'SET_SITE_SCRIPT_ENABLED') {
    const { id, enabled } = msg as { id: string; enabled: boolean };
    void setSiteScriptEnabled(id, enabled)
      .then(() => refreshSiteScript(id))
      .then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
    return true;
  }
  if (msg?.type === 'DELETE_SITE_SCRIPT') {
    const { id } = msg as { id: string };
    void unregisterSiteScriptById(id)
      .then(() => deleteSiteScript(id))
      .then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
    return true;
  }
  return undefined;
});

chrome.runtime.onStartup.addListener(() => log(SCOPE, 'onStartup'));
