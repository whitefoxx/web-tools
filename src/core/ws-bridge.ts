/**
 * WebSocket bridge client — TRANSPORT CORE. The MV3 service worker can't accept
 * inbound connections, so it dials OUT to a local bridge daemon (the `bridge/`
 * Node process) over WebSocket, registers, pushes its tool catalog, and answers
 * `call` commands. Shared by both bridge shells:
 *   • the FULL extension (src/background/bridge-client.ts) wires it with the rich
 *     executor + audit log + the external-control write policy;
 *   • the LITE bridge wires it with the generic-only executor.
 *
 * This module owns ONLY the socket lifecycle — /ping preflight, dial, register +
 * catalog, heartbeat, exponential-backoff reconnect, the `call → run → reply`
 * loop (with a per-call timeout and reply-on-the-live-socket, §10.34). The write
 * policy, CONTROL_TOOLS, and audit persistence stay in the wrapping shell and
 * reach this module through injected callbacks — so it imports nothing from the
 * full shell. See docs/external-agent-control.md.
 */
import { log } from '../runtime/log';

export type ToolResult = { ok: boolean; result?: unknown; error?: string };

export interface WsBridgeConfig {
  defaultPort: number;
  clientName: string;
  clientVersion(): string;
  /** The tool catalog to push (openAiToolsFromRegistry output). */
  buildCatalog(): unknown[];
  /** Run one `call` — the shell's runExternalTool. */
  runCall(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Audit sink for each answered call (no-op in the lite shell). */
  recordCall(tool: string, ok: boolean, error: string | undefined, t0: number): void;
  /** Per-call safety timeout (defense-in-depth; upstream calls are bounded too). */
  callTimeoutMs: number;
  heartbeatMs?: number;
  reconnectMs?: number;
  reconnectMaxMs?: number;
  scope?: string;
}

export interface WsBridge {
  /** Enable/disable + (re)connect or disconnect. */
  setEnabled(enabled: boolean, port?: number): void;
  /** Connect if enabled — call at SW boot with the persisted state. */
  start(enabled: boolean, port: number): void;
  status(): { enabled: boolean; connected: boolean; port: number };
  /** Re-push the tool catalog (call after the installed adapter set changes). */
  refreshCatalog(): void;
  /** Retry the connection NOW if enabled but not connected (idempotent — a no-op
   * when already connected or disabled). Used by a periodic alarm to redial after
   * an MV3 recycle drops the socket and no heartbeat is left to keep the SW warm. */
  poke(): void;
}

export function createWsBridge(cfg: WsBridgeConfig): WsBridge {
  const SCOPE = cfg.scope ?? 'ws-bridge';
  const HEARTBEAT_MS = cfg.heartbeatMs ?? 20_000;
  const RECONNECT_MS = cfg.reconnectMs ?? 3_000;
  const RECONNECT_MAX_MS = cfg.reconnectMaxMs ?? 30_000;

  let ws: WebSocket | null = null;
  let want = false; // desired connected state
  let port = cfg.defaultPort;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Consecutive failed connects → exponential backoff. A refused WS handshake
  // logs a browser console error we can't catch; backing off cuts the spam.
  let reconnectAttempts = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function stopHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function scheduleReconnect(): void {
    if (!want || reconnectTimer) return;
    const delay = Math.min(RECONNECT_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (!want || ws) return;
    // Preflight with a catchable fetch before opening the WebSocket: a refused
    // `new WebSocket()` logs an uncatchable browser error and piles a red row
    // onto chrome://extensions' Errors page on every retry. A failed fetch is
    // just a rejected promise — swallow + retry; only dial once /ping answers.
    void fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1_500) }).then(
      () => {
        if (!want || ws) return;
        dial();
      },
      () => scheduleReconnect(),
    );
  }

  function dial(): void {
    let sock: WebSocket;
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      reconnectAttempts = 0; // connected → next reconnect (if it drops) is fast
      try {
        sock.send(
          JSON.stringify({
            type: 'register',
            client: cfg.clientName,
            version: cfg.clientVersion(),
          }),
        );
        sendCatalog(sock);
      } catch {
        /* ignore */
      }
      heartbeat = setInterval(() => {
        try {
          sock.send(JSON.stringify({ type: 'ping' }));
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);
    };
    sock.onmessage = (ev) => void onMessage(String(ev.data), sock);
    sock.onclose = () => {
      stopHeartbeat();
      // Only the LIVE socket drives reconnects. A socket we already replaced
      // (setEnabled closed it and connected a new one) must not arm a spurious
      // reconnect against the healthy connection.
      if (ws === sock) {
        ws = null;
        scheduleReconnect();
      }
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    };
  }

  async function onMessage(data: string, sock: WebSocket): Promise<void> {
    let m: { type?: string; id?: string; tool?: string; args?: Record<string, unknown> };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.type === 'pong') return;
    if (m.type !== 'call') return;

    const t0 = Date.now();
    let replied = false;
    const reply = (r: ToolResult): void => {
      if (replied) return; // idempotent — first reply wins (timeout vs real result)
      replied = true;
      cfg.recordCall(m.tool ?? '?', r.ok, r.ok ? undefined : r.error, t0);
      try {
        // Reply on the CURRENT live socket, not the one captured when the call
        // arrived: a reconnect between call and reply would otherwise send to a
        // dead socket and drop the result, hanging the external agent. §10.34.
        (ws ?? sock).send(JSON.stringify({ type: 'result', id: m.id, ...r }));
      } catch {
        /* ignore */
      }
    };

    if (m.tool === '__echo') return reply({ ok: true, result: m.args ?? {} });
    if (!m.tool) return reply({ ok: false, error: 'missing tool' });

    // Defense-in-depth per-call timeout: reply an error if the call exceeds every
    // upstream bound, instead of leaving the external agent to hang.
    const callTimer = setTimeout(
      () => reply({ ok: false, error: `bridge call timed out (${cfg.callTimeoutMs / 1000}s)` }),
      cfg.callTimeoutMs,
    );
    try {
      reply(await cfg.runCall(m.tool, m.args ?? {}));
    } finally {
      clearTimeout(callTimer);
    }
  }

  function sendCatalog(sock: WebSocket): void {
    try {
      sock.send(JSON.stringify({ type: 'catalog', tools: cfg.buildCatalog() }));
    } catch {
      /* ignore */
    }
  }

  return {
    setEnabled(enabled: boolean, newPort?: number): void {
      want = enabled;
      if (newPort && Number.isFinite(newPort)) port = newPort;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0; // manual toggle → retry immediately, fresh backoff
      stopHeartbeat();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
      if (enabled) connect();
    },
    start(enabled: boolean, startPort: number): void {
      want = enabled;
      if (Number.isFinite(startPort)) port = startPort;
      log(SCOPE, `start enabled=${enabled} port=${port}`);
      if (enabled) connect();
    },
    status() {
      return { enabled: want, connected: !!ws && ws.readyState === WebSocket.OPEN, port };
    },
    refreshCatalog(): void {
      if (ws && ws.readyState === WebSocket.OPEN) sendCatalog(ws);
    },
    poke(): void {
      // connect() already guards `if (!want || ws) return`, so this redials only
      // when enabled AND currently disconnected.
      connect();
    },
  };
}
