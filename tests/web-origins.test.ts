/**
 * User-configurable web-app origins (core/web-origins) + the async origin gate
 * in external-mcp-core. The pure half is the popup's input contract; the gate
 * half pins the cold-SW race: frames that arrive while the allowlist is still
 * loading must be buffered, not dropped, and a failed read must fail CLOSED.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  normalizeOriginInput,
  sanitizeStoredOrigins,
  relayScriptIdFor,
  isRelayScriptId,
} from '../src/core/web-origins';
import { createExternalMcpHandler } from '../src/core/external-mcp-core';

describe('normalizeOriginInput', () => {
  it('assumes https for a bare domain and strips path/query', () => {
    expect(normalizeOriginInput('localmd.app')).toEqual({
      origin: 'https://localmd.app',
      pattern: 'https://localmd.app/*',
    });
    expect(normalizeOriginInput('https://sub.example.com/some/path?q=1')).toEqual({
      origin: 'https://sub.example.com',
      pattern: 'https://sub.example.com/*',
    });
  });

  it('assumes http for loopback hosts, and keeps the port in the ORIGIN only', () => {
    // Match patterns cannot carry a port (invalid in the scripting API), so the
    // pattern is host-level; precision lives in the exact-origin service gate.
    expect(normalizeOriginInput('localhost:5173')).toEqual({
      origin: 'http://localhost:5173',
      pattern: 'http://localhost/*',
    });
    expect(normalizeOriginInput('127.0.0.1:8123')).toEqual({
      origin: 'http://127.0.0.1:8123',
      pattern: 'http://127.0.0.1/*',
    });
  });

  it('refuses http for non-loopback, wildcards, junk, and other schemes', () => {
    expect(() => normalizeOriginInput('http://example.com')).toThrow(/http is only allowed for localhost/);
    expect(() => normalizeOriginInput('*.example.com')).toThrow(/wildcards/);
    expect(() => normalizeOriginInput('')).toThrow(/enter a site/);
    expect(() => normalizeOriginInput('ftp://example.com')).toThrow(/only http\(s\)/);
    expect(() => normalizeOriginInput('https://user:pw@example.com')).toThrow(/not a valid address/);
    expect(() => normalizeOriginInput('not a url at all')).toThrow();
  });
});

describe('sanitizeStoredOrigins', () => {
  it('keeps exact origins, drops junk and duplicates, never throws', () => {
    expect(
      sanitizeStoredOrigins([
        'https://localmd.app',
        'https://localmd.app', // dupe
        'https://example.com/path', // not an exact origin
        'chrome-extension://abc', // wrong scheme
        42,
        null,
        'nonsense',
      ]),
    ).toEqual(['https://localmd.app']);
    expect(sanitizeStoredOrigins('not-an-array')).toEqual([]);
    expect(sanitizeStoredOrigins(undefined)).toEqual([]);
  });
});

describe('relayScriptIdFor', () => {
  it('is stable, prefixed, and distinct per pattern', () => {
    const a = relayScriptIdFor('https://localmd.app/*');
    const b = relayScriptIdFor('http://localhost/*');
    expect(a).not.toBe(b);
    expect(a).toBe(relayScriptIdFor('https://localmd.app/*'));
    expect(isRelayScriptId(a)).toBe(true);
    expect(isRelayScriptId('some-other-script')).toBe(false);
  });
});

/* ───────── the async origin gate ───────── */

interface FakePort {
  port: chrome.runtime.Port;
  posted: Array<Record<string, unknown>>;
  send(m: unknown): void;
  disconnected: boolean;
}

function fakePort(origin?: string): FakePort {
  const posted: Array<Record<string, unknown>> = [];
  const msgHandlers: Array<(m: unknown) => void> = [];
  const self: FakePort = {
    posted,
    disconnected: false,
    send: (m) => msgHandlers.forEach((f) => f(m)),
    port: {
      name: 'webcli-web-mcp',
      sender: origin ? { origin } : {},
      postMessage: (m: Record<string, unknown>) => posted.push(m),
      disconnect: () => {
        self.disconnected = true;
      },
      onMessage: { addListener: (f: (m: unknown) => void) => msgHandlers.push(f) },
      onDisconnect: { addListener: () => {} },
    } as unknown as chrome.runtime.Port,
  };
  return self;
}

function makeHandler(allowed: () => Set<string> | Promise<Set<string>>) {
  return createExternalMcpHandler({
    runExternalTool: async () => ({ ok: true, result: {} }),
    isExternalTool: () => false,
    recordCall: () => {},
    callTimeoutMs: 1000,
    serverName: 'test',
    serverVersion: () => '0',
    allowedOrigins: allowed,
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.unstubAllGlobals());

describe('allowedOrigins gate (relay path)', () => {
  it('buffers frames sent before the async allowlist resolves, then serves them', async () => {
    vi.stubGlobal('chrome', { runtime: { lastError: undefined } });
    let release!: (s: Set<string>) => void;
    const gate = new Promise<Set<string>>((r) => (release = r));
    const handler = makeHandler(() => gate);
    const p = fakePort('http://localhost:8123');
    handler(p.port);
    // The page fires initialize immediately — before the storage read lands.
    p.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(p.posted).toHaveLength(0); // buffered, not answered, not dropped
    release(new Set(['http://localhost:8123']));
    await flush();
    expect(p.posted).toHaveLength(1);
    expect((p.posted[0] as { result?: unknown }).result).toBeTruthy();
  });

  it('refuses an origin not in the list, dropping buffered frames', async () => {
    vi.stubGlobal('chrome', { runtime: { lastError: undefined } });
    const handler = makeHandler(async () => new Set(['https://localmd.app']));
    const p = fakePort('https://evil.example');
    handler(p.port);
    p.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await flush();
    expect(p.disconnected).toBe(true);
    expect(p.posted).toHaveLength(0);
  });

  it('fails CLOSED when the allowlist read throws', async () => {
    vi.stubGlobal('chrome', { runtime: { lastError: undefined } });
    const handler = makeHandler(() => Promise.reject(new Error('storage down')));
    const p = fakePort('https://localmd.app');
    handler(p.port);
    await flush();
    expect(p.disconnected).toBe(true);
  });

  it('an empty list means nobody — the default state serves no page', async () => {
    vi.stubGlobal('chrome', { runtime: { lastError: undefined } });
    const handler = makeHandler(async () => new Set<string>());
    const p = fakePort('https://localmd.app');
    handler(p.port);
    await flush();
    expect(p.disconnected).toBe(true);
  });
});
