/**
 * fetch_url — raw (non-rendering) HTTP primitive. runFetch is tested by stubbing
 * global fetch with real Response objects (Node 18+ has fetch/Response/Headers);
 * parseHeaders is a pure arg parser. The cookie-authenticated SW behavior is
 * real-browser-only.
 *
 * Note this file runs in the NODE environment — no jsdom, no `document`. That is
 * load-bearing for the format:"markdown" cases below: they exercise the same code
 * path the MV3 service worker takes, proving the conversion never touches a DOM
 * (it runs the shared walker over a MiniDocument). If someone reintroduces a
 * `document` reference in that path, these tests are what break.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runFetch,
  parseHeaders,
  parseStreamStop,
  firstDataEventEnd,
} from '../src/tools/generic/fetch-url';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub global fetch; returns the captured (url, init) so tests can assert what
 * was sent, and serves the given Response. */
function stubFetch(response: Response): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  });
  return { calls };
}

describe('runFetch', () => {
  it('parses JSON when content-type is json (auto)', async () => {
    stubFetch(
      new Response('{"a":1,"b":[2,3]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const r = await runFetch('https://api.test/x', {});
    expect(r.format).toBe('json');
    expect(r.json).toEqual({ a: 1, b: [2, 3] });
    expect(r.body).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it('format:"text" keeps body text even for json content-type', async () => {
    stubFetch(new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await runFetch('https://api.test/x', { format: 'text' });
    expect(r.format).toBe('text');
    expect(r.body).toBe('{"a":1}');
    expect(r.json).toBeUndefined();
  });

  it('non-json content-type returns text body', async () => {
    stubFetch(new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const r = await runFetch('https://x.test/', {});
    expect(r.format).toBe('text');
    expect(r.body).toBe('hello world');
  });

  it('uppercases method, sends body for POST, includes credentials', async () => {
    const { calls } = stubFetch(new Response('ok', { status: 201 }));
    await runFetch('https://x.test/p', { method: 'post', body: 'payload', headers: { 'X-A': '1' } });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('payload');
    expect(calls[0].init.credentials).toBe('include');
    expect((calls[0].init.headers as Record<string, string>)['X-A']).toBe('1');
  });

  it('drops body for GET/HEAD', async () => {
    const { calls } = stubFetch(new Response('x'));
    await runFetch('https://x.test/', { method: 'GET', body: 'nope' });
    expect(calls[0].init.body).toBeUndefined();
  });

  it('truncates to maxBytes and flags truncated', async () => {
    stubFetch(new Response('x'.repeat(500), { status: 200, headers: { 'content-type': 'text/plain' } }));
    const r = await runFetch('https://x.test/', { maxBytes: 100 });
    expect(r.body?.length).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(500);
  });

  it('surfaces non-ok status', async () => {
    stubFetch(new Response('not found', { status: 404, statusText: 'Not Found' }));
    const r = await runFetch('https://x.test/missing', {});
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('json content-type but unparseable → falls back to text', async () => {
    stubFetch(new Response('{ broken', { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await runFetch('https://x.test/', {});
    expect(r.format).toBe('text');
    expect(r.body).toBe('{ broken');
  });

  it('captures response headers', async () => {
    stubFetch(new Response('x', { status: 200, headers: { 'content-type': 'text/plain', 'x-custom': 'yes' } }));
    const r = await runFetch('https://x.test/', {});
    expect(r.headers['content-type']).toBe('text/plain');
    expect(r.headers['x-custom']).toBe('yes');
  });
});

describe('runFetch — cookies are a controllable parameter', () => {
  it('sends credentials by default (the point of fetching from the user browser)', async () => {
    const s = stubFetch(new Response('x', { status: 200 }));
    const r = await runFetch('https://x.test/', {});
    expect(s.calls[0].init.credentials).toBe('include');
    expect(r.with_cookies).toBe(true);
  });

  it('withCookies:false fetches as an anonymous visitor', async () => {
    const s = stubFetch(new Response('x', { status: 200 }));
    const r = await runFetch('https://x.test/', { withCookies: false });
    expect(s.calls[0].init.credentials).toBe('omit');
    // Echoed back so a login wall in the body is self-explaining.
    expect(r.with_cookies).toBe(false);
  });

  it('only an explicit false opts out — undefined stays credentialed', async () => {
    const s = stubFetch(new Response('x', { status: 200 }));
    await runFetch('https://x.test/', { withCookies: undefined });
    expect(s.calls[0].init.credentials).toBe('include');
  });
});

const HTML = `<html><head><title>Post</title></head><body>
  <nav>menu</nav>
  <main><h1>Heading</h1><p>Body <a href="/l">link</a>.</p><ul><li>a</li><li>b</li></ul></main>
  <footer>foot</footer></body></html>`;

describe('runFetch — format:"markdown" (read a page without a tab)', () => {
  it('converts HTML to markdown, with the title, and no raw body', async () => {
    stubFetch(new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const r = await runFetch('https://x.test/p', { format: 'markdown' });
    expect(r.format).toBe('markdown');
    expect(r.title).toBe('Post');
    expect(r.markdown).toContain('# Heading');
    expect(r.markdown).toContain('[link](https://x.test/l)'); // relative hrefs come out absolute
    expect(r.markdown).toContain('- a');
    expect(r.markdown).not.toContain('menu'); // nav/footer dropped by the walker
    expect(r.markdown).not.toContain('foot');
    expect(r.body).toBeUndefined();
  });

  it('scopes to a selector', async () => {
    stubFetch(
      new Response('<body><div id="x"><p>inside</p></div><p>outside</p></body>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const r = await runFetch('https://x.test/p', { format: 'markdown', selector: '#x' });
    expect(r.markdown).toContain('inside');
    expect(r.markdown).not.toContain('outside');
  });

  it('a selector matching nothing says so instead of silently returning ""', async () => {
    stubFetch(new Response('<body><p>x</p></body>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const r = await runFetch('https://x.test/p', { format: 'markdown', selector: '#nope' });
    expect(r.markdown).toBe('');
    expect(r.note).toMatch(/matched nothing/);
  });

  it('degrades to text WITH a note when the response is not HTML', async () => {
    stubFetch(
      new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const r = await runFetch('https://api.test/x', { format: 'markdown' });
    expect(r.format).toBe('text');
    expect(r.body).toBe('{"a":1}');
    expect(r.markdown).toBeUndefined();
    expect(r.note).toMatch(/not HTML/);
  });

  it('still converts HTML served with a vague content-type (sniffs the body)', async () => {
    stubFetch(
      new Response('<html><body><h1>Hi</h1></body></html>', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    const r = await runFetch('https://x.test/p', { format: 'markdown' });
    expect(r.format).toBe('markdown');
    expect(r.markdown).toContain('# Hi');
  });

  it('markdown mode is not hijacked by a json content-type', async () => {
    stubFetch(
      new Response('<html><body><p>page</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const r = await runFetch('https://x.test/', { format: 'markdown' });
    expect(r.format).toBe('markdown');
    expect(r.json).toBeUndefined();
  });
});

/**
 * A Response whose body is a stream the test feeds by hand. Crucially, NOTHING
 * closes it unless the test says so — that open-forever body is the MCP
 * Streamable HTTP case, and the whole point of stream_stop. Every test here caps
 * its own timeout so a regression to the buffered read fails fast instead of
 * hanging on vitest's default.
 */
function streamingResponse(init?: ResponseInit) {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, init),
    push: (s: string) => ctrl.enqueue(enc.encode(s)),
    close: () => ctrl.close(),
    fail: (e: Error) => ctrl.error(e),
    wasCancelled: () => cancelled,
  };
}

const SSE = { 'content-type': 'text/event-stream' };
const RPC = '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}';

describe('firstDataEventEnd — SSE framing', () => {
  it('finds the end of a complete LF-separated data event', () => {
    const buf = `event: message\ndata: ${RPC}\n\n`;
    expect(firstDataEventEnd(buf)).toBe(buf.length);
  });

  it('handles CRLF framing', () => {
    const buf = `event: message\r\ndata: ${RPC}\r\n\r\n`;
    expect(firstDataEventEnd(buf)).toBe(buf.length);
  });

  it('an event still arriving is not complete', () => {
    expect(firstDataEventEnd(`event: message\ndata: ${RPC}`)).toBe(-1);
  });

  it('skips comment/keepalive blocks — they carry no message', () => {
    const buf = `: keepalive\n\nevent: message\ndata: ${RPC}\n\n`;
    expect(firstDataEventEnd(buf)).toBe(buf.length);
    expect(firstDataEventEnd(': keepalive\n\n: keepalive\n\n')).toBe(-1);
  });

  it('stops at the FIRST data event, not the last', () => {
    const first = `data: one\n\n`;
    expect(firstDataEventEnd(`${first}data: two\n\n`)).toBe(first.length);
  });
});

describe('runFetch — stream_stop (bodies that never end)', () => {
  it('first_event returns from a stream that is still open', { timeout: 2000 }, async () => {
    const s = streamingResponse({ status: 200, headers: SSE });
    s.push(`event: message\ndata: ${RPC}\n\n`); // …and never close: this is opentargets
    stubFetch(s.response);

    const r = await runFetch('https://mcp.test/mcp', { method: 'POST', streamStop: 'first_event' });

    expect(r.body).toBe(`event: message\ndata: ${RPC}\n\n`);
    expect(r.stream_open).toBe(true);
    expect(r.stream_stop).toBe('first_event');
    expect(r.note).toMatch(/first SSE data event/);
    expect(JSON.parse(r.body!.split('data: ')[1]).result.protocolVersion).toBe('2025-03-26');
  });

  it('cancels the reader, so the abandoned stream does not stay open', { timeout: 2000 }, async () => {
    const s = streamingResponse({ status: 200, headers: SSE });
    s.push(`data: ${RPC}\n\n`);
    stubFetch(s.response);
    await runFetch('https://mcp.test/mcp', { streamStop: 'first_event' });
    expect(s.wasCancelled()).toBe(true);
  });

  it('keeps a complete second event but drops a trailing partial one', { timeout: 2000 }, async () => {
    const s = streamingResponse({ status: 200, headers: SSE });
    s.push(`data: one\n\ndata: two\n\ndata: hal`);
    stubFetch(s.response);
    const r = await runFetch('https://mcp.test/mcp', { streamStop: 'first_event' });
    // Everything up to the first event's boundary; the rest of that chunk is not
    // ours to interpret.
    expect(r.body).toBe('data: one\n\n');
  });

  it('first_event on a NON-SSE response reads the body to the end', { timeout: 2000 }, async () => {
    const s = streamingResponse({ status: 200, headers: { 'content-type': 'application/json' } });
    s.push('{"a":');
    s.push('1}');
    s.close();
    stubFetch(s.response);
    const r = await runFetch('https://api.test/x', { streamStop: 'first_event' });
    expect(r.json).toEqual({ a: 1 });
    expect(r.stream_open).toBe(false);
    expect(r.note).toBeUndefined();
  });

  it('idle returns what arrived once the stream goes quiet', { timeout: 2000 }, async () => {
    const s = streamingResponse({ status: 200, headers: { 'content-type': 'application/json' } });
    s.push('{"a":1}'); // full body delivered, but nothing ever closes it
    stubFetch(s.response);

    const r = await runFetch('https://api.test/x', { streamStop: 'idle', idleTimeoutMs: 200 });

    expect(r.json).toEqual({ a: 1 });
    expect(r.stream_open).toBe(true);
    expect(r.stream_stop).toBe('idle');
    expect(r.note).toMatch(/200ms with no data/);
  });

  it('caps at maxBytes instead of buffering an endless stream', { timeout: 2000 }, async () => {
    const s = streamingResponse({ status: 200, headers: SSE });
    s.push('x'.repeat(500));
    stubFetch(s.response);
    const r = await runFetch('https://mcp.test/', { streamStop: 'idle', idleTimeoutMs: 200, maxBytes: 100 });
    expect(r.body?.length).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.stream_open).toBe(true);
    // bytes counts what was READ — the server's full length is unknowable here.
    expect(r.bytes).toBe(100);
  });

  it('a mid-stream failure keeps the bytes already received', { timeout: 2000 }, async () => {
    // Errored on the SECOND pull, i.e. after the first chunk has been handed
    // over — erroring a queued stream up front would just discard the queue.
    const enc = new TextEncoder();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(enc.encode('data: half'));
        } else c.error(new Error('signal timed out'));
      },
    });
    stubFetch(new Response(body, { status: 200, headers: SSE }));
    const r = await runFetch('https://mcp.test/', { streamStop: 'first_event' });
    expect(r.body).toBe('data: half');
    expect(r.stream_open).toBe(true);
    expect(r.note).toMatch(/timed out mid-stream/);
  });

  it('but a failure with nothing received is still an error', { timeout: 2000 }, async () => {
    const s = streamingResponse({ status: 200, headers: SSE });
    s.fail(new Error('signal timed out'));
    stubFetch(s.response);
    await expect(runFetch('https://mcp.test/', { streamStop: 'first_event' })).rejects.toThrow(/timed out/);
  });

  it('the default read is untouched — no stream fields, whole body', { timeout: 2000 }, async () => {
    const s = streamingResponse({ status: 200, headers: SSE });
    s.push(`data: ${RPC}\n\n`);
    s.close(); // a server that DOES close, like mcp.mermaid.ai
    stubFetch(s.response);

    const r = await runFetch('https://mcp.test/mcp', {});

    expect(r.body).toBe(`data: ${RPC}\n\n`);
    expect('stream_open' in r).toBe(false);
    expect('stream_stop' in r).toBe(false);
  });

  it('response headers survive the streaming path (Mcp-Session-Id)', { timeout: 2000 }, async () => {
    const s = streamingResponse({
      status: 200,
      headers: { ...SSE, 'mcp-session-id': 'abc-123' },
    });
    s.push(`data: ${RPC}\n\n`);
    stubFetch(s.response);
    const r = await runFetch('https://mcp.test/mcp', { streamStop: 'first_event' });
    expect(r.headers['mcp-session-id']).toBe('abc-123');
  });
});

describe('parseStreamStop', () => {
  it('defaults to none', () => {
    expect(parseStreamStop(undefined)).toBe('none');
    expect(parseStreamStop('')).toBe('none');
    expect(parseStreamStop('none')).toBe('none');
  });
  it('accepts the MCP vocabulary as an alias for the SSE one', () => {
    expect(parseStreamStop('first_event')).toBe('first_event');
    expect(parseStreamStop('first_message')).toBe('first_event');
    expect(parseStreamStop('first')).toBe('first_event');
    expect(parseStreamStop('IDLE')).toBe('idle');
  });
  it('rejects junk instead of silently reinstating the hang', () => {
    expect(() => parseStreamStop('firstevent')).toThrow(/stream_stop must be/);
  });
});

describe('parseHeaders', () => {
  it('accepts an object', () => {
    expect(parseHeaders({ A: '1', B: 2 })).toEqual({ A: '1', B: '2' });
  });
  it('accepts a JSON string', () => {
    expect(parseHeaders('{"Accept":"application/json"}')).toEqual({ Accept: 'application/json' });
  });
  it('bad/blank/array → empty', () => {
    expect(parseHeaders('not json')).toEqual({});
    expect(parseHeaders('')).toEqual({});
    expect(parseHeaders(['a'])).toEqual({});
    expect(parseHeaders(undefined)).toEqual({});
  });
});
