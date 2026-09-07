/**
 * Server→client notifications on the MCP transport core (the capture inbox's
 * push half, docs/localmd-connect.md §14), and the per-shell outbound frame
 * ceiling. Drives createExternalMcpHandler directly with a fake port.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/tools/manifest', () => ({ openAiToolsFromRegistry: () => [] }));

import {
  createExternalMcpHandler,
  MAX_MSG_BYTES,
  NO_CLIENT_MESSAGE,
} from '../src/core/external-mcp-core';

function fakePort(origin = 'https://localmd.app') {
  const posted: Array<Record<string, unknown>> = [];
  const msgHandlers: Array<(m: unknown) => void> = [];
  const discHandlers: Array<() => void> = [];
  return {
    posted,
    send: (m: unknown) => msgHandlers.forEach((f) => f(m)),
    disconnect: () => discHandlers.forEach((f) => f()),
    port: {
      name: 'webcli-web-mcp',
      sender: { origin },
      postMessage: (m: Record<string, unknown>) => posted.push(m),
      disconnect: () => {},
      onMessage: { addListener: (f: (m: unknown) => void) => msgHandlers.push(f) },
      onDisconnect: { addListener: (f: () => void) => discHandlers.push(f) },
    } as unknown as chrome.runtime.Port,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function handler(extra: Partial<Parameters<typeof createExternalMcpHandler>[0]> = {}) {
  return createExternalMcpHandler({
    runExternalTool: async () => ({ ok: true, result: { hello: 'x'.repeat(2_000_000) } }),
    isExternalTool: () => true,
    recordCall: () => {},
    callTimeoutMs: 1000,
    serverName: 't',
    serverVersion: () => '0',
    allowedOrigins: async () => new Set(['https://localmd.app']),
    ...extra,
  });
}

async function handshake(h: ReturnType<typeof handler>, p = fakePort()) {
  vi.stubGlobal('chrome', { runtime: { lastError: undefined } });
  h(p.port);
  await settle();
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  p.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await settle();
  return p;
}

describe('broadcast', () => {
  it('reaches only handshaken ports, as id-less notifications', async () => {
    const h = handler();
    const ready = await handshake(h);
    const notReady = fakePort();
    h(notReady.port);
    await settle();
    expect(h.broadcast('notifications/localmd/inbox', { count: 2 })).toBe(1);
    const n = ready.posted.find((m) => m.method === 'notifications/localmd/inbox');
    expect(n).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/localmd/inbox',
      params: { count: 2 },
    });
    expect(notReady.posted.some((m) => m.method === 'notifications/localmd/inbox')).toBe(false);
  });

  it('forgets a port on disconnect', async () => {
    const h = handler();
    const p = await handshake(h);
    p.disconnect();
    expect(h.broadcast('notifications/localmd/inbox', { count: 1 })).toBe(0);
  });

  it('onClientReady fires once per handshake with a port-scoped sender', async () => {
    const onClientReady = vi.fn((notify: (m: string, p?: unknown) => void) =>
      notify('x/y', { a: 1 }),
    );
    const h = handler({ onClientReady });
    const p = await handshake(h);
    expect(onClientReady).toHaveBeenCalledTimes(1);
    expect(p.posted.find((m) => m.method === 'x/y')).toEqual({
      jsonrpc: '2.0',
      method: 'x/y',
      params: { a: 1 },
    });
  });
});

describe('outbound ceiling', () => {
  it('defaults to MAX_MSG_BYTES (a 2MB result is truncated)', async () => {
    const p = await handshake(handler());
    p.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'generic__x', arguments: {} },
    });
    await settle();
    const reply = p.posted.find((m) => m.id === 2)!;
    expect(new TextEncoder().encode(JSON.stringify(reply)).length).toBeLessThanOrEqual(
      MAX_MSG_BYTES,
    );
    expect(JSON.stringify(reply)).toContain('truncated');
  });

  it('a shell may raise it (the same result then passes intact)', async () => {
    const p = await handshake(handler({ maxOutboundBytes: 16 * MAX_MSG_BYTES }));
    p.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'generic__x', arguments: {} },
    });
    await settle();
    const reply = p.posted.find((m) => m.id === 3)!;
    expect(JSON.stringify(reply)).not.toContain('truncated');
    expect(new TextEncoder().encode(JSON.stringify(reply)).length).toBeGreaterThan(MAX_MSG_BYTES);
  });

  it('the inbound ceiling does not move with the outbound one', async () => {
    const p = await handshake(handler({ maxOutboundBytes: 16 * MAX_MSG_BYTES }));
    p.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'ping',
      params: { pad: 'y'.repeat(MAX_MSG_BYTES + 10) },
    });
    await settle();
    const reply = p.posted.find((m) => m.id === 4)!;
    expect((reply.error as { message: string }).message).toMatch(/exceeds/);
  });
});

/**
 * Server→client REQUESTS — the extension asking the page something and waiting
 * for the answer. `sampling/createMessage` is what this exists for: localmd
 * Connect has no model, and its in-page quick actions borrow the app's
 * (docs/localmd-connect.md §14.4o).
 */
describe('request', () => {
  /** The frame the page is expected to answer. */
  const asked = (p: ReturnType<typeof fakePort>) =>
    p.posted.find((m) => m.method === 'sampling/createMessage')!;

  it('carries the params and settles on the page reply', async () => {
    const h = handler();
    const p = await handshake(h);
    const answer = h.request('sampling/createMessage', { maxTokens: 10 });
    await settle();
    const req = asked(p);
    expect(req.params).toEqual({ maxTokens: 10 });
    p.send({ jsonrpc: '2.0', id: req.id, result: { content: { type: 'text', text: 'hi' } } });
    await expect(answer).resolves.toEqual({ content: { type: 'text', text: 'hi' } });
  });

  it('rejects with what the page said went wrong', async () => {
    const h = handler();
    const p = await handshake(h);
    const answer = h.request('sampling/createMessage', {});
    await settle();
    p.send({
      jsonrpc: '2.0',
      id: asked(p).id,
      error: { code: -32603, message: 'No model is configured' },
    });
    await expect(answer).rejects.toThrow(/No model is configured/);
  });

  it('rejects when nobody has finished the handshake — the recoverable case', async () => {
    const h = handler();
    const half = fakePort();
    h(half.port); // connected, never said notifications/initialized
    await settle();
    await expect(h.request('sampling/createMessage', {})).rejects.toThrow(NO_CLIENT_MESSAGE);
    expect(half.posted.some((m) => m.method === 'sampling/createMessage')).toBe(false);
  });

  it('rejects when the page goes away mid-question rather than waiting out the timeout', async () => {
    const h = handler();
    const p = await handshake(h);
    const answer = h.request('sampling/createMessage', {});
    await settle();
    p.disconnect();
    await expect(answer).rejects.toThrow(/disconnected/);
  });

  /**
   * The reason our ids are strings. Every guard in the inbound path answers a
   * frame it dislikes with an error carrying that frame's id — so an answer
   * that tripped one would post an id from OUR space back to the page, which
   * matches it against its OWN pending calls and resolves the wrong one.
   */
  it('never answers an answer', async () => {
    const h = handler();
    const p = await handshake(h);
    const answer = h.request('sampling/createMessage', {});
    await settle();
    const id = asked(p).id;
    expect(typeof id).toBe('string');
    const before = p.posted.length;
    p.send({ jsonrpc: '2.0', id, result: { content: { type: 'text', text: 'ok' } } });
    await answer;
    expect(p.posted.length).toBe(before); // not one frame back
  });

  it('does not answer an oversized answer either — it fails the caller', async () => {
    const h = handler();
    const p = await handshake(h);
    const answer = h.request('sampling/createMessage', {});
    await settle();
    const before = p.posted.length;
    p.send({
      jsonrpc: '2.0',
      id: asked(p).id,
      result: { content: { type: 'text', text: 'z'.repeat(MAX_MSG_BYTES + 10) } },
    });
    await expect(answer).rejects.toThrow(/exceeds/);
    expect(p.posted.length).toBe(before);
  });

  it('ignores a reply to an id it is not waiting on', async () => {
    const h = handler();
    const p = await handshake(h);
    const before = p.posted.length;
    p.send({ jsonrpc: '2.0', id: 'srv-999', result: {} });
    await settle();
    expect(p.posted.length).toBe(before);
  });

  it('asks the most recently connected page, where broadcast asks them all', async () => {
    const h = handler();
    const first = await handshake(h);
    const second = await handshake(h, fakePort());
    void h.request('sampling/createMessage', {});
    await settle();
    expect(second.posted.some((m) => m.method === 'sampling/createMessage')).toBe(true);
    expect(first.posted.some((m) => m.method === 'sampling/createMessage')).toBe(false);
  });

  /**
   * An allowlist can be wider than "the app this build belongs to": localmd
   * Connect's DEV build admits the published localmd.app as well, so the
   * published app can be driven while testing. Picking the most recent page
   * would then send a dev build's question to production — the same mistake
   * `LOCALMD_APP_ORIGINS` was written twice to stop.
   */
  it('asks the build\'s OWN app, not whoever connected last', async () => {
    const h = handler({
      allowedOrigins: async () =>
        new Set(['https://localmd.app', 'http://localhost:5173']),
    });
    const dev = await handshake(h, fakePort('http://localhost:5173'));
    const prod = await handshake(h, fakePort('https://localmd.app')); // more recent
    void h.request('sampling/createMessage', {}, { origins: ['http://localhost:5173'] });
    await settle();
    expect(dev.posted.some((m) => m.method === 'sampling/createMessage')).toBe(true);
    expect(prod.posted.some((m) => m.method === 'sampling/createMessage')).toBe(false);
  });

  it('treats "my app is not open" as the recoverable case, not as silence', async () => {
    const h = handler({
      allowedOrigins: async () =>
        new Set(['https://localmd.app', 'http://localhost:5173']),
    });
    const prod = await handshake(h, fakePort('https://localmd.app'));
    await expect(
      h.request('sampling/createMessage', {}, { origins: ['http://localhost:5173'] }),
    ).rejects.toThrow(NO_CLIENT_MESSAGE);
    expect(prod.posted.some((m) => m.method === 'sampling/createMessage')).toBe(false);
  });
});
