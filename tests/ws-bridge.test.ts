/**
 * createWsBridge — the shared WebSocket transport core (src/core/ws-bridge.ts)
 * used by both bridge shells. Drives a fake WebSocket + fetch to pin the socket
 * lifecycle: /ping preflight → dial → register + catalog on open, the
 * call→runCall→reply loop (incl. __echo and the per-call timeout), refreshCatalog,
 * status, and exponential-backoff reconnect after a drop. No real network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWsBridge } from '../src/core/ws-bridge';

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(s: string): void {
    this.sent.push(JSON.parse(s));
  }
  close(): void {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  // test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(o: unknown): void {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

function makeBridge(runCall = vi.fn(async () => ({ ok: true, result: 'R' }))) {
  const recordCall = vi.fn();
  const bridge = createWsBridge({
    defaultPort: 8787,
    clientName: 'web-agent-lite',
    clientVersion: () => '1.0',
    buildCatalog: () => [{ name: 'generic__ping' }],
    runCall,
    recordCall,
    callTimeoutMs: 5000,
  });
  return { bridge, runCall, recordCall };
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true })),
  );
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createWsBridge', () => {
  it('connects, registers + pushes catalog on open, reports connected', async () => {
    const { bridge } = makeBridge();
    bridge.start(true, 8787);
    await vi.advanceTimersByTimeAsync(0); // flush /ping fetch → dial
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8787/ping', expect.any(Object));
    expect(FakeWS.instances).toHaveLength(1);
    const ws = FakeWS.instances[0];
    expect(ws.url).toBe('ws://127.0.0.1:8787');
    ws.open();
    expect(ws.sent[0]).toMatchObject({
      type: 'register',
      client: 'web-agent-lite',
      version: '1.0',
    });
    expect(ws.sent[1]).toMatchObject({ type: 'catalog', tools: [{ name: 'generic__ping' }] });
    expect(bridge.status()).toMatchObject({ enabled: true, connected: true, port: 8787 });
  });

  it('does not connect when disabled', async () => {
    const { bridge } = makeBridge();
    bridge.start(false, 8787);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeWS.instances).toHaveLength(0);
    expect(bridge.status().connected).toBe(false);
  });

  it('answers __echo synchronously and audits it', async () => {
    const { bridge, recordCall } = makeBridge();
    bridge.start(true, 8787);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.instances[0];
    ws.open();
    ws.recv({ type: 'call', id: 'c1', tool: '__echo', args: { x: 1 } });
    const reply = ws.sent.find((m) => m.id === 'c1');
    expect(reply).toMatchObject({ type: 'result', id: 'c1', ok: true, result: { x: 1 } });
    expect(recordCall).toHaveBeenCalledWith('__echo', true, undefined, expect.any(Number));
  });

  it('routes a call through runCall and replies with the result', async () => {
    const { bridge, runCall, recordCall } = makeBridge();
    bridge.start(true, 8787);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.instances[0];
    ws.open();
    ws.recv({ type: 'call', id: 'c2', tool: 'generic__open_url', args: { url: 'x' } });
    await vi.advanceTimersByTimeAsync(0); // runCall is async
    expect(runCall).toHaveBeenCalledWith('generic__open_url', { url: 'x' });
    const reply = ws.sent.find((m) => m.id === 'c2');
    expect(reply).toMatchObject({ type: 'result', id: 'c2', ok: true, result: 'R' });
    expect(recordCall).toHaveBeenCalledWith(
      'generic__open_url',
      true,
      undefined,
      expect.any(Number),
    );
  });

  it('replies a timeout error when a call exceeds callTimeoutMs', async () => {
    const { bridge } = makeBridge(vi.fn(() => new Promise(() => {}))); // never resolves
    bridge.start(true, 8787);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.instances[0];
    ws.open();
    ws.recv({ type: 'call', id: 'c3', tool: 'generic__slow', args: {} });
    await vi.advanceTimersByTimeAsync(5000);
    const reply = ws.sent.find((m) => m.id === 'c3');
    expect(reply).toMatchObject({ ok: false });
    expect(String(reply?.error)).toContain('timed out');
  });

  it('refreshCatalog re-pushes only while the socket is open', async () => {
    const { bridge } = makeBridge();
    bridge.start(true, 8787);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.instances[0];
    // Before open: readyState !== OPEN → no send.
    bridge.refreshCatalog();
    expect(ws.sent.filter((m) => m.type === 'catalog')).toHaveLength(0);
    ws.open();
    bridge.refreshCatalog();
    expect(ws.sent.filter((m) => m.type === 'catalog')).toHaveLength(2); // open + refresh
  });

  it('reconnects after the socket drops (still enabled)', async () => {
    const { bridge } = makeBridge();
    bridge.start(true, 8787);
    await vi.advanceTimersByTimeAsync(0);
    const ws1 = FakeWS.instances[0];
    ws1.open();
    ws1.close(); // onclose → schedule reconnect (want still true)
    await vi.advanceTimersByTimeAsync(3000); // RECONNECT_MS backoff → connect again
    await vi.advanceTimersByTimeAsync(0); // flush the new /ping fetch → dial
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('setEnabled(false) closes the socket and stops reconnecting', async () => {
    const { bridge } = makeBridge();
    bridge.start(true, 8787);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWS.instances[0];
    ws.open();
    bridge.setEnabled(false);
    expect(ws.readyState).toBe(3); // closed
    expect(bridge.status().enabled).toBe(false);
    const count = FakeWS.instances.length;
    await vi.advanceTimersByTimeAsync(10_000); // no reconnect should fire
    expect(FakeWS.instances).toHaveLength(count);
  });
});
