#!/usr/bin/env node
/**
 * WebCLI bridge daemon — routes external HTTP `/command` calls to the **WebCLI**
 * Chrome extension over a WebSocket the extension dials OUT to (an MV3 service
 * worker can't accept inbound sockets, so it connects out and we route to it).
 *
 *   curl ──HTTP /command──▶ daemon ──WS──▶ WebCLI extension ──▶ result back
 *
 * WebCLI exposes GENERIC browser tools only (open_url / get_page_text /
 * get_interactives / click / type_into / scroll_page / screenshot / …) — no site
 * adapters, no in-browser agent. That's the whole surface; `GET /tools` is the
 * source of truth.
 *
 * HTTP (127.0.0.1 only): GET /ping /status /tools, POST /command {tool,args}.
 * Default port 9376 (override with BRIDGE_PORT) — a distinct port from the full
 * Web Agent bridge's 8787, so both can run at once.
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.BRIDGE_PORT || 9376);
const CALL_TIMEOUT_MS = Number(process.env.BRIDGE_CALL_TIMEOUT_MS) || 180_000;

/** The single connected WebCLI extension socket. */
let extWs = null;
/** Latest tool catalog the extension pushed (generic tools, OpenAI-tool shape). */
let catalog = [];
let extInfo = null; // { client, version } from register
/** id → { resolve, timer } for in-flight calls awaiting a `result`. */
const pending = new Map();
let seq = 0;

function callExtension(tool, args) {
  return new Promise((resolve) => {
    if (!extWs || extWs.readyState !== extWs.OPEN) {
      resolve({ ok: false, error: 'WebCLI extension not connected (load it + reload if needed)' });
      return;
    }
    const id = `c${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'timeout waiting for extension' });
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    extWs.send(JSON.stringify({ type: 'call', id, tool, args: args ?? {} }));
  });
}

// ───────── HTTP (health + driving) ─────────
const http = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const connected = !!(extWs && extWs.readyState === extWs.OPEN);
  if (req.method === 'GET' && url === '/ping') return json(200, { ok: true });
  if (req.method === 'GET' && url === '/status')
    return json(200, { ok: true, connected, port: PORT, client: extInfo?.client ?? null, tools: catalog.length });
  if (req.method === 'GET' && url === '/tools') return json(200, { ok: true, tools: catalog });
  if (req.method === 'POST' && url === '/command') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return json(400, { ok: false, error: 'bad json' });
    }
    const result = await callExtension(parsed.tool, parsed.args);
    return json(200, result);
  }
  return json(404, { ok: false, error: 'not found' });
});

// ───────── WebSocket (the extension dials in) ─────────
const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.type === 'register') {
      if (extWs && extWs !== ws) {
        try {
          extWs.close();
        } catch {
          /* ignore */
        }
      }
      extWs = ws;
      extInfo = { client: m.client || 'unknown', version: m.version || null };
      console.error(`[webcli] extension registered: ${m.client} ${m.version || ''}`);
    } else if (m.type === 'catalog') {
      catalog = Array.isArray(m.tools) ? m.tools : [];
      console.error(`[webcli] catalog: ${catalog.length} tools`);
    } else if (m.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    } else if (m.type === 'result') {
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      p.resolve({ ok: m.ok, result: m.result, error: m.error });
    }
  });
  ws.on('close', () => {
    if (extWs === ws) {
      extWs = null;
      extInfo = null;
      catalog = [];
      // Fail in-flight calls fast instead of letting each hit CALL_TIMEOUT_MS.
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'extension disconnected' });
      }
      pending.clear();
    }
  });
});

http.listen(PORT, '127.0.0.1', () => {
  console.error(
    `[webcli] listening on http://127.0.0.1:${PORT}  (ws + GET /ping /status /tools, POST /command)`,
  );
});
