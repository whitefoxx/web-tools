/**
 * localmd Connect web-app relay — the ONLY code this shell ever injects into a
 * page, and it is injected ONLY on allowed origins (https://localmd.app is
 * seeded on install; the user can edit the list in the popup — registered at
 * runtime by the SW, see core/web-origins.ts). It carries JSON-RPC/MCP frames
 * between the page (`window.postMessage`) and the SW.
 *
 * This is the WebCLI relay (src/webcli/web-relay.ts) with ONE deliberate
 * difference: the DOM marker attribute is `data-localmd-connect` instead of
 * `data-webcli-relay`, so a page can detect each extension independently when
 * both are installed. The envelope (`webcli:'mcp'`) and the internal Port name
 * are shared protocol — kept identical on purpose so localmd's relay client is
 * parameterized by marker attribute only.
 *
 * The page-side protocol:
 *   page → ext : postMessage({ webcli:'mcp', dir:'to-ext', ext?, msg:<jsonrpc> })
 *   ext → page : postMessage({ webcli:'mcp', dir:'to-page', ext, msg:<jsonrpc> })
 *   on attach  : postMessage({ webcli:'mcp', dir:'to-page', ext, ready:true })
 *   on drop    : postMessage({ webcli:'mcp', dir:'to-page', ext, closed:true })
 *
 * `ext` is this extension's id. Pages MUST echo the id (read from the DOM
 * marker or the `ready` frame) in their `to-ext` frames: WebCLI and localmd
 * Connect share this envelope, so an untargeted frame on a page carrying both
 * relays would be executed by BOTH — twice, which matters the moment a write
 * tool is involved. A frame naming another extension is dropped here, not
 * forwarded.
 *
 * Runs at document_start in the ISOLATED world: the listener exists before any
 * page script can post, so there is no race for early frames.
 */
export {};

const EXT_ID = chrome.runtime.id;
const PORT_NAME = 'webcli-web-mcp'; // = RELAY_PORT_NAME; inlined, this file is standalone

// Re-entry guard. The service worker re-injects this file into tabs that were
// already open when the extension was installed or updated (a registered
// content script only reaches FUTURE navigations, so without that an open
// localmd sits there with a dead relay until someone reloads it). Injecting
// into a tab that already has a live relay would give the page two listeners
// and every frame twice.
//
// KEEP THIS BLOCK BELOW THE CONSTANTS ABOVE. `runRelay()` reads EXT_ID
// synchronously and function declarations hoist, so calling it from above the
// declarations is a TDZ error under ESM -- and the bundler lowers `const` to
// `var`, which turns that error into SILENCE: the relay attaches, marks the
// document with the string "undefined", and then rejects every frame the page
// sends as addressed to another install. Clip, screenshots and asks all stop at
// once, with nothing in any console (findings F-58).
const w = window as unknown as { __localmdRelay?: boolean };
if (!w.__localmdRelay) {
  w.__localmdRelay = true;
  runRelay();
}

function runRelay(): void {
  let port: chrome.runtime.Port | null = null;

  function getPort(): chrome.runtime.Port {
    if (port) return port;
    const p = chrome.runtime.connect({ name: PORT_NAME });
    p.onMessage.addListener((msg) => {
      window.postMessage(
        { webcli: 'mcp', dir: 'to-page', ext: EXT_ID, msg },
        window.location.origin,
      );
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // consume, if any
      if (port === p) port = null; // next frame redials (SW may have been recycled)
      // TELL THE PAGE. Chrome recycles an idle MV3 service worker after a few
      // minutes and takes every port with it, and an extension reload does the
      // same — after which the page still believes it is connected, its row still
      // says so, and anything the extension tries to PUSH reaches nobody. The
      // page cannot observe this itself: onDisconnect exists only on this side.
      // It was not forwarded before, and the cost was a capture inbox that filled
      // up silently (docs/localmd-connect.md §14.2).
      window.postMessage(
        { webcli: 'mcp', dir: 'to-page', ext: EXT_ID, closed: true },
        window.location.origin,
      );
    });
    port = p;
    return p;
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return; // only the page's own frames, never cross-window
    const d = e.data as { webcli?: unknown; dir?: unknown; ext?: unknown; msg?: unknown } | null;
    if (!d || d.webcli !== 'mcp' || d.dir !== 'to-ext' || d.msg === undefined) return;
    if (typeof d.ext === 'string' && d.ext !== EXT_ID) return; // addressed to another install
    try {
      getPort().postMessage(d.msg);
    } catch {
      // Port died between frames (MV3 recycle) — one redial, then give up quietly;
      // the page's own request timeout is the backstop.
      port = null;
      try {
        getPort().postMessage(d.msg);
      } catch {
        /* SW unreachable */
      }
    }
  });

  // Two presence signals, because `ready` alone races: postMessage dispatches in a
  // later task, and nothing guarantees the page's listener is attached by then.
  // ① a DOM marker — set at document_start, so page scripts (and our own probe
  //    tools) can detect the relay SYNCHRONOUSLY at any time;
  // ② the `ready` frame — for pages that are already listening.
  // A page that missed `ready` can simply send a frame WITHOUT `ext` and learn the
  // id from the reply envelope — but MUST address subsequent frames (see header).
  try {
    document.documentElement.dataset.localmdConnect = EXT_ID;
  } catch {
    /* no documentElement — nothing to mark */
  }
  window.postMessage(
    { webcli: 'mcp', dir: 'to-page', ext: EXT_ID, ready: true },
    window.location.origin,
  );
}
