// @vitest-environment jsdom
/**
 * The relay content script, actually running in a document.
 *
 * Every localmd Connect capability rides this file: the page's tool calls go
 * out through it and the inbox poke comes back through it, so when it breaks,
 * everything breaks at once — and it broke in a way no other layer could see
 * (findings F-58). The re-entry guard was placed ABOVE `const EXT_ID`, function
 * declarations hoist, the bundler lowers `const` to `var`, and so the relay ran
 * with `EXT_ID === undefined`: it attached, announced itself, and then dropped
 * every frame the page sent as "addressed to another install".
 *
 * Unit tests could not see it (nothing imported this module), the type checker
 * could not see it (the types are fine), and the browser did not report it (no
 * exception, just silence). What catches it is running the module and checking
 * the two things the page depends on: the marker carries the real extension id,
 * and a frame the page sends reaches the port.
 *
 * The relay is booted ONCE for the file. A content script cannot be detached,
 * and jsdom gives the whole file one window — so a per-test boot would leave
 * every earlier relay listening, and each frame would be forwarded once per
 * boot. Tests assert on what is NEW since they started.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const EXT_ID = 'bgennbocoapjiiolmmlcbfingimhmchh';
const PORT_NAME = 'webcli-web-mcp';

/** What the relay handed to the extension side. */
const sent: unknown[] = [];
/** Port names the relay dialled — one per live port, so this measures redials. */
const connects: string[] = [];
/** Frames the relay posted back to the page. */
const frames: Array<Record<string, unknown>> = [];

let extListeners: Array<(m: unknown) => void> = [];
let dropListeners: Array<() => void> = [];

function installChrome(): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: EXT_ID,
      lastError: undefined,
      connect: (info: { name: string }) => {
        connects.push(info.name);
        return {
          name: info.name,
          postMessage: (m: unknown) => sent.push(m),
          onMessage: { addListener: (f: (m: unknown) => void) => extListeners.push(f) },
          onDisconnect: { addListener: (f: () => void) => dropListeners.push(f) },
          disconnect: () => {},
        };
      },
    },
  };
}

/**
 * A frame from the page, as the relay must see it.
 *
 * Dispatched by hand rather than through `window.postMessage`, because the
 * relay's first guard is `e.source !== window` — a real browser fills `source`
 * in for a same-window post and jsdom leaves it null, so a plain postMessage
 * here would test the guard instead of the relay.
 */
function fromPage(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

/** postMessage lands in a later task; one macrotask is enough for jsdom. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let mark = 0;
const newSent = (): unknown[] => sent.slice(mark);

describe('localmd Connect web relay', () => {
  beforeAll(async () => {
    installChrome();
    window.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as Record<string, unknown> | null;
      if (d && d.webcli === 'mcp' && d.dir === 'to-page') frames.push(d);
    });
    await import('../src/localmd-connect/web-relay');
    await settle();
  });

  beforeEach(() => {
    mark = sent.length;
  });

  it('marks the document with the REAL extension id', () => {
    // The whole bug in one assertion: this read the string "undefined".
    expect(document.documentElement.dataset.localmdConnect).toBe(EXT_ID);
  });

  it('announces itself with the real id', () => {
    const ready = frames.filter((f) => f.ready === true);
    expect(ready).toHaveLength(1);
    expect(ready[0].ext).toBe(EXT_ID);
  });

  it('forwards a frame the page addressed to this install', () => {
    fromPage({ webcli: 'mcp', dir: 'to-ext', ext: EXT_ID, msg: { id: 1, method: 'tools/list' } });
    expect(newSent()).toEqual([{ id: 1, method: 'tools/list' }]);
    expect(connects).toEqual([PORT_NAME]); // one dial, then cached
  });

  it('forwards a frame that names no install', () => {
    fromPage({ webcli: 'mcp', dir: 'to-ext', msg: { id: 2 } });
    expect(newSent()).toEqual([{ id: 2 }]);
  });

  it('drops a frame addressed to a different install', () => {
    fromPage({ webcli: 'mcp', dir: 'to-ext', ext: 'someotherextension', msg: { id: 3 } });
    expect(newSent()).toEqual([]);
  });

  it('ignores anything that is not an MCP frame', () => {
    fromPage({ hello: 'world' });
    fromPage({ webcli: 'mcp', dir: 'to-page', ext: EXT_ID, msg: { id: 4 } });
    fromPage({ webcli: 'mcp', dir: 'to-ext', ext: EXT_ID }); // no msg
    expect(newSent()).toEqual([]);
  });

  it('carries a push from the extension to the page', async () => {
    const poke = { method: 'notifications/localmd/inbox', params: { count: 2 } };
    extListeners.forEach((f) => f(poke));
    await settle();
    const push = frames.find(
      (f) => (f.msg as { method?: string } | undefined)?.method === poke.method,
    );
    expect(push?.ext).toBe(EXT_ID);
  });

  it('does not attach a second time when re-injected into a live document', async () => {
    // What the service worker does to an already-open tab on install/update.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/localmd-connect/web-relay.ts', 'utf8');
    expect(src).toContain('__localmdRelay');
    const before = frames.filter((f) => f.ready === true).length;
    await import('../src/localmd-connect/web-relay');
    await settle();
    expect(frames.filter((f) => f.ready === true).length).toBe(before);
    fromPage({ webcli: 'mcp', dir: 'to-ext', ext: EXT_ID, msg: { id: 9 } });
    expect(newSent()).toEqual([{ id: 9 }]); // once, not twice
  });

  it('tells the page when the port dies, and redials on the next frame', async () => {
    dropListeners.forEach((f) => f());
    dropListeners = [];
    extListeners = [];
    await settle();
    const closed = frames.filter((f) => f.closed === true);
    expect(closed).toHaveLength(1);
    expect(closed[0].ext).toBe(EXT_ID);

    const dials = connects.length;
    fromPage({ webcli: 'mcp', dir: 'to-ext', ext: EXT_ID, msg: { id: 10 } });
    expect(connects.length).toBe(dials + 1); // the SW was recycled; dial again
    expect(newSent()).toEqual([{ id: 10 }]);
  });
});
