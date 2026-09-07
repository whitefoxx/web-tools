/**
 * PageShim — implements the subset of opencli's `page` interface that
 * adapters use, via chrome.debugger (Runtime.evaluate), chrome.tabs,
 * chrome.scripting, and chrome.cookies.
 *
 * One shim per task, bound to a tab. The first call that needs CDP attaches
 * chrome.debugger; detach() releases it. The yellow "is being debugged"
 * banner appears while attached — acceptable cost for power-user automation.
 */

import { log, warn, error as logError } from './log';
import { RateLimitedError } from './errors.js';

type DebugTarget = chrome.debugger.Debuggee;

/** Hard ceiling (CDP-level) on a single page.evaluate — terminates a step that
 * awaits a hanging/slow promise so it can't hang the SW (F-34 class; §10.27).
 * Generous so a legit slow extraction (waiting for late content) isn't cut off. */
const EVAL_TIMEOUT_MS = 60_000;

/**
 * Random delay to mimic human pacing. Used before navigations and between
 * scrolls so sustained operation against a single site doesn't trigger
 * rate-limit / captcha defenses.
 */
function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * URLs that signal we've been rate-limited / captcha-gated and should
 * stop immediately. xhs redirects automation-flagged requests to
 * `/website-login/captcha?...&verifyType=...&verifyMsg=null` and the
 * page shows "Requests too frequent. Try again later.". Continuing to
 * hammer past this point escalates toward an account ban.
 */
const CAPTCHA_URL_PATTERNS: { domain: string; regex: RegExp }[] = [
  { domain: 'xiaohongshu.com', regex: /xiaohongshu\.com\/website-login(\/|\?|$)/i },
];

function captchaDomainFor(url: string): string | null {
  for (const { domain, regex } of CAPTCHA_URL_PATTERNS) {
    if (regex.test(url)) return domain;
  }
  return null;
}

/**
 * Auto-IIFE-wrap a JS string before sending to Runtime.evaluate. opencli's
 * page.evaluate does this internally so adapter code can write either an
 * IIFE OR a bare arrow function — both work. We mirror the behavior here
 * so byte-imported adapters from opencli (which sometimes write
 * `async () => {...}` un-invoked) don't silently return the function
 * object instead of its awaited result.
 *
 * Source: opencli/src/browser/utils.ts wrapForEval()
 */
export function wrapForEval(js: string): string {
  if (typeof js !== 'string') return 'undefined';
  const code = js.trim();
  if (!code) return 'undefined';
  let out: string;
  // Already an IIFE: `(...)( ... )`
  if (/^\([\s\S]*\)\s*\(.*\)\s*$/.test(code)) out = code;
  // Arrow function: `() => ...` or `async () => ...`
  else if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(code)) out = `(${code})()`;
  // Function declaration: `function ...` or `async function ...`
  else if (/^(async\s+)?function[\s(]/.test(code)) out = `(${code})()`;
  // Statement body with a top-level `return` — LLMs frequently write
  // `const x = ...; return x;` and forget the IIFE wrapper, which otherwise
  // fails with "Illegal return statement". Wrap in an async IIFE so it's valid
  // and may use top-level await. (Bare expressions have no `return`, so this
  // never swallows their value — they fall through to the as-is branch.)
  else if (/(?:^|[\n;{])\s*return[\s;(]/.test(code)) out = `(async () => {\n${code}\n})()`;
  // Bare expression — `new Promise(...)`, an object literal, etc. — leave as-is.
  else out = code;
  // Inject the __loc robust-locator helper ONLY when the code references it, so
  // marketplace adapters that don't use it are byte-for-byte unchanged (zero
  // risk + no per-eval cost). The guarded statement before the expression keeps
  // the script's completion value = the adapter expression (awaited). B1.
  return /\b__loc\b/.test(code) ? `${LOC_PREAMBLE}\n${out}` : out;
}

/**
 * Robust-locator helper (B1) installed once on `window.__loc` inside the page
 * MAIN world, exposing vanilla-JS equivalents of Playwright's getByRole/getByText
 * so synthesized adapters anchor on role + accessible-name + visible text instead
 * of obfuscated classes. Idempotent + try-guarded (never throws → never breaks an
 * eval). ES5-style for maximum page-context compatibility.
 *   __loc.byRole(role,{name})  __loc.byText(str,{tag,exact})  __loc.byLabel(str)
 *   __loc.near(anchorEl,{tag,max})  __loc.units([sel…])  __loc.first(root,[sel…])
 *   __loc.field(root,sel)  __loc.attr(root,sel,a)  __loc.accName(el)
 */
const LOC_PREAMBLE = `try{if(!window.__loc){window.__loc=(function(){
var norm=function(s){return (s||'').replace(/\\s+/g,' ').trim();};
var vis=function(el){return !!(el&&(el.getClientRects().length||el.offsetParent));};
var arr=function(x){return Array.prototype.slice.call(x);};
var accName=function(el){if(!el)return '';try{var lb=el.getAttribute&&el.getAttribute('aria-labelledby');if(lb){var t=lb.split(/\\s+/).map(function(id){var n=document.getElementById(id);return n?n.textContent:'';}).join(' ');if(norm(t))return norm(t);}var al=el.getAttribute&&el.getAttribute('aria-label');if(al)return norm(al);if(el.id){var lab=document.querySelector('label[for="'+el.id+'"]');if(lab)return norm(lab.textContent);}var cl=el.closest&&el.closest('label');if(cl)return norm(cl.textContent);}catch(e){}return norm((el.textContent)||(el.getAttribute&&(el.getAttribute('placeholder')||el.getAttribute('title')))||'');};
var ROLE={button:'button,[role=button]',link:'a[href],[role=link]',heading:'h1,h2,h3,h4,h5,h6,[role=heading]',list:'ul,ol,[role=list]',listitem:'li,[role=listitem]',textbox:'input:not([type=hidden]),textarea,[role=textbox]',article:'article,[role=article]',img:'img,[role=img]',table:'table,[role=table]',row:'tr,[role=row]',cell:'td,th,[role=cell]'};
var hit=function(v,m){if(m==null)return true;if(m instanceof RegExp)return m.test(v);return norm(v).indexOf(norm(m))>=0;};
return {
byRole:function(role,o){o=o||{};return arr(document.querySelectorAll(ROLE[role]||('[role='+role+']'))).filter(vis).filter(function(el){return o.name==null||(o.exact?norm(accName(el))===norm(o.name):hit(accName(el),o.name));});},
byText:function(str,o){o=o||{};var tag=o.tag||'*';return arr(document.querySelectorAll(tag)).filter(vis).filter(function(el){return o.exact?norm(el.textContent)===norm(str):hit(el.textContent,str);}).filter(function(el){return !arr(el.children).some(function(c){return hit(c.textContent,str);});});},
byLabel:function(str){return arr(document.querySelectorAll('input,textarea,select,[role=textbox],[role=combobox]')).filter(vis).filter(function(el){return hit(accName(el),str);});},
near:function(anchor,o){o=o||{};var tag=o.tag||'*';var max=o.max||160;if(!anchor)return [];var r=anchor.getBoundingClientRect();return arr(document.querySelectorAll(tag)).filter(vis).map(function(el){var b=el.getBoundingClientRect();return {el:el,d:Math.abs(b.left-r.left)+Math.abs(b.top-r.top)};}).filter(function(x){return x.el!==anchor&&x.d<max;}).sort(function(a,b){return a.d-b.d;}).map(function(x){return x.el;});},
units:function(sels){for(var i=0;i<sels.length;i++){var els=arr(document.querySelectorAll(sels[i])).filter(vis);if(els.length>=2)return els;}return arr(document.querySelectorAll(sels[0]||'*')).filter(vis);},
first:function(root,sels){for(var i=0;i<sels.length;i++){var el=root?root.querySelector(sels[i]):document.querySelector(sels[i]);if(el)return el;}return null;},
field:function(root,sel){var t=sel?(root?root.querySelector(sel):document.querySelector(sel)):root;return norm(t&&t.textContent);},
attr:function(root,sel,a){var t=sel?(root?root.querySelector(sel):document.querySelector(sel)):root;return (t&&t.getAttribute(a))||'';},
accName:accName
};})();}}catch(e){}`;

export interface PageShim {
  readonly tabId: number;
  goto(url: string, opts?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void>;
  evaluate<T = unknown>(jsString: string): Promise<T>;
  /**
   * Sleep for `time` seconds. Accepts either `{ time }` (canonical) or a
   * bare number for upstream-opencli byte-compat — some adapters call
   * `page.wait(1)` expecting "1 second" and the destructuring form would
   * silently no-op (`{time}` from a number → undefined → setTimeout(NaN)).
   */
  wait(
    opts: { time?: number; selector?: string; text?: string; timeout?: number } | number,
  ): Promise<void>;
  autoScroll(opts: { times: number; delayMs?: number }): Promise<void>;
  getCookies(): Promise<chrome.cookies.Cookie[]>;
  screenshot(): Promise<string>;
  /**
   * Arm a network capture for the next XHR/Fetch response whose URL matches
   * `urlPattern`. Returns a `{body}` object once the listener is fully
   * armed (debugger attached, Network domain enabled, listener registered).
   *
   * Usage (two-phase, IMPORTANT for race-free capture):
   *
   *   const cap = await page.captureNetwork('homefeed');  // arm BEFORE action
   *   await page.goto('https://...');                     // trigger the request
   *   const data = await cap.body;                        // wait for body
   *
   * If you skip the first await and pass the un-armed promise to .body, the
   * request often fires before the listener registers and you'll timeout.
   * On timeout, the error message includes the URLs of all XHR/Fetch
   * responses seen during the window so you can spot a wrong pattern.
   */
  captureNetwork<T = unknown>(
    urlPattern: string | RegExp,
    opts?: { timeoutMs?: number },
  ): Promise<{ body: Promise<T> }>;
  /**
   * Download a remote URL to the user's Downloads folder via
   * chrome.downloads. The browser uses its own cookie store for the
   * request, so authenticated CDN assets work without extra plumbing.
   * `filename` is a relative subpath under Downloads/.
   *
   * Resolves when the download enters a terminal state ('complete' or
   * 'interrupted'). Caller decides whether to throw on !ok.
   */
  downloadFile(opts: {
    url: string;
    filename: string;
    conflictAction?: chrome.downloads.FilenameConflictAction;
  }): Promise<{ id: number; bytes: number; ok: boolean; error?: string; filename: string }>;
  /**
   * Return user-attached File objects (images for publish, etc.). The
   * files are supplied by the side-panel UI out-of-band from LLM tool
   * args — the agent loop reads them from the user state and hands them
   * to the PageShim at construction time.
   */
  getAttachments(): File[];
  /**
   * Type text into whatever element currently has focus, via CDP Input.
   *
   * - mode 'char' (default): per-character keyDown → char → keyUp via
   *   Input.dispatchKeyEvent. Slow but observed by every framework
   *   including aggressive Vue v-model custom directives.
   * - mode 'batch': single Input.insertText (IME-commit style). Faster
   *   but some frameworks treat it as not "real" input and ignore.
   *
   * For controlled inputs (xhs publish title, etc.), prefer 'char'.
   */
  insertText(text: string, opts?: { mode?: 'batch' | 'char' }): Promise<void>;
  /**
   * Monkey-patch fetch + XMLHttpRequest in the page so that responses
   * whose URL contains `pattern` get parsed as JSON and pushed onto a
   * hidden global array. Call this AFTER `goto` (since navigation wipes
   * the patches), then trigger the request, then call
   * `getInterceptedRequests()`. Used by adapters as a fallback when
   * direct `fetch` from page.evaluate returns the wrong shape.
   *
   * Idempotent: re-calling with the same pattern only updates the
   * pattern; the patches are installed once per page lifetime.
   */
  installInterceptor(pattern: string): Promise<void>;
  /**
   * Read (and clear) the buffer of intercepted JSON responses captured
   * since the last call (or since installInterceptor was first invoked).
   */
  getInterceptedRequests(): Promise<unknown[]>;

  /* ───────── opencli IPage compat surface ─────────
   * Rounds out the parts of opencli's IPage that its adapters actually call
   * (verified against the full clis/ corpus). High-frequency ones (pressKey,
   * getCurrentUrl, nativeType/Click, setFileInput) are real CDP impls; a few
   * long-tail ones degrade with a clear throw rather than silently no-op. */

  /** Dispatch a single key (Enter, Escape, ArrowDown, …) to the focused
   * element via CDP Input. */
  pressKey(key: string): Promise<void>;
  /** opencli alias: type into the focused element. */
  type(text: string): Promise<void>;
  /** Current tab URL (adapters use this to detect redirects). */
  getCurrentUrl(): Promise<string | null>;
  /** Native (trusted) typing via CDP Input.insertText. */
  nativeType(text: string): Promise<void>;
  /** Native mouse click at viewport coords via CDP Input.dispatchMouseEvent. */
  nativeClick(x: number, y: number): Promise<void>;
  /** Native key press with optional modifiers via CDP. */
  nativeKeyPress(key: string, modifiers?: string[]): Promise<void>;
  /** Set files on an <input type=file>. Throws in the extension sandbox (no
   * host filesystem paths) — use the attachments flow instead. */
  setFileInput(files: string[], selector?: string): Promise<void>;
  /** Raw CDP escape hatch — send any CDP command on this tab. */
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** opencli alias of wait, in milliseconds. */
  waitForTimeout(ms: number): Promise<void>;
  /** opencli network-capture trio, mapped onto captureNetwork. Arms a capture
   * for the next response matching `pattern`. */
  startNetworkCapture(pattern?: string): Promise<boolean>;
  /** Drain bodies armed by startNetworkCapture. */
  readNetworkCapture(): Promise<unknown[]>;
  /** Block until the armed startNetworkCapture body arrives (or timeout). */
  waitForCapture(timeout?: number): Promise<void>;

  detach(): Promise<void>;
}

export async function createPageShim(
  tabId: number,
  opts: { attachments?: File[] } = {},
): Promise<PageShim> {
  const target: DebugTarget = { tabId };
  let attached = false;
  // Whether THIS shim performed the chrome.debugger.attach (vs. reusing an
  // attachment another client already holds on this tab — e.g. an explore
  // session's network recorder). Only the owner detaches, so a per-tool shim
  // running on the explore tab can't tear down the session's capture.
  let ownsAttachment = false;
  const attachments = opts.attachments ?? [];

  // State for the opencli network-capture trio (startNetworkCapture /
  // waitForCapture / readNetworkCapture), layered on top of captureNetwork.
  let pendingCapture: Promise<unknown> | null = null;
  const capturedBodies: unknown[] = [];

  async function ensureAttached() {
    if (attached) return;
    log('page', `debugger.attach tabId=${tabId}`);
    try {
      await chrome.debugger.attach(target, '1.3');
      ownsAttachment = true;
    } catch (e) {
      // Tolerate "already attached": another client (typically an explore
      // session's network recorder) owns the debugger on this tab. Reuse the
      // existing session and remember we are NOT the owner, so detach() leaves
      // it intact instead of killing the session-wide capture.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already attached|Another debugger/i.test(msg)) throw e;
      ownsAttachment = false;
      log('page', `debugger already attached tabId=${tabId}; reusing (not owner)`);
    }
    attached = true;
  }

  async function waitForTabComplete(timeoutMs = 30_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(`goto timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // Closure-scoped evaluate helper. The public `evaluate` method just
  // delegates here, and internal helpers (installInterceptor /
  // getInterceptedRequests) call it directly without going through
  // `this` (which doesn't type-resolve cleanly in object literals).
  async function evalJs<T>(jsString: string): Promise<T> {
    await ensureAttached();
    const t0 = Date.now();
    const expression = wrapForEval(jsString);
    const result = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      // Bound the evaluation at the CDP level: a model-generated pipeline/func
      // step that awaits a never-resolving or slow promise would otherwise hang
      // the SW forever — both at synthesize-time auto-verify AND at runtime
      // (F-34 class). CDP terminates past this and returns exceptionDetails,
      // which the branch below surfaces as a clear throw. Generous (matches the
      // func path) so a legit slow extraction isn't cut off.
      timeout: EVAL_TIMEOUT_MS,
    })) as {
      result?: { value: T; type: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    const elapsed = Date.now() - t0;
    if (result.exceptionDetails) {
      const msg =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'evaluate failed';
      logError('page', `evaluate threw (${elapsed}ms)`, {
        scriptPreview: jsString.slice(0, 200),
        exception: msg,
      });
      throw new Error(`page.evaluate threw: ${msg}`);
    }
    const valueType = typeof result.result?.value;
    let valuePreview: string;
    try {
      valuePreview = JSON.stringify(result.result?.value).slice(0, 240);
    } catch {
      valuePreview = '[unserializable]';
    }
    log('page', `evaluate ok (${elapsed}ms)`, {
      scriptLen: jsString.length,
      wrapped: expression.length !== jsString.trim().length,
      returnType: result.result?.type ?? valueType,
      valuePreview,
    });
    return result.result?.value as T;
  }

  const page: PageShim = {
    tabId,

    async goto(url, opts) {
      // Human-like decision delay BEFORE issuing the navigation.
      await humanDelay(800, 1800);

      // The full `load` event on a heavy SPA (e.g. the YouTube watch page) can take
      // 30s+, which used to HARD-FAIL goto ("goto timeout after 30000ms" — flaky;
      // see docs/adapter-hot-plug.md §10.34). The DOM is usable well before full
      // load and adapters poll / capture afterward, so on timeout we PROCEED (if the
      // tab actually navigated) instead of rejecting. `waitUntil:'none'` (passed by
      // transcript.js + pipeline navigate steps) shortens the budget + proceeds
      // unconditionally.
      const fast = opts?.waitUntil === 'none';
      const cap = fast ? Math.max(1000, opts?.settleMs ?? 8000) : 30_000;
      log('page', `goto ${url}${fast ? ' (waitUntil=none)' : ''}`);
      const t0 = Date.now();
      const completePromise = waitForTabComplete(cap);
      await chrome.tabs.update(tabId, { url });
      try {
        await completePromise;
        log('page', `goto loaded (${Date.now() - t0}ms)`);
      } catch (e) {
        const landed = await chrome.tabs.get(tabId).catch(() => null);
        if (!fast && (!landed?.url || landed.url === 'about:blank')) throw e;
        log(
          'page',
          `goto proceeding before full load (${Date.now() - t0}ms → ${landed?.url ?? '?'})`,
        );
      }

      // Did the site redirect us to a captcha / verification flow?
      // If so, STOP immediately — adapter code shouldn't keep poking.
      const tab = await chrome.tabs.get(tabId);
      const landedAt = tab.url ?? '';
      const captchaDomain = captchaDomainFor(landedAt);
      if (captchaDomain) {
        logError('page', `rate-limited / captcha redirect detected`, { landedAt });
        throw new RateLimitedError(
          captchaDomain,
          landedAt,
          `${captchaDomain} redirected to a captcha/verification page (${landedAt}). Stop and try again later.`,
        );
      }

      // Settling time after navigation — human reading the page before scrolling.
      await humanDelay(1200, 2400);
    },

    async evaluate<T>(jsString: string): Promise<T> {
      return evalJs<T>(jsString);
    },

    async wait(opts) {
      // opencli's wait() is overloaded: a bare number / {time} sleeps N
      // seconds; {selector} or {text} polls the page until the condition holds
      // (or {timeout} ms elapse). Adapters rely on the polling form to avoid
      // blind fixed sleeps after navigation.
      const o = typeof opts === 'number' ? { time: opts } : (opts ?? {});
      if (o.selector || o.text) {
        const timeoutMs = typeof o.timeout === 'number' ? o.timeout : 10_000;
        const sel = o.selector ? JSON.stringify(o.selector) : 'null';
        const txt = o.text ? JSON.stringify(o.text) : 'null';
        log(
          'page',
          `wait for ${o.selector ? `selector ${o.selector}` : `text ${o.text}`} (≤${timeoutMs}ms)`,
        );
        const js = `
          new Promise((resolve) => {
            const sel = ${sel}, txt = ${txt};
            const hit = () => {
              if (sel && document.querySelector(sel)) return true;
              if (txt && (document.body?.innerText || '').includes(txt)) return true;
              return false;
            };
            if (hit()) return resolve(true);
            const obs = new MutationObserver(() => { if (hit()) { obs.disconnect(); resolve(true); } });
            obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
            setTimeout(() => { obs.disconnect(); resolve(false); }, ${timeoutMs});
          })
        `;
        await evalJs(js);
        return;
      }
      const time = o.time;
      const secs = typeof time === 'number' && Number.isFinite(time) ? Math.max(0, time) : 0;
      log('page', `wait ${secs}s`);
      await new Promise((r) => setTimeout(r, secs * 1000));
    },

    async autoScroll({ times, delayMs }) {
      // Randomize the inter-scroll delay if not explicitly provided —
      // a uniform 600ms cadence reads as obviously-scripted scroll.
      log('page', `autoScroll times=${times} delayMs=${delayMs ?? 'jittered'}`);
      for (let i = 0; i < times; i++) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () =>
            window.scrollBy(0, Math.floor(window.innerHeight * (0.7 + Math.random() * 0.2))),
        });
        const wait = delayMs ?? 800 + Math.floor(Math.random() * 700);
        await new Promise((r) => setTimeout(r, wait));
      }
    },

    async getCookies() {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url) return [];
      const cookies = await chrome.cookies.getAll({ url: tab.url });
      log('page', `getCookies url=${tab.url} count=${cookies.length}`);
      return cookies;
    },

    async screenshot() {
      await ensureAttached();
      log('page', 'screenshot');
      const result = (await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
        format: 'png',
      })) as { data: string };
      return result.data;
    },

    async captureNetwork<T>(
      urlPattern: string | RegExp,
      opts: { timeoutMs?: number } = {},
    ): Promise<{ body: Promise<T> }> {
      // PHASE 1 (armed): attach debugger, enable Network domain, register
      // listener. All synchronous-looking awaits are completed BEFORE this
      // method returns, so the caller can safely fire the request-
      // triggering action after `await captureNetwork(...)`.
      await ensureAttached();
      await chrome.debugger.sendCommand(target, 'Network.enable', {});
      const matcher = urlPattern instanceof RegExp ? urlPattern : new RegExp(urlPattern);
      const timeoutMs = opts.timeoutMs ?? 15_000;
      log('page', `captureNetwork armed pattern=${matcher.source} timeout=${timeoutMs}ms`);

      // Collect URLs we see for diagnostic output on timeout (XHR/Fetch only,
      // to skip noise from CSS/images/fonts/etc.).
      const seenUrls: string[] = [];

      const body = new Promise<T>((resolve, reject) => {
        let matchedRequestId: string | null = null;
        let matchedUrl = '';

        const cleanup = () => {
          chrome.debugger.onEvent.removeListener(handler);
          clearTimeout(timer);
        };

        const timer = setTimeout(() => {
          cleanup();
          const tail = seenUrls.slice(-25);
          const more = seenUrls.length > tail.length ? ` (showing last ${tail.length})` : '';
          const seenList = tail.length
            ? `\nSaw ${seenUrls.length} XHR/Fetch responses${more}:\n  - ${tail.join('\n  - ')}`
            : '\nNo XHR/Fetch responses observed during the window.';
          reject(
            new Error(
              `captureNetwork timeout: no match for /${matcher.source}/ within ${timeoutMs}ms.${seenList}`,
            ),
          );
        }, timeoutMs);

        const handler = async (source: DebugTarget, method: string, params: unknown) => {
          if (source.tabId !== tabId) return;
          try {
            if (method === 'Network.responseReceived') {
              const p = params as {
                requestId: string;
                type: string;
                response: { url: string };
              };
              // Filter to XHR/Fetch — ignore Document/Script/Stylesheet/Image/etc.
              if (p.type !== 'XHR' && p.type !== 'Fetch') return;
              seenUrls.push(p.response.url);
              log('page', `captureNetwork saw ${p.type}`, { url: p.response.url });
              if (matchedRequestId === null && matcher.test(p.response.url)) {
                matchedRequestId = p.requestId;
                matchedUrl = p.response.url;
                log('page', `captureNetwork matched`, {
                  url: matchedUrl,
                  requestId: matchedRequestId,
                });
              }
            } else if (method === 'Network.loadingFinished') {
              const p = params as { requestId: string };
              if (p.requestId !== matchedRequestId) return;
              const rawBody = (await chrome.debugger.sendCommand(
                target,
                'Network.getResponseBody',
                { requestId: matchedRequestId },
              )) as { body: string; base64Encoded: boolean };
              const text = rawBody.base64Encoded ? atob(rawBody.body) : rawBody.body;
              cleanup();
              log('page', `captureNetwork body received`, { url: matchedUrl, bytes: text.length });
              resolve(JSON.parse(text) as T);
            }
          } catch (e) {
            cleanup();
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        };

        chrome.debugger.onEvent.addListener(handler);
      });

      return { body };
    },

    async downloadFile({ url, filename, conflictAction = 'uniquify' }) {
      log('page', `downloadFile`, { url, filename });
      const id = await chrome.downloads.download({ url, filename, conflictAction });
      return new Promise((resolve) => {
        const onChange = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id !== id) return;
          const state = delta.state?.current;
          if (state !== 'complete' && state !== 'interrupted') return;
          chrome.downloads.onChanged.removeListener(onChange);
          chrome.downloads
            .search({ id })
            .then(([item]) => {
              const ok = state === 'complete';
              const error = ok ? undefined : (delta.error?.current ?? 'interrupted');
              log('page', `downloadFile ${ok ? '✓' : '✗'}`, {
                id,
                bytes: item?.bytesReceived ?? 0,
                error,
              });
              resolve({
                id,
                bytes: item?.bytesReceived ?? 0,
                ok,
                error,
                filename: item?.filename ?? filename,
              });
            })
            .catch(() => {
              resolve({ id, bytes: 0, ok: false, error: 'lookup failed', filename });
            });
        };
        chrome.downloads.onChanged.addListener(onChange);
      });
    },

    getAttachments() {
      return attachments.slice();
    },

    async insertText(text: string, opts: { mode?: 'batch' | 'char' } = {}) {
      await ensureAttached();
      const mode = opts.mode ?? 'char';
      if (mode === 'batch') {
        // Single-batch IME-style. Faster but some frameworks ignore it.
        log('page', `insertText batch (${text.length} chars)`);
        await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
        return;
      }
      // Full keystroke sequence: keyDown → char → keyUp per character.
      // Some Vue v-model setups only respect the full keyboard pair
      // (keyDown/keyUp listeners); a lone 'char' or batch insertText is
      // silently dropped. This path is slower (~20-50ms per char) but
      // reliable across frameworks.
      //
      // IMPORTANT: keyDown/keyUp must NOT carry `text`. A `keyDown` with a
      // `text` field already inserts the character on its own — combined
      // with the `char` event (which also inserts) that doubles every
      // character ("a" → "aa"). Only the `char` event carries `text`.
      log('page', `insertText char (${text.length} chars)`);
      for (const char of text) {
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: char,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'char',
          text: char,
          unmodifiedText: char,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: char,
        });
      }
    },

    async installInterceptor(pattern: string) {
      log('page', `installInterceptor pattern=${pattern}`);
      // Mirrors opencli's generateInterceptorJs — monkey-patch fetch + XHR
      // in the page context so JSON responses whose URL contains `pattern`
      // are pushed onto a hidden global array. patternVar is mutable so
      // re-calling updates the pattern without re-patching.
      const js = `
        (() => {
          const ARR = '__xhs_op_xhr';
          const GUARD = '__xhs_op_xhr_patched';
          const PAT = '__xhs_op_xhr_pattern';
          if (!window[ARR]) {
            Object.defineProperty(window, ARR, { value: [], writable: true, enumerable: false, configurable: true });
          }
          Object.defineProperty(window, PAT, { value: ${JSON.stringify(pattern)}, writable: true, enumerable: false, configurable: true });
          if (window[GUARD]) return true;
          Object.defineProperty(window, GUARD, { value: true, writable: false, enumerable: false, configurable: false });

          const check = (url) => {
            const p = window[PAT];
            return typeof url === 'string' && p && url.includes(p);
          };

          const origFetch = window.fetch;
          window.fetch = async function(...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            const response = await origFetch.apply(this, args);
            if (check(url)) {
              try {
                const clone = response.clone();
                const json = await clone.json();
                window[ARR].push(json);
              } catch (e) { /* non-JSON body — skip */ }
            }
            return response;
          };

          const XHR = XMLHttpRequest.prototype;
          const origOpen = XHR.open;
          const origSend = XHR.send;
          XHR.open = function(method, url) {
            Object.defineProperty(this, '__iurl', { value: String(url), writable: true, enumerable: false, configurable: true });
            return origOpen.apply(this, arguments);
          };
          XHR.send = function() {
            if (check(this.__iurl)) {
              this.addEventListener('load', function() {
                try {
                  window[ARR].push(JSON.parse(this.responseText));
                } catch (e) { /* non-JSON — skip */ }
              });
            }
            return origSend.apply(this, arguments);
          };
          return true;
        })()
      `;
      await evalJs(js);
    },

    async getInterceptedRequests() {
      const js = `
        (() => {
          const data = window.__xhs_op_xhr || [];
          window.__xhs_op_xhr = [];
          return data;
        })()
      `;
      const result = await evalJs<unknown[]>(js);
      log('page', `getInterceptedRequests`, { count: Array.isArray(result) ? result.length : 0 });
      return Array.isArray(result) ? result : [];
    },

    /* ───────── opencli IPage compat surface ───────── */

    async pressKey(key: string) {
      await ensureAttached();
      log('page', `pressKey ${key}`);
      // CDP needs windowsVirtualKeyCode for non-printable keys to fire
      // correctly. Cover the keys opencli adapters actually press; fall back to
      // a bare key event for anything else.
      const SPECIAL: Record<string, { code: string; vk: number; text?: string }> = {
        Enter: { code: 'Enter', vk: 13, text: '\r' },
        Tab: { code: 'Tab', vk: 9 },
        Escape: { code: 'Escape', vk: 27 },
        Backspace: { code: 'Backspace', vk: 8 },
        Delete: { code: 'Delete', vk: 46 },
        ArrowUp: { code: 'ArrowUp', vk: 38 },
        ArrowDown: { code: 'ArrowDown', vk: 40 },
        ArrowLeft: { code: 'ArrowLeft', vk: 37 },
        ArrowRight: { code: 'ArrowRight', vk: 39 },
        Home: { code: 'Home', vk: 36 },
        End: { code: 'End', vk: 35 },
        PageUp: { code: 'PageUp', vk: 33 },
        PageDown: { code: 'PageDown', vk: 34 },
      };
      const s = SPECIAL[key];
      // Text-carrying keys (Enter) keep type:'keyDown' + text — the shape
      // adapters have always used. Non-text specials use type:'rawKeyDown'
      // (Puppeteer's shape): on macOS a text-less 'keyDown' takes the browser
      // accelerator path and can reach the page mangled (observed: Escape
      // delivered as keydown key:'Meta' on fixtures/shadow-dom.html) —
      // 'rawKeyDown' goes straight to the renderer.
      const down: Record<string, unknown> = s
        ? {
            type: s.text ? 'keyDown' : 'rawKeyDown',
            key,
            code: s.code,
            windowsVirtualKeyCode: s.vk,
            nativeVirtualKeyCode: s.vk,
          }
        : { type: 'keyDown', key };
      if (s?.text) down.text = s.text;
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', down);
      const up: Record<string, unknown> = s
        ? {
            type: 'keyUp',
            key,
            code: s.code,
            windowsVirtualKeyCode: s.vk,
            nativeVirtualKeyCode: s.vk,
          }
        : { type: 'keyUp', key };
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', up);
    },

    async type(text: string) {
      await page.insertText(text);
    },

    async getCurrentUrl() {
      try {
        const tab = await chrome.tabs.get(tabId);
        return tab.url ?? null;
      } catch {
        return null;
      }
    },

    async nativeType(text: string) {
      await ensureAttached();
      log('page', `nativeType (${text.length} chars)`);
      await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
    },

    async nativeClick(x: number, y: number) {
      await ensureAttached();
      log('page', `nativeClick (${x},${y})`);
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
    },

    async nativeKeyPress(key: string, modifiers: string[] = []) {
      await ensureAttached();
      // CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
      const BITS: Record<string, number> = {
        Alt: 1,
        Control: 2,
        Ctrl: 2,
        Meta: 4,
        Cmd: 4,
        Shift: 8,
      };
      const mod = modifiers.reduce((acc, m) => acc | (BITS[m] ?? 0), 0);
      log('page', `nativeKeyPress ${key} mods=${modifiers.join('+') || 'none'}`);
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        modifiers: mod,
      });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        modifiers: mod,
      });
    },

    async setFileInput(files: string[], selector?: string) {
      // CDP DOM.setFileInputFiles needs absolute host-FS paths, which the
      // extension sandbox doesn't have. Be honest rather than silently no-op;
      // adapters that publish images should use getAttachments instead.
      void files;
      void selector;
      throw new Error(
        'setFileInput is not supported in the extension sandbox (no host filesystem paths). ' +
          'Use the side-panel attachments flow (page.getAttachments) for file uploads.',
      );
    },

    async cdp(method: string, params: Record<string, unknown> = {}) {
      await ensureAttached();
      log('page', `cdp ${method}`);
      return chrome.debugger.sendCommand(target, method, params);
    },

    async waitForTimeout(ms: number) {
      const millis = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0;
      log('page', `waitForTimeout ${millis}ms`);
      await new Promise((r) => setTimeout(r, millis));
    },

    async startNetworkCapture(pattern?: string) {
      // Map opencli's stateful capture onto our two-phase captureNetwork. Arm
      // now; the body is awaited by waitForCapture / readNetworkCapture.
      const pat = pattern ?? '.';
      log('page', `startNetworkCapture pattern=${pat}`);
      const cap = await page.captureNetwork(pat);
      pendingCapture = cap.body
        .then((body) => {
          capturedBodies.push(body);
          return body;
        })
        .catch((e) => {
          warn('page', 'startNetworkCapture body failed', e);
          return null;
        });
      return true;
    },

    async waitForCapture(timeout?: number) {
      if (!pendingCapture) {
        log('page', 'waitForCapture: nothing armed');
        return;
      }
      log('page', `waitForCapture (≤${timeout ?? 'default'}ms)`);
      if (typeof timeout === 'number') {
        await Promise.race([pendingCapture, new Promise((r) => setTimeout(r, timeout))]);
      } else {
        await pendingCapture;
      }
    },

    async readNetworkCapture() {
      if (pendingCapture) {
        await Promise.race([pendingCapture, new Promise((r) => setTimeout(r, 0))]);
      }
      const out = capturedBodies.slice();
      capturedBodies.length = 0;
      pendingCapture = null;
      log('page', `readNetworkCapture (${out.length} bodies)`);
      return out;
    },

    async detach() {
      if (!attached) return;
      attached = false;
      if (!ownsAttachment) {
        // We reused an attachment owned by an explore session — leave it up.
        log('page', 'debugger.detach skipped (not attachment owner)');
        return;
      }
      log('page', 'debugger.detach');
      try {
        await chrome.debugger.detach(target);
      } catch (e) {
        warn('page', 'detach error (already detached?)', e);
      }
    },
  };

  return page;
}
