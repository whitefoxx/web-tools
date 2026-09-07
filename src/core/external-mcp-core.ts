/**
 * External MCP tool source — TRANSPORT CORE. The `chrome.runtime.onConnectExternal`
 * JSON-RPC (MCP-shaped) plumbing shared by both bridge shells:
 *   • the FULL extension (src/background/external-mcp.ts) injects a `web_task`
 *     handler backed by the agent engine;
 *   • the LITE bridge injects no web_task — just the generic tool catalog.
 *
 * Everything here is transport-only: origin gating, the initialize / tools/list /
 * tools/call handshake, per-port web_task serialization, direct-tool dispatch to
 * the injected executor, MCP content encoding (incl. screenshot image blocks),
 * and the 1MB message ceiling. It imports NOTHING from the full shell (only the
 * core-safe registry catalog), so the lite shell reuses it verbatim.
 *
 * See docs/external-agent-control.md §11.
 */
import { log, warn } from '../runtime/log';
import { openAiToolsFromRegistry } from '../tools/manifest';

/** JSON-RPC message size ceiling for INBOUND frames (spec for this integration).
 * The outbound ceiling defaults to the same 1MB and is per-shell configurable
 * (`maxOutboundBytes`): localmd Connect raises it so a clip's inlined images
 * and a sized screenshot reach the page instead of being dropped — postMessage
 * itself is indifferent to a 16MB string, the 1MB figure was a sanity bound for
 * TEXT results. */
export const MAX_MSG_BYTES = 1_048_576;

export const MCP_PROTOCOL_VERSION = '2025-03-26';

/** Default ceiling on a server→client request. Sized for the one that exists:
 * an LLM completion on the page's model, which is seconds on a fast provider
 * and can be most of a minute on a slow one thinking about a long passage. */
export const REQUEST_TIMEOUT_MS = 120_000;

/** Why a `request()` failed when nobody was there to hear it. A constant rather
 * than a string a caller matches on: "there is no page yet" is recoverable (open
 * one and ask again) where every other failure is not, and telling them apart by
 * prose is how that distinction rots. */
export const NO_CLIENT_MESSAGE = 'no client page has completed the handshake';

type JsonRpcId = string | number;

interface JsonRpcIn {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface PortState {
  closed: boolean;
  /** Serialization chain for tools/call — one web_task at a time per port. */
  tail: Promise<void>;
  /** Session driven by the in-flight web_task (aborted on disconnect). */
  runningSessionId: string | null;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Minimal result shape the transport reads from the injected executor. */
export type ToolResult = { ok: boolean; result?: unknown; error?: string };

/** Context handed to a web_task handler so it can drive progress + the final
 * reply without owning the wire framing. */
export interface WebTaskContext {
  port: chrome.runtime.Port;
  state: PortState;
  id: JsonRpcId;
  args: Record<string, unknown>;
  /** The final tool result (one text block). */
  sendText(text: string, isError: boolean): void;
  /** A one-line `notifications/progress` (no id — the peer must not reply). */
  sendProgress(message: string): void;
  /** A JSON-RPC protocol error (e.g. -32602 for invalid web_task params). */
  sendError(code: number, message: string): void;
}

export interface ExternalMcpConfig {
  /** The shared external-tool executor (bridge-core's runExternalTool). */
  runExternalTool(
    tool: string,
    args: Record<string, unknown>,
    origin?: string,
  ): Promise<ToolResult>;
  /** Whether a name is servable (control tool or registry adapter). */
  isExternalTool(tool: string): boolean;
  /** Audit-log sink (shared external-access log in the full shell; no-op in lite). */
  recordCall(tool: string, ok: boolean, error: string | undefined, t0: number): void;
  /** Per-direct-call safety timeout. */
  callTimeoutMs: number;
  /** serverInfo.name / version for the initialize response. */
  serverName: string;
  serverVersion(): string;
  /** Optional server `instructions` returned by `initialize` — a short skill-level
   * guide for the connecting MCP client (localmd.app), since it does NOT get the
   * standalone SKILL.md (only the per-tool descriptions in tools/list). */
  instructions?: string;
  /** Optional whole-task delegate. When absent, `web_task` is neither listed nor
   * callable (→ -32602 unknown tool) — the lite bridge has no agent engine. */
  webTask?: { tool: McpTool; run(ctx: WebTaskContext): Promise<void> };
  /** Abort a running web_task session on port disconnect (full shell only). */
  abortSession?(sessionId: string): void;
  /** Optional catalog filter (core/tool-profile). Narrows what `tools/list`
   * ADVERTISES; it never gates `tools/call`, so a peer holding a cached catalog
   * keeps working. Absent → list everything. */
  toolFilter?(toolId: string): boolean;
  /** Optional origin-allowlist override (core/web-origins: the user-configured
   * list, WebCLI's relay path). Absent → the manifest-derived
   * `allowedExternalOrigins()` set, checked synchronously (full shell,
   * unchanged). May return a Promise: the relay wakes a cold SW, so the list
   * often lives behind a storage read — early frames are buffered until the
   * verdict, not raced against it. */
  allowedOrigins?(): Set<string> | Promise<Set<string>>;
  /** Outbound frame ceiling (bytes). Default MAX_MSG_BYTES (1MB). A shell whose
   * consumer expects binary-ish payloads (localmd Connect: clips, screenshots)
   * raises it; the inbound ceiling never moves. */
  maxOutboundBytes?: number;
  /** Called once a client has completed the handshake (`notifications/
   * initialized`), with a sender for server→client notifications on THAT port.
   * localmd Connect uses it to announce a non-empty inbox to a page that just
   * connected (the poke that a page which was open at capture time received
   * live via `broadcast`). */
  onClientReady?(notify: (method: string, params?: unknown) => void): void;
  /** Log scope label. */
  scope?: string;
}

/** The handler `createExternalMcpHandler` returns: the port entry point, plus a
 * broadcaster for server→client notifications to every live, handshaken port
 * (returns how many received it). Notifications carry no id, so the peer must
 * not reply; a peer that does not know the method drops it (MCP semantics). */
export type ExternalMcpHandler = ((port: chrome.runtime.Port) => void) & {
  broadcast(method: string, params?: unknown): number;
  /** One server→client REQUEST, answered by the page (MCP allows both
   * directions; `sampling/createMessage` is the one this exists for — the
   * extension has no model of its own, localmd does). Rejects when no page has
   * finished the handshake, when the port dies, and on the timeout.
   *
   * `origins` narrows WHO may answer. A shell whose allowlist admits more than
   * one app (localmd Connect's dev build serves the dev app AND, for testing,
   * the published one) must pass it: "the most recent page" would otherwise
   * hand a dev build's question to production. */
  request(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number; origins?: readonly string[] },
  ): Promise<unknown>;
};

/* ───────── origin allowlist ───────── */

/** Origins allowed to connect, derived from the manifest's
 * `externally_connectable.matches` so the two can't drift apart. Patterns with a
 * wildcard scheme/host are REFUSED (policy: exact origins only) — if the manifest
 * is ever broadened to a wildcard, the handler still won't serve it. */
export function allowedExternalOrigins(): Set<string> {
  const out = new Set<string>();
  const matches =
    (chrome.runtime.getManifest() as { externally_connectable?: { matches?: string[] } })
      .externally_connectable?.matches ?? [];
  for (const pattern of matches) {
    const m = /^(https?):\/\/([^/*]+)\//.exec(pattern);
    if (m) out.add(`${m[1]}://${m[2]}`);
  }
  return out;
}

/* ───────── wire helpers ───────── */

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

function post(port: chrome.runtime.Port, msg: unknown): void {
  try {
    port.postMessage(msg);
  } catch {
    /* port already gone — the disconnect listener handles cleanup */
  }
}

function sendError(port: chrome.runtime.Port, id: JsonRpcId, code: number, message: string): void {
  post(port, { jsonrpc: '2.0', id, error: { code, message } });
}

function sendResult(port: chrome.runtime.Port, id: JsonRpcId, result: unknown): void {
  post(port, { jsonrpc: '2.0', id, result });
}

/** MCP-shaped tools/call result. When the serialized message exceeds
 * MAX_MSG_BYTES: image blocks are DROPPED with a note (a truncated base64 is
 * garbage, unlike truncated text), remaining text is merged and shrunk until the
 * WHOLE envelope fits (byte-accurate). */
function sendToolContent(
  port: chrome.runtime.Port,
  id: JsonRpcId,
  blocks: McpContent[],
  isError: boolean,
  maxBytes: number = MAX_MSG_BYTES,
): void {
  const envelope = (content: McpContent[]) => ({
    jsonrpc: '2.0',
    id,
    result: { content, isError },
  });
  const fits = (m: unknown) => utf8Len(JSON.stringify(m)) <= maxBytes;
  if (fits(envelope(blocks))) {
    post(port, envelope(blocks));
    return;
  }
  const limitLabel = `${Math.round(maxBytes / 1_048_576)}MB`;
  const truncNote = `\n\n……[result too long, truncated to the ${limitLabel} message limit]`;
  let body = blocks
    .map((b) =>
      b.type === 'image'
        ? `[image (${b.mimeType}) too large, exceeds the ${limitLabel} message limit, omitted]`
        : b.text,
    )
    .join('\n');
  let msg = envelope([{ type: 'text', text: body }]);
  while (!fits(msg) && body.length > 0) {
    body = body.slice(0, Math.floor(body.length * 0.8));
    msg = envelope([{ type: 'text', text: body + truncNote }]);
  }
  post(port, msg);
}

function sendToolResult(
  port: chrome.runtime.Port,
  id: JsonRpcId,
  text: string,
  isError: boolean,
  maxBytes?: number,
) {
  sendToolContent(port, id, [{ type: 'text', text }], isError, maxBytes);
}

function sendNotification(port: chrome.runtime.Port, method: string, params?: unknown): void {
  post(port, { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
}

function sendRequest(
  port: chrome.runtime.Port,
  id: JsonRpcId,
  method: string,
  params?: unknown,
): void {
  post(port, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
}

function sendProgress(port: chrome.runtime.Port, state: PortState, message: string): void {
  if (state.closed || !message) return;
  post(port, {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { message: message.replace(/\s+/g, ' ').trim().slice(0, 300) },
  });
}

const DATA_URL_RE = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/** Tool result → MCP content blocks. Top-level string fields holding an image
 * data URL (screenshot's `dataUrl`) become `{type:'image'}` blocks; the rest of
 * the object stays one JSON text block. Non-image results are one text block. */
function mcpContentFromResult(result: unknown): McpContent[] {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const images: McpContent[] = [];
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      const m = typeof v === 'string' ? DATA_URL_RE.exec(v) : null;
      if (m) images.push({ type: 'image', data: m[2], mimeType: m[1] });
      else rest[k] = v;
    }
    if (images.length) {
      const blocks: McpContent[] = [...images];
      if (Object.keys(rest).length) blocks.push({ type: 'text', text: JSON.stringify(rest) });
      return blocks;
    }
  }
  return [
    { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) },
  ];
}

/* ───────── the handler factory ───────── */

/** Build a `chrome.runtime.onConnectExternal` handler bound to `cfg`. Both bridge
 * shells register the returned function; behavior differs only by the injected
 * executor + the optional web_task delegate. */
export function createExternalMcpHandler(cfg: ExternalMcpConfig): ExternalMcpHandler {
  const SCOPE = cfg.scope ?? 'ext-mcp';
  const maxOut = cfg.maxOutboundBytes ?? MAX_MSG_BYTES;
  /** Ports that completed the handshake — the broadcast audience. A port leaves
   * on disconnect; one that never sent `notifications/initialized` never joins
   * (a peer mid-handshake cannot yet make sense of a server notification). */
  const ready = new Set<chrome.runtime.Port>();

  /** Server→client requests we are waiting on, keyed by the id we minted.
   *
   * The ids are STRINGS ('srv-1', …) while every client id seen here is a
   * number, which is not cosmetic: both directions number their requests from
   * 1, so an overlapping id space would have this map and the page's own
   * pending map competing for the same key the moment a reply crossed a request
   * in flight. Different types make that collision unrepresentable. */
  const outbound = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; port: chrome.runtime.Port }
  >();
  let nextRequestId = 1;

  /** Fail every request riding a port that just died. */
  function dropOutbound(port: chrome.runtime.Port, why: string): void {
    for (const [id, p] of [...outbound]) {
      if (p.port !== port) continue;
      outbound.delete(id);
      p.reject(new Error(why));
    }
  }

  /** tools/list payload: [web_task?] + every registered adapter, OpenAI → MCP.
   * (synthetic CONTROL_TOOLS stay unlisted but remain callable by name.) */
  function mcpToolCatalog(): McpTool[] {
    const registry = openAiToolsFromRegistry()
      .filter((t) => (cfg.toolFilter ? cfg.toolFilter(t.function.name) : true))
      .map((t) => ({
        name: t.function.name,
        description: t.function.description,
        inputSchema: t.function.parameters as unknown,
      }));
    return cfg.webTask ? [cfg.webTask.tool, ...registry] : registry;
  }

  /** A non-web_task tools/call: dispatch to the injected executor (one copy of
   * the write gates), record into the audit log, convert the result to MCP
   * content. Runs as it arrives (not behind the web_task queue). origin 'webmcp'
   * (F-30): these calls never record into any explore trace. */
  async function runDirectTool(
    port: chrome.runtime.Port,
    state: PortState,
    id: JsonRpcId,
    name: unknown,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (state.closed) return;
    const tool = typeof name === 'string' ? name : '';
    if (!tool || !cfg.isExternalTool(tool)) {
      sendError(port, id, -32602, `unknown tool: ${String(name)}`);
      return;
    }
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: `call timed out (${cfg.callTimeoutMs / 1000}s)` }),
        cfg.callTimeoutMs,
      );
    });
    try {
      const r = await Promise.race([cfg.runExternalTool(tool, args, 'webmcp'), timeout]);
      cfg.recordCall(tool, r.ok, r.ok ? undefined : r.error, t0);
      if (state.closed) return;
      if (r.ok) sendToolContent(port, id, mcpContentFromResult(r.result), false, maxOut);
      else sendToolResult(port, id, r.error ?? 'execution failed', true, maxOut);
    } finally {
      clearTimeout(timer);
    }
  }

  function handleRpcMessage(port: chrome.runtime.Port, state: PortState, raw: unknown): void {
    const m = (raw ?? {}) as JsonRpcIn;
    const id: JsonRpcId | undefined =
      typeof m.id === 'string' || typeof m.id === 'number' ? m.id : undefined;

    /**
     * Is this the page ANSWERING rather than asking? A response carries an id
     * and a result-or-error, and no method.
     *
     * Decided here, before any guard below can run, because every one of them
     * answers a frame it dislikes with an error carrying that frame's id — and
     * an id from OUR id space posted back to the page is a frame the page then
     * matches against its OWN pending requests. That is a reply delivered to
     * the wrong caller, which is worse than the malformed frame it complained
     * about. JSON-RPC says the same thing more briefly: a response is never
     * responded to. So an answer nobody is waiting on (one that arrived after
     * its request timed out, say) is DROPPED, not corrected.
     */
    const isAnswer =
      typeof m.method !== 'string' &&
      id !== undefined &&
      (Object.prototype.hasOwnProperty.call(m, 'result') ||
        Object.prototype.hasOwnProperty.call(m, 'error'));
    const answering = isAnswer && typeof m.id === 'string' ? outbound.get(m.id) : undefined;
    const failAnswer = (why: string): void => {
      outbound.delete(m.id as string);
      answering?.reject(new Error(why));
    };
    if (isAnswer && !answering) return;

    let size: number;
    try {
      size = utf8Len(JSON.stringify(raw) ?? '');
    } catch {
      if (isAnswer) failAnswer('the answer could not be read');
      else if (id !== undefined) sendError(port, id, -32600, 'request could not be serialized');
      return;
    }
    if (size > MAX_MSG_BYTES) {
      // The inbound ceiling covers answers too — it is the size of a frame this
      // side is willing to take, whichever direction started the exchange.
      if (isAnswer) failAnswer(`the answer exceeds the ${MAX_MSG_BYTES}-byte limit`);
      else if (id !== undefined)
        sendError(port, id, -32600, `single message exceeds the ${MAX_MSG_BYTES}-byte limit`);
      return;
    }
    if (answering) {
      outbound.delete(m.id as string);
      const err = (m as { error?: { code?: number; message?: string } }).error;
      if (err) answering.reject(new Error(`${err.message ?? 'request failed'} (${err.code ?? 0})`));
      else answering.resolve((m as { result?: unknown }).result);
      return;
    }
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      if (id !== undefined) sendError(port, id, -32600, 'not a valid JSON-RPC 2.0 request');
      return;
    }

    switch (m.method) {
      case 'initialize':
        if (id !== undefined) {
          sendResult(port, id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: cfg.serverName, version: cfg.serverVersion() },
            ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
          });
        }
        return;
      case 'notifications/initialized': // client ack — a notification, no reply
        if (!state.closed) {
          ready.add(port);
          cfg.onClientReady?.((method, params) => {
            if (!state.closed) sendNotification(port, method, params);
          });
        }
        return;
      case 'ping': // MCP keepalive
        if (id !== undefined) sendResult(port, id, {});
        return;
      case 'tools/list':
        if (id !== undefined) sendResult(port, id, { tools: mcpToolCatalog() });
        return;
      case 'tools/call': {
        if (id === undefined) return; // a call needs an id to answer to
        const p = (m.params ?? {}) as { name?: unknown; arguments?: unknown };
        const args =
          p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments)
            ? (p.arguments as Record<string, unknown>)
            : {};
        if (cfg.webTask && p.name === cfg.webTask.tool.name) {
          // Serialize web_task on this port: one agent run at a time, later ones
          // queue behind. Direct tool calls below are NOT held up by this queue.
          const ctx: WebTaskContext = {
            port,
            state,
            id,
            args,
            sendText: (text, isError) => sendToolResult(port, id, text, isError, maxOut),
            sendProgress: (message) => sendProgress(port, state, message),
            sendError: (code, message) => sendError(port, id, code, message),
          };
          state.tail = state.tail
            .then(() => cfg.webTask!.run(ctx))
            .catch((e) => warn(SCOPE, 'tools/call chain error', e));
        } else {
          void runDirectTool(port, state, id, p.name, args);
        }
        return;
      }
      default:
        if (id !== undefined) sendError(port, id, -32601, `method not found: ${m.method}`);
    }
  }

  function refuse(port: chrome.runtime.Port, origin: string | undefined): void {
    warn(SCOPE, `rejected external connection from ${origin ?? '(no origin)'}`);
    try {
      port.disconnect();
    } catch {
      /* ignore */
    }
  }

  function attachDisconnect(port: chrome.runtime.Port, state: PortState): void {
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // consume, if any
      state.closed = true;
      ready.delete(port);
      dropOutbound(port, 'the page disconnected before it answered');
      // Abort the in-flight web_task — nobody is left to receive its result.
      if (state.runningSessionId) {
        log(SCOPE, `port disconnected — aborting session ${state.runningSessionId}`);
        cfg.abortSession?.(state.runningSessionId);
      }
    });
  }

  /** chrome.runtime.onConnectExternal entry (full shell), and the relay-Port
   * entry (WebCLI's `onConnect` route) — the sender origin is the page's origin
   * either way, so one gate serves both. */
  const handleExternalConnect = function handleExternalConnect(port: chrome.runtime.Port): void {
    const origin = port.sender?.origin;

    if (!cfg.allowedOrigins) {
      // Manifest-derived allowlist: synchronous, reject before any listener
      // attaches (pinned by tests/external-mcp.test.ts).
      if (!origin || !allowedExternalOrigins().has(origin)) {
        refuse(port, origin);
        return;
      }
      log(SCOPE, `external page connected from ${origin}`);
      const state: PortState = { closed: false, tail: Promise.resolve(), runningSessionId: null };
      attachDisconnect(port, state);
      port.onMessage.addListener((raw) => handleRpcMessage(port, state, raw));
      return;
    }

    // Injected allowlist, possibly async (a storage read on a cold-started SW).
    // Listeners attach NOW and frames buffer until the verdict — checking first
    // would drop whatever the page sent while the storage read was in flight.
    const state: PortState = { closed: false, tail: Promise.resolve(), runningSessionId: null };
    let verdict: boolean | null = null;
    const pending: unknown[] = [];
    attachDisconnect(port, state);
    port.onMessage.addListener((raw) => {
      if (state.closed || verdict === false) return;
      if (verdict === null) {
        pending.push(raw);
        return;
      }
      handleRpcMessage(port, state, raw);
    });
    Promise.resolve()
      .then(() => cfg.allowedOrigins!())
      .then((set) => {
        if (state.closed) return;
        if (!origin || !set.has(origin)) {
          verdict = false;
          pending.length = 0;
          state.closed = true;
          refuse(port, origin);
          return;
        }
        verdict = true;
        log(SCOPE, `external page connected from ${origin}`);
        for (const raw of pending.splice(0)) handleRpcMessage(port, state, raw);
      })
      .catch((e) => {
        // A failed allowlist read must fail CLOSED.
        verdict = false;
        pending.length = 0;
        state.closed = true;
        warn(SCOPE, 'allowlist read failed — refusing connection', e);
        refuse(port, origin);
      });
  } as ExternalMcpHandler;
  handleExternalConnect.broadcast = (method: string, params?: unknown): number => {
    let n = 0;
    for (const port of ready) {
      sendNotification(port, method, params);
      n++;
    }
    return n;
  };
  handleExternalConnect.request = (
    method: string,
    params: unknown,
    opts: { timeoutMs?: number; origins?: readonly string[] } = {},
  ): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
      // The LAST port to finish its handshake, where broadcast takes them all:
      // a request needs exactly one answer, and among equals the freshest is
      // the one the user most recently had in front of them. `origins` decides
      // who counts as an equal — an allowlist can be wider than "the app this
      // build belongs to", and picking by recency alone is how a dev build asks
      // production (see LOCALMD_APP_ORIGINS' history).
      const eligible = opts.origins
        ? [...ready].filter((p) => {
            const o = p.sender?.origin;
            return !!o && opts.origins!.includes(o);
          })
        : [...ready];
      const port = eligible.pop();
      if (!port) {
        reject(new Error(NO_CLIENT_MESSAGE));
        return;
      }
      const key = `srv-${nextRequestId++}`;
      const timer = setTimeout(() => {
        outbound.delete(key);
        reject(new Error(`${method} got no answer in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      outbound.set(key, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        port,
      });
      sendRequest(port, key, method, params);
    });
  return handleExternalConnect;
}
