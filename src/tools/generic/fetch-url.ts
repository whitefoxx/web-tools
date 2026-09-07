import { cli } from '../../runtime/registry.js';
import { assertHttpUrl } from './_helpers';
import { parseHtml } from './_mini-dom';
import { extractPageMarkdown } from './get-page-text';

/**
 * fetch_url — the RAW (non-rendering) half of "web fetch", complementing
 * get_page_text (which opens a tab and RENDERS). This hits a URL directly from
 * the service worker: no tab, no JS execution, exact response bytes + status +
 * headers. The SW fetch runs with `credentials:'include'` and the extension's
 * <all_urls> host permission, so it's **cookie-authenticated and CORS-free** —
 * the same session the user is logged into.
 *
 * Use it for: JSON APIs, RSS/Atom, sitemap.xml / robots.txt, checking status
 * codes + redirects + headers, small text/data files, POSTing to an endpoint,
 * and — with format:"markdown" — reading a server-rendered article without
 * paying for a tab. Use get_page_text instead when the content is rendered by
 * JS (SPAs): fetch_url sees the HTML the server sent, nothing a script added.
 *
 * format:"markdown" reuses get_page_text's walker verbatim, over a MiniDocument
 * parsed from the response (`_mini-dom.ts`) — one Markdown dialect for both the
 * rendered and the raw path, not two that drift.
 *
 * `runFetch` is exported and unit-tested (stub global fetch); the cli() wrapper
 * only validates the URL + parses the headers arg.
 *
 * ## Early-stop (`stream_stop`) — bodies that never end
 *
 * The default read is buffered: `res.text()` waits for the server to close the
 * body. That is right for a document and wrong for a stream. MCP's Streamable
 * HTTP transport answers a POST with `text/event-stream` and is allowed to hold
 * that stream open indefinitely, so the buffered read can only ever end in
 * `timeout_ms` — the response is sitting in the buffer, unreachable.
 *
 * `stream_stop` opts into a reader loop that can stop before the body ends:
 * `"first_event"` returns once the first complete SSE event carrying `data:` has
 * arrived, `"idle"` returns once the stream has been quiet for `idle_timeout_ms`.
 * Either way the result carries `stream_open: true` — you got a prefix, not the
 * whole body. The default (`"none"`) keeps the old buffered path verbatim.
 */

const DEFAULT_MAX_BYTES = 200_000;
const DEFAULT_IDLE_MS = 5_000;

/** How the body read may end before the server closes it. */
export type StreamStop = 'none' | 'first_event' | 'idle';

export interface FetchResult {
  url: string;
  status: number;
  ok: boolean;
  statusText: string;
  headers: Record<string, string>;
  content_type: string;
  format: 'json' | 'text' | 'markdown';
  /** Whether the user's cookies were sent (mirrors the with_cookies arg). */
  with_cookies: boolean;
  body?: string;
  json?: unknown;
  markdown?: string;
  title?: string;
  /** Set when markdown was asked for but the response wasn't HTML, and/or when
   * the read stopped early — it says which. */
  note?: string;
  bytes: number;
  truncated: boolean;
  /** Only present when stream_stop was in play: the mode that was applied. */
  stream_stop?: Exclude<StreamStop, 'none'>;
  /** Only present when stream_stop was in play. True = the read stopped before
   * the server ended the body, so `body` is a PREFIX: more may have followed. */
  stream_open?: boolean;
}

export interface RunFetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  format?: string; // 'auto' (default) | 'json' | 'text' | 'markdown'
  selector?: string | null;
  maxBytes?: number;
  timeoutMs?: number;
  /** Send the user's cookies (default true). False = fetch as a signed-out visitor. */
  withCookies?: boolean;
  /** Stop reading before the body ends (default 'none' = the buffered read). */
  streamStop?: StreamStop;
  /** 'idle' mode only: quiet period that ends the read (default 5000). */
  idleTimeoutMs?: number;
}

/**
 * End offset (exclusive) of the first complete SSE event that carries a `data:`
 * field, or -1 if the buffer doesn't hold one yet.
 *
 * Events are separated by a blank line (CRLF/LF/CR pairs). Blocks WITHOUT a
 * `data` field are skipped rather than counted: `: keepalive` comments and bare
 * `event:`/`retry:` blocks are framing, not the message the caller is waiting
 * for, and stopping on one would return an empty payload.
 */
export function firstDataEventEnd(buf: string): number {
  const boundary = /\r\n\r\n|\n\n|\r\r/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(buf)) !== null) {
    const end = m.index + m[0].length;
    if (/^data(?::|$)/m.test(buf.slice(start, m.index))) return end;
    start = end;
  }
  return -1;
}

/** Thrown by the idle watchdog; distinguishable from a real read failure. */
class IdleStop extends Error {}

/** Reject with IdleStop if `p` hasn't settled within `ms`. */
function withIdleDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new IdleStop(`no data for ${ms}ms`)), ms);
    }),
  ]);
}

interface StreamRead {
  text: string;
  /** The read ended before the body did. */
  streamOpen: boolean;
  truncated: boolean;
  note?: string;
}

/**
 * Read the body incrementally so the read can end before the body does.
 *
 * Cancelling the reader is what releases the connection — per the fetch spec,
 * cancelling a response's body stream terminates the ongoing fetch, so an SSE
 * stream we walk away from doesn't stay open behind us.
 */
async function readWithStop(
  res: Response,
  mode: Exclude<StreamStop, 'none'>,
  opts: { maxBytes: number; idleMs: number; sse: boolean },
): Promise<StreamRead> {
  // A bodyless response (HEAD, 204) has nothing to stream — the buffered read
  // returns immediately and can't hang.
  if (!res.body) return { text: await res.text(), streamOpen: false, truncated: false };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let streamOpen = false;
  let truncated = false;
  let note: string | undefined;

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        const read = reader.read();
        chunk = mode === 'idle' ? await withIdleDeadline(read, opts.idleMs) : await read;
      } catch (e) {
        if (e instanceof IdleStop) {
          streamOpen = true;
          note = `stopped after ${opts.idleMs}ms with no data — the stream was still open`;
          break;
        }
        // timeout_ms fired (or the connection died) mid-stream. Bytes already in
        // hand beat an error that throws them away — but only if there are any,
        // otherwise this is just a timeout and must be reported as one.
        if (!buf) throw e;
        streamOpen = true;
        note = `read timed out mid-stream — returning the ${buf.length} chars received so far`;
        break;
      }
      if (chunk.done) break;

      buf += decoder.decode(chunk.value, { stream: true });

      if (buf.length >= opts.maxBytes) {
        buf = buf.slice(0, opts.maxBytes);
        truncated = true;
        streamOpen = true;
        note = `stopped at max_bytes (${opts.maxBytes}) — the stream was still open`;
        break;
      }
      if (mode === 'first_event' && opts.sse) {
        const end = firstDataEventEnd(buf);
        if (end >= 0) {
          // Trim any trailing PARTIAL event so what comes back always parses as
          // whole SSE events. Anything the server sends after this is lost.
          buf = buf.slice(0, end);
          streamOpen = true;
          note = 'stopped after the first SSE data event — later messages on this stream were not read';
          break;
        }
      }
    }
    if (!streamOpen) buf += decoder.decode(); // flush the decoder's tail
  } finally {
    reader.cancel().catch(() => {});
  }

  return { text: buf, streamOpen, truncated, note };
}

/** Perform the fetch and shape the result. No tab; SW-side, cookie-authenticated. */
export async function runFetch(rawUrl: string, opts: RunFetchOpts = {}): Promise<FetchResult> {
  const method = (opts.method || 'GET').toUpperCase();
  const maxBytes = Math.max(1, Math.min(1_000_000, opts.maxBytes ?? DEFAULT_MAX_BYTES));
  const timeoutMs = Math.max(1000, Math.min(60_000, opts.timeoutMs ?? 20_000));
  const bodyless = method === 'GET' || method === 'HEAD';
  // Cookies default ON (the point of fetching from the user's browser is their
  // session), but callers can opt out to see the page a signed-out visitor gets,
  // or to keep an account out of a request entirely.
  const withCookies = opts.withCookies !== false;

  const res = await fetch(rawUrl, {
    method,
    ...(opts.headers && Object.keys(opts.headers).length ? { headers: opts.headers } : {}),
    body: bodyless ? undefined : (opts.body ?? undefined),
    credentials: withCookies ? 'include' : 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const contentType = res.headers.get('content-type') || '';

  // Default: the buffered read, unchanged. Only an explicit stream_stop takes
  // the incremental path — nothing about the old shape moves for old callers.
  const streamStop = opts.streamStop ?? 'none';
  let text: string;
  let rawBytes: number;
  let truncated: boolean;
  let stream: StreamRead | null = null;
  if (streamStop === 'none') {
    const raw = await res.text();
    truncated = raw.length > maxBytes;
    text = truncated ? raw.slice(0, maxBytes) : raw;
    rawBytes = raw.length;
  } else {
    stream = await readWithStop(res, streamStop, {
      maxBytes,
      idleMs: Math.max(200, Math.min(60_000, opts.idleTimeoutMs ?? DEFAULT_IDLE_MS)),
      sse: /\btext\/event-stream\b/i.test(contentType),
    });
    text = stream.text;
    truncated = stream.truncated;
    // `bytes` counts what was READ, not what the server would eventually have
    // sent — on an early stop the full length is unknowable by construction.
    rawBytes = stream.text.length;
  }

  const wantMarkdown = opts.format === 'markdown';
  const wantJson =
    opts.format === 'json' ||
    (!wantMarkdown &&
      opts.format !== 'text' &&
      /\bapplication\/(?:[\w.+-]*\+)?json\b|\/json\b/i.test(contentType));

  const out: FetchResult = {
    url: res.url || rawUrl,
    status: res.status,
    ok: res.ok,
    statusText: res.statusText,
    headers,
    content_type: contentType,
    format: wantJson ? 'json' : wantMarkdown ? 'markdown' : 'text',
    // Reported back so a login wall / anonymous-looking page is self-explaining
    // instead of a mystery ("why am I signed out?" — because cookies were off).
    with_cookies: withCookies,
    bytes: rawBytes,
    truncated,
    ...(stream ? { stream_stop: streamStop as Exclude<StreamStop, 'none'>, stream_open: stream.streamOpen } : {}),
  };
  if (wantJson) {
    try {
      out.json = JSON.parse(text);
    } catch {
      // Declared/looked JSON but didn't parse (truncated or mislabeled) → give text.
      out.format = 'text';
      out.body = text;
    }
  } else if (wantMarkdown) {
    // Only HTML can become Markdown. Anything else (JSON, plain text, XML feeds)
    // degrades to text WITH a note rather than running a tag walker over bytes
    // that have no tags — silently emitting the input back as "markdown" would
    // read as success.
    const looksHtml = /\bhtml\b/i.test(contentType) || /<\s*(html|body|div|p|h[1-6])\b/i.test(text);
    if (!looksHtml) {
      out.format = 'text';
      out.body = text;
      out.note = `content-type ${contentType || 'unknown'} is not HTML — returned as text, not markdown`;
    } else {
      const doc = parseHtml(text, out.url);
      const md = extractPageMarkdown(maxBytes, opts.selector ?? null, doc);
      out.markdown = md.markdown;
      if (md.title) out.title = md.title;
      if (opts.selector && !md.markdown) {
        out.note = `selector "${opts.selector}" matched nothing (or is outside the supported subset: tag/#id/.class/[attr], comma groups, descendant combinators)`;
      }
    }
  } else {
    out.body = text;
  }
  // Appended, never assigned: the format branches above own `note` too, and an
  // early stop is exactly the context that explains a weird-looking body.
  if (stream?.note) out.note = out.note ? `${out.note}; ${stream.note}` : stream.note;
  return out;
}

/**
 * Normalize the `stream_stop` arg. `first_message` / `first` are accepted as
 * aliases for `first_event` — MCP calls them messages, SSE calls them events,
 * and a caller shouldn't have to know which vocabulary we picked. An
 * unrecognized value throws rather than falling back to 'none': silently
 * ignoring it hands back the very hang the caller was trying to avoid.
 */
export function parseStreamStop(v: unknown): StreamStop {
  if (v == null) return 'none';
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'none' || s === 'false') return 'none';
  if (s === 'first_event' || s === 'first_message' || s === 'first') return 'first_event';
  if (s === 'idle') return 'idle';
  throw new Error(`stream_stop must be "none", "first_event" or "idle" (got ${JSON.stringify(String(v))})`);
}

/** Accept a headers arg as a JSON object OR a JSON string; ignore junk. */
export function parseHeaders(v: unknown): Record<string, string> {
  let obj: unknown = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return {};
    try {
      obj = JSON.parse(s);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
    else if (val != null) out[k] = String(val);
  }
  return out;
}

cli({
  site: 'generic',
  name: 'fetch_url',
  access: 'read',
  description:
    'Fetch a URL **directly, without opening a tab** (no browser, no JS execution) — the cheapest way to read a page, and the fastest. Returns {status, headers, body | json | markdown}. **Complements** get_page_text: get_page_text renders in a tab (needed for SPAs / JS-built content); fetch_url uses the Service Worker fetch, **with the user\'s cookies and CORS-free**, and sees exactly the bytes the server sent. **format:"markdown" turns a server-rendered page into clean Markdown in one call** (same converter get_page_text uses; prefers the main/article region, drops nav/footer/script) — reach for it FIRST on articles, docs, blogs, READMEs, anything server-rendered, and only fall back to get_page_text when the result comes back empty or obviously missing the JS-built content. Also good for: JSON API / RSS / sitemap.xml / robots.txt / checking status codes and redirects / POSTing to an endpoint. method defaults to GET (GET/HEAD ignore body). If the endpoint answers with a stream that stays open (SSE, MCP Streamable HTTP), the default whole-body read can only end in a timeout — use `stream_stop` to return on the first event instead. **Non-GET (POST/PUT/DELETE) has real side effects — be careful.**',
  args: [
    { name: 'url', type: 'string', required: true, help: 'URL to fetch (http/https)' },
    { name: 'method', type: 'string', default: 'GET', help: 'HTTP method (GET/POST/PUT/DELETE/HEAD…), default GET' },
    { name: 'headers', type: 'string', help: 'Optional request headers, a JSON object or JSON string (e.g. {"Accept":"application/json"})' },
    { name: 'body', type: 'string', help: 'Optional request body (non-GET/HEAD only; a string, pass a JSON string for JSON)' },
    { name: 'format', type: 'string', default: 'auto', help: '"auto" (default, by content-type) | "markdown" (HTML → readable Markdown in the `markdown` field — use this to READ a page) | "json" (parse to object) | "text" (raw body). markdown on a non-HTML response degrades to text and says so in `note`' },
    { name: 'selector', type: 'string', help: 'format:"markdown" only — convert just this element instead of the whole page. Supported subset: comma groups of tag/#id/.class/[attr] / [attr="v"] compounds with descendant (space) combinators; no child/sibling combinators or pseudo-classes. Matching nothing yields empty markdown + a note' },
    { name: 'with_cookies', type: 'bool', default: true, help: 'Send the user\'s cookies for that site — **default true**, which is the point of fetching from their browser (paywalled / logged-in pages just work). Pass false to fetch as an anonymous visitor: to see the signed-out version of a page, or to keep the user\'s account out of the request entirely. The result echoes `with_cookies` so a login wall is self-explaining' },
    { name: 'max_bytes', type: 'int', default: 200000, help: 'Max bytes to read from the response body (default 200000, max 1000000)' },
    { name: 'timeout_ms', type: 'int', default: 20000, help: 'Timeout (ms, default 20000, range 1000–60000)' },
    { name: 'stream_stop', type: 'string', default: 'none', help: 'Stop reading BEFORE the server closes the body — for endpoints that answer with a stream that stays open (MCP Streamable HTTP, SSE APIs), where the default read can only end in a timeout. "none" (default) = read the whole body. "first_event" = return as soon as the first complete SSE `data:` event arrives — **anything the server sends afterwards on that stream is lost**, so use it for request/response calls, not to consume a feed. Note it stops at the first event, which is not necessarily the one you want: a server that interleaves progress notifications ahead of its reply will hand you the notification. Use "idle" when that is possible, and pick your message out of the events it returns. "idle" = return once the stream has been quiet for idle_timeout_ms. Both set `stream_open:true` in the result to say the body is a PREFIX, and `bytes` then counts what was read, not what the server had left to send' },
    { name: 'idle_timeout_ms', type: 'int', default: 5000, help: 'stream_stop:"idle" only — quiet period that ends the read (ms, default 5000, range 200–60000). "first_event" ignores it and is bounded by timeout_ms instead' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const url = assertHttpUrl(kwargs.url);
    const method = typeof kwargs.method === 'string' && kwargs.method.trim() ? kwargs.method.trim() : 'GET';
    const headers = parseHeaders(kwargs.headers);
    const body = typeof kwargs.body === 'string' ? kwargs.body : undefined;
    const format = typeof kwargs.format === 'string' ? kwargs.format : 'auto';
    const selector = typeof kwargs.selector === 'string' && kwargs.selector.trim() ? kwargs.selector.trim() : null;
    // Only an explicit false turns cookies off — an omitted / junk value keeps
    // the credentialed default rather than silently signing the user out.
    const withCookies = !(kwargs.with_cookies === false || kwargs.with_cookies === 'false');
    const maxBytes = Number(kwargs.max_bytes ?? DEFAULT_MAX_BYTES) || DEFAULT_MAX_BYTES;
    const timeoutMs = Number(kwargs.timeout_ms ?? 20_000) || 20_000;
    const streamStop = parseStreamStop(kwargs.stream_stop);
    const idleTimeoutMs = Number(kwargs.idle_timeout_ms ?? DEFAULT_IDLE_MS) || DEFAULT_IDLE_MS;
    try {
      return await runFetch(url, {
        method,
        headers,
        body,
        format,
        selector,
        withCookies,
        maxBytes,
        timeoutMs,
        streamStop,
        idleTimeoutMs,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `fetch_url failed: ${msg}${/timeout|abort/i.test(msg) ? ' (timeout? try a larger timeout_ms)' : ''}`,
        { cause: e },
      );
    }
  },
});
