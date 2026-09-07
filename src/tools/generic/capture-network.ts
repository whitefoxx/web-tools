import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';
import { createPageShim, type PageShim } from '../../runtime/page';
import { detectWriteIntent } from './_eval-write-guard';
import { log, warn } from '../../runtime/log';

/**
 * `capture_network` — observe the requests a tab makes, WITH their response
 * bodies, through the debugger's Network domain.
 *
 * SHARED-BASE recon primitive (docs/architecture.md §A.6): the live,
 * tab-addressed counterpart to the full shell's trace-reading list_network /
 * read_network (those need an explore recording). It answers "which request
 * produced the value I see" and reaches requests the page world cannot observe
 * itself (workers, the media pipeline, tokens the page attaches). Registered by
 * `_generic.ts`.
 *
 * Three actions on one tab: `start` (attach, arm a URL pattern), `read` (return
 * matches so far — or run a `reduce` snippet over them IN THE PAGE and return
 * only its result, so a large payload becomes rows before it reaches the model),
 * `stop` (release the debugger). A capture also stops after ten idle minutes or
 * when the tab closes.
 */

type Entry = {
  seq: number;
  requestId: string;
  url: string;
  method: string;
  type: string;
  status: number;
  mimeType: string;
  bodyChars: number;
  body: string | null;
  note?: string;
  finishedAt: number;
};

type Capture = {
  tabId: number;
  page: PageShim;
  pattern: RegExp;
  patternSource: string;
  allTypes: boolean;
  entries: Entry[];
  pending: Map<string, Omit<Entry, 'seq' | 'bodyChars' | 'body' | 'finishedAt'>>;
  methods: Map<string, string>;
  seq: number;
  startedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  detached: boolean;
  handler: (source: chrome.debugger.Debuggee, method: string, params?: unknown) => void;
};

const MAX_ENTRIES = 50;
const MAX_BODY_CHARS = 5_000_000;
const IDLE_STOP_MS = 10 * 60_000;
const MAX_WAIT_MS = 120_000;

const captures = new Map<number, Capture>();
let globalListenersInstalled = false;

function installGlobalListeners(): void {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;
  try {
    chrome.tabs.onRemoved.addListener((tabId) => {
      const cap = captures.get(tabId);
      if (cap) void stopCapture(cap, 'tab closed');
    });
  } catch {
    /* test environments stub chrome partially */
  }
  try {
    chrome.debugger.onDetach.addListener((source) => {
      const cap = source.tabId !== undefined ? captures.get(source.tabId) : undefined;
      if (cap) {
        cap.detached = true;
        chrome.debugger.onEvent.removeListener(cap.handler);
        log('capture_network', `debugger detached under us tab=${cap.tabId}; entries kept for read`);
      }
    });
  } catch {
    /* ignore */
  }
}

function touchIdle(cap: Capture): void {
  if (cap.idleTimer) clearTimeout(cap.idleTimer);
  cap.idleTimer = setTimeout(() => void stopCapture(cap, 'idle'), IDLE_STOP_MS);
}

async function stopCapture(cap: Capture, why: string): Promise<void> {
  if (captures.get(cap.tabId) !== cap) return;
  captures.delete(cap.tabId);
  if (cap.idleTimer) clearTimeout(cap.idleTimer);
  chrome.debugger.onEvent.removeListener(cap.handler);
  log('capture_network', `stop tab=${cap.tabId} (${why}) entries=${cap.entries.length}`);
  if (cap.detached) return;
  try {
    await cap.page.cdp('Network.disable');
  } catch {
    /* already gone */
  }
  try {
    await cap.page.detach();
  } catch (e) {
    warn('capture_network', 'detach failed', e);
  }
}

function isTextMime(mime: string): boolean {
  return /^(text\/|application\/(json|xml|javascript|x-javascript|ecmascript|x-www-form-urlencoded)|.*\+(json|xml)$)/i.test(
    mime,
  );
}

async function startCapture(tabId: number, patternSource: string, allTypes: boolean): Promise<Capture> {
  installGlobalListeners();
  const existing = captures.get(tabId);
  if (existing) await stopCapture(existing, 'restarted');
  const pattern = new RegExp(patternSource);
  const page = await createPageShim(tabId);
  await page.cdp('Network.enable', {});
  const cap: Capture = {
    tabId,
    page,
    pattern,
    patternSource,
    allTypes,
    entries: [],
    pending: new Map(),
    methods: new Map(),
    seq: 0,
    startedAt: Date.now(),
    idleTimer: undefined,
    detached: false,
    handler: () => {},
  };
  cap.handler = (source, method, params) => {
    if (source.tabId !== tabId) return;
    try {
      if (method === 'Network.requestWillBeSent') {
        const p = params as { requestId: string; request: { url: string; method: string } };
        if (pattern.test(p.request.url)) cap.methods.set(p.requestId, p.request.method);
      } else if (method === 'Network.responseReceived') {
        const p = params as {
          requestId: string;
          type: string;
          response: { url: string; status: number; mimeType: string };
        };
        if (!allTypes && p.type !== 'XHR' && p.type !== 'Fetch') return;
        if (!pattern.test(p.response.url)) return;
        cap.pending.set(p.requestId, {
          requestId: p.requestId,
          url: p.response.url,
          method: cap.methods.get(p.requestId) ?? 'GET',
          type: p.type,
          status: p.response.status,
          mimeType: p.response.mimeType ?? '',
        });
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const p = params as { requestId: string };
        const head = cap.pending.get(p.requestId);
        if (!head) return;
        cap.pending.delete(p.requestId);
        cap.methods.delete(p.requestId);
        if (method === 'Network.loadingFailed') return;
        void (async () => {
          let body: string | null = null;
          let note: string | undefined;
          try {
            const raw = (await cap.page.cdp('Network.getResponseBody', { requestId: p.requestId })) as {
              body: string;
              base64Encoded: boolean;
            };
            if (raw.base64Encoded && !isTextMime(head.mimeType)) {
              note = `binary body (${head.mimeType || 'unknown type'}) not returned`;
            } else {
              body = raw.base64Encoded ? atob(raw.body) : raw.body;
              if (body.length > MAX_BODY_CHARS) {
                note = `body truncated to ${MAX_BODY_CHARS} chars`;
                body = body.slice(0, MAX_BODY_CHARS);
              }
            }
          } catch (e) {
            note = `body unavailable: ${e instanceof Error ? e.message : String(e)}`;
          }
          cap.entries.push({
            ...head,
            seq: ++cap.seq,
            bodyChars: body ? body.length : 0,
            body,
            ...(note ? { note } : {}),
            finishedAt: Date.now(),
          });
          if (cap.entries.length > MAX_ENTRIES) cap.entries.splice(0, cap.entries.length - MAX_ENTRIES);
          touchIdle(cap);
        })();
      }
    } catch (e) {
      warn('capture_network', 'event handler error', e);
    }
  };
  chrome.debugger.onEvent.addListener(cap.handler);
  captures.set(tabId, cap);
  touchIdle(cap);
  log('capture_network', `start tab=${tabId} pattern=/${patternSource}/ allTypes=${allTypes}`);
  return cap;
}

function summarize(cap: Capture, maxChars: number, sinceSeq: number) {
  return cap.entries
    .filter((e) => e.seq > sinceSeq)
    .map((e) => ({
      seq: e.seq,
      url: e.url,
      method: e.method,
      type: e.type,
      status: e.status,
      mimeType: e.mimeType,
      bodyChars: e.bodyChars,
      ...(e.note ? { note: e.note } : {}),
      body:
        e.body === null
          ? null
          : e.body.length > maxChars
            ? e.body.slice(0, maxChars) + '\n…[truncated]'
            : e.body,
    }));
}

function reduceExpression(reduce: string, entriesJson: string): string {
  const trimmed = reduce.trim();
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(trimmed) || /^(async\s+)?function[\s(]/.test(trimmed)) {
    return `(async () => { const __f = (${trimmed}); return await __f(${entriesJson}); })()`;
  }
  return `(async () => { const entries = ${entriesJson};\n${trimmed}\n})()`;
}

cli({
  site: 'generic',
  name: 'capture_network',
  access: 'read',
  description:
    'Observe the requests a tab makes, WITH their response bodies, through the debugger (so it also sees what the page world cannot: requests from workers, from the media pipeline, or with tokens the page attaches itself). Three actions on one tab. action:"start" — attach and arm a URL `pattern` (regular expression; XHR/Fetch only unless all_types:true), then trigger the requests you care about (eval_js, click, scroll, or just wait). action:"read" — return the matching responses captured so far (url, status, mimeType, body); pass wait_ms to wait for at least min_entries of them first. Bodies can be large: prefer passing `reduce`, a JS snippet run IN THE PAGE with `entries` (each {url, status, mimeType, body}) in scope — write `return …` — so only its result comes back (a 200 KB payload becomes rows). action:"stop" — release the debugger (a capture also stops after 10 idle minutes or when the tab closes). Chrome shows its "is being debugged" bar on the tab while a capture is armed. Each entry\'s `body` is the raw response STRING — JSON.parse it yourself inside `reduce`. To observe a request the page makes on its FIRST load, arm the capture on a fresh tab BEFORE navigating to the page: RELOADING a tab that already has a capture attached can leave a single-page app blank, losing the load you meant to watch. Once you have what you came for, stop the capture and work from the captured payload — re-arming and reloading in a loop is how a session gets spent.',
  args: [
    { name: 'tab_id', type: 'int', required: true, help: 'The tab to observe' },
    { name: 'action', type: 'string', default: 'start', help: '"start" (default) | "read" | "stop"' },
    {
      name: 'pattern',
      type: 'string',
      help: 'start only: regular expression matched against the response URL, e.g. "/api/timedtext" or "graphql/\\\\w+/TweetDetail"',
    },
    {
      name: 'all_types',
      type: 'bool',
      help: 'start only: also capture non-XHR/Fetch resources (documents, scripts, media). Default false',
    },
    {
      name: 'wait_ms',
      type: 'int',
      default: 0,
      help: 'read only: wait up to this long (ms, cap 120000) for min_entries matches before returning',
    },
    { name: 'min_entries', type: 'int', default: 1, help: 'read only: how many matches wait_ms waits for (default 1)' },
    {
      name: 'since_seq',
      type: 'int',
      default: 0,
      help: 'read only: return only entries with seq greater than this (each entry carries a seq, so you can page new arrivals)',
    },
    {
      name: 'reduce',
      type: 'string',
      help: 'read only: JS run in the page over `entries` (full bodies); return a JSON-serializable value and only that comes back. Same write guard as eval_js',
    },
    {
      name: 'max_chars',
      type: 'int',
      default: 8000,
      help: 'read only: max characters per body (without reduce) or of the reduced result (default 8000, cap 200000)',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await assertTabId(kwargs.tab_id);
    const tabId = Number(kwargs.tab_id);
    const action = String(kwargs.action ?? 'start').trim().toLowerCase();

    if (action === 'start') {
      const patternSource = typeof kwargs.pattern === 'string' ? kwargs.pattern.trim() : '';
      if (!patternSource) return { ok: false, error: 'start needs a pattern (regular expression matched against the URL)' };
      try {
        new RegExp(patternSource);
      } catch (e) {
        return { ok: false, error: `invalid pattern: ${e instanceof Error ? e.message : String(e)}` };
      }
      const cap = await startCapture(tabId, patternSource, Boolean(kwargs.all_types));
      return {
        ok: true,
        tabId,
        armed: true,
        pattern: cap.patternSource,
        note: 'Now trigger the requests (eval_js / click / wait), then action:"read" with wait_ms. action:"stop" when done.',
      };
    }

    const cap = captures.get(tabId);
    if (!cap) return { ok: false, tabId, error: 'no capture on this tab — call action:"start" with a pattern first' };

    if (action === 'stop') {
      const n = cap.entries.length;
      await stopCapture(cap, 'stop');
      return { ok: true, tabId, stopped: true, entries: n };
    }

    if (action !== 'read') return { ok: false, error: `unknown action "${action}" (start | read | stop)` };

    touchIdle(cap);
    const maxChars = Math.max(200, Math.min(Number(kwargs.max_chars ?? 8000) || 8000, 200_000));
    const waitMs = Math.max(0, Math.min(Number(kwargs.wait_ms ?? 0) || 0, MAX_WAIT_MS));
    const minEntries = Math.max(1, Number(kwargs.min_entries ?? 1) || 1);
    const sinceSeq = Math.max(0, Number(kwargs.since_seq ?? 0) || 0);
    const countNew = () => cap.entries.filter((e) => e.seq > sinceSeq).length;
    const deadline = Date.now() + waitMs;
    while (countNew() < minEntries && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const base = {
      ok: true,
      tabId,
      pattern: cap.patternSource,
      detached: cap.detached,
      count: countNew(),
      ...(cap.pending.size ? { inFlight: cap.pending.size } : {}),
    };
    const reduce = typeof kwargs.reduce === 'string' ? kwargs.reduce.trim() : '';
    if (!reduce) return { ...base, entries: summarize(cap, maxChars, sinceSeq) };

    const writeSignal = detectWriteIntent(reduce);
    if (writeSignal) {
      return { ...base, ok: false, error: `Blocked: the reduce snippet looks like it initiates a write request (${writeSignal}); reduce is for shaping captured data only` };
    }
    if (cap.detached) return { ...base, ok: false, error: 'the debugger was detached from this tab; read without reduce, or start again' };
    const full = cap.entries
      .filter((e) => e.seq > sinceSeq)
      .map((e) => ({ seq: e.seq, url: e.url, method: e.method, type: e.type, status: e.status, mimeType: e.mimeType, body: e.body }));
    try {
      const result = await cap.page.evaluate<unknown>(reduceExpression(reduce, JSON.stringify(full)));
      let serialized: string;
      if (result === undefined) serialized = 'undefined';
      else if (typeof result === 'string') serialized = result;
      else {
        try {
          serialized = JSON.stringify(result, null, 2);
        } catch {
          serialized = String(result);
        }
      }
      const truncated = serialized.length > maxChars;
      return {
        ...base,
        reduced: true,
        resultType: Array.isArray(result) ? `array(${result.length})` : typeof result,
        truncated,
        result: truncated ? serialized.slice(0, maxChars) + '\n…[truncated]' : serialized,
      };
    } catch (e) {
      return { ...base, ok: false, error: `reduce failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
