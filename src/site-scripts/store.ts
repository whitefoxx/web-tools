/**
 * Site scripts (persistent site scripts / ad removal) — persistent per-site content-script rules
 * the user (or the agent, after exploring) registers to auto-modify matching
 * pages on every visit. v1 is COSMETIC: hide selectors (CSS `display:none`) +
 * optional raw CSS; an optional raw `js` field is the high-risk advanced path
 * (gated at the tool/confirm layer, not here). See docs/site-scripts-design.md.
 *
 * This file: the SiteScript record, the PURE core (validate + compile to a
 * chrome.userScripts.register shape) — fully unit-tested — and a best-effort IDB
 * store (own DB, no-ops without indexedDB, same as health-store). The actual
 * chrome.userScripts registration lives in register.ts.
 */

import { warn } from '../runtime/log';

export interface SiteScript {
  /** Primary key, e.g. `sitescript_<rand>`. Also used as the registered
   * content-script id, so it must be stable across updates. */
  id: string;
  /** Display name, e.g. "知乎 ad removal". */
  label: string;
  /** content-script match patterns, e.g. ["https://*.zhihu.com/*"]. Must be
   * specific (a concrete host) — never all-URLs / bare-`*`-host (see validation). */
  matches: string[];
  /** Cosmetic hide (v1 main path): selectors → `sel{display:none!important}`. */
  hideSelectors?: string[];
  /** Advanced: raw CSS injected as-is (user / explore output, after review). */
  css?: string;
  /** Advanced HIGH-RISK: raw JS injected into matching pages (USER_SCRIPT world).
   * Gated by an explicit confirm at the tool layer; stored verbatim here. */
  js?: string;
  /** H11 page↔LLM bridge: the script's js may call the extension's LLM via the
   * injected `__webLLM.call(prompt, {system})` API (rate-limited +
   * origin-checked in the SW, see background/page-llm.ts). Only meaningful with
   * `js`; granted through the same explicit user confirm as `js` itself. */
  llmAccess?: boolean;
  runAt: 'document_start' | 'document_end' | 'document_idle';
  enabled: boolean;
  origin: { type: 'explore' | 'manual' | 'agent'; note?: string };
  createdAt: number;
  updatedAt: number;
}

export interface SiteScriptInput {
  label?: string;
  matches: string[];
  hideSelectors?: string[];
  css?: string;
  js?: string;
  llmAccess?: boolean;
  runAt?: string;
  enabled?: boolean;
  origin?: SiteScript['origin'];
}

/** The chrome.userScripts.register shape we produce. We use userScripts (not
 * scripting.registerContentScripts) because only it takes INLINE code — required
 * for dynamic user rules; registerContentScripts only injects bundled files.
 * Plain object (not the chrome type) so it stays node-testable; register.ts
 * casts it. The injected `js` synchronously appends a <style> (cosmetic hide /
 * raw css) then runs the optional raw js — so document_start = minimal flash. */
export interface CompiledUserScript {
  id: string;
  matches: string[];
  runAt: 'document_start' | 'document_end' | 'document_idle';
  world: 'USER_SCRIPT';
  js: Array<{ code: string }>;
}

/** The combined CSS a site script injects: `sel{display:none!important}` for the
 * hide selectors, then any raw css appended. PURE — shared by compile + preview. */
export function buildSiteCss(hideSelectors: string[] | undefined, css?: string): string {
  const parts: string[] = [];
  const sel = (hideSelectors ?? [])
    .map((x) => x.trim())
    .filter(Boolean)
    .join(',');
  if (sel) parts.push(`${sel}{display:none!important}`);
  if (css?.trim()) parts.push(css.trim());
  return parts.join('\n');
}

/** Build the injected code: append a <style> for the CSS (tagged so it's
 * identifiable), then run the optional raw js — each in its own try/catch so a
 * bad rule can't break the page. `preamble` (the __webLLM bridge) is OUR
 * code, injected inside the same IIFE right before the user js so it's a
 * closure binding (not a global even in the USER_SCRIPT world). PURE. */
export function buildInjectionCode(css: string, js?: string, preamble?: string): string {
  const parts: string[] = ['(function(){'];
  if (css.trim()) {
    parts.push(
      `try{var _s=document.createElement('style');_s.setAttribute('data-web-site-script','1');` +
        `_s.textContent=${JSON.stringify(css)};(document.head||document.documentElement).appendChild(_s);}catch(_e){}`,
    );
  }
  if (js?.trim()) {
    if (preamble?.trim()) parts.push(preamble);
    // Surface js failures in the page console (USER_SCRIPT world logs land in
    // the tab's devtools) instead of dying silently — F-37 made a broken rule
    // indistinguishable from a never-injected one.
    parts.push(
      `try{\n${js}\n}catch(_e){try{console.error('[web-site-script]',_e)}catch(_x){}}`,
    );
  }
  parts.push('})();');
  return parts.join('\n');
}

/** Build the code for a JS DRY-RUN (preview_site_script `js`): splice the user's
 * js AS SOURCE (no eval — CSP-clean) into a wrapper that captures console.* +
 * any thrown error + the js's top-level return value, and returns them as one
 * structured-cloneable object so `userScripts.execute` hands them back to the
 * agent. Runs in the SAME USER_SCRIPT world as the real site script (minus the
 * __webLLM preamble — develop the DOM logic first). ES5-ish; PURE + unit-tested.
 * The agent can `return {...}` at the top level for diagnostics, OR pass its real
 * IIFE (side effects run; console/errors still captured). */
export function buildDryRunCode(js: string): string {
  return (
    '(function(){' +
    "var __logs=[],__k=['log','warn','error','info','debug'],__o={};" +
    'try{__k.forEach(function(m){__o[m]=console[m];console[m]=function(){' +
    'try{__logs.push(m+": "+Array.prototype.map.call(arguments,function(x){' +
    'try{return (typeof x==="object"&&x!==null)?JSON.stringify(x):String(x)}catch(e){return String(x)}' +
    '}).join(" "))}catch(e){}try{__o[m].apply(console,arguments)}catch(e){}}})}catch(e){}' +
    'var __ret,__err;' +
    'try{__ret=(function(){\n' +
    js +
    '\n})()}catch(e){__err=(e&&e.message?e.message:String(e))+(e&&e.stack?(" @ "+String(e.stack).split("\\n")[1]):"")}' +
    'finally{try{__k.forEach(function(m){console[m]=__o[m]})}catch(e){}}' +
    'var __rv;try{__rv=(__ret===undefined)?undefined:JSON.parse(JSON.stringify(__ret))}catch(e){__rv="[unserializable]"}' +
    'return {ok:!__err,error:__err,returnValue:__rv,logs:__logs};' +
    '})()'
  );
}

/** The `__webLLM` page API (H11 page↔LLM bridge) prepended to a script's js when
 * `llmAccess` is granted. USER_SCRIPT world + configureWorld({messaging:true})
 * make `chrome.runtime.sendMessage` available there, delivered to the SW via
 * the dedicated `onUserScriptMessage` event — the page's own (MAIN-world) JS
 * has no path onto that channel. ES5-ish on purpose. PURE. */
export function llmBridgePreamble(scriptId: string): string {
  return (
    `var __webLLM={call:function(prompt,opts){opts=opts||{};` +
    `return new Promise(function(resolve,reject){` +
    `try{chrome.runtime.sendMessage({type:'PAGE_LLM_CALL',scriptId:${JSON.stringify(scriptId)},` +
    `prompt:String(prompt==null?'':prompt).slice(0,6000),` +
    `system:opts.system?String(opts.system).slice(0,1000):undefined,` +
    `json:opts.json===true||undefined},function(resp){` +
    `var err=chrome.runtime&&chrome.runtime.lastError;` +
    `if(err){reject(new Error(err.message));return;}` +
    `if(!resp||!resp.ok){reject(new Error((resp&&resp.error)||'LLM call failed'));return;}` +
    `resolve(resp.text);});}catch(e){reject(e);}});}};`
  );
}

const RUN_ATS = new Set(['document_start', 'document_end', 'document_idle']);
const MAX_SELECTORS = 300;
const MAX_SELECTOR_LEN = 400;

/** A chrome match pattern, roughly: `<scheme>://<host><path>` where scheme is
 * `*|http|https|file|ftp`, host is `*` / `*.domain` / `domain`, path starts `/`.
 * Also accepts the literal `<all_urls>` (rejected as too-broad separately). */
export function isValidMatchPattern(p: string): boolean {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (p === '<all_urls>') return true;
  return /^(\*|https?|file|ftp):\/\/(\*|(?:\*\.)?[^/*:]+)(\/.*)$/.test(p);
}

/** Reject patterns that match (nearly) the whole web — a site script must target
 * a concrete host (design §6: no all-URLs, no bare-`*` host). */
export function isTooBroadPattern(p: string): boolean {
  if (p === '<all_urls>') return true;
  // host segment is a bare `*` (whole-web) → reject.
  const m = /^(?:\*|https?|file|ftp):\/\/([^/]*)\//.exec(p);
  if (!m) return true; // unparseable → treat as unsafe
  const host = m[1];
  return host === '*' || host === '';
}

/** Host of a match pattern, for a default label (best-effort). */
export function hostOfPattern(p: string): string {
  const m = /^(?:\*|https?|file|ftp):\/\/(?:\*\.)?([^/*:]+)/.exec(p);
  return m?.[1] ?? p;
}

function sanitizeSelectors(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s || s.length > MAX_SELECTOR_LEN) continue;
    // Defense: a selector can't contain `{`/`}` (would break out of the rule we
    // wrap it in) — drop anything that tries.
    if (s.includes('{') || s.includes('}')) continue;
    out.push(s);
    if (out.length >= MAX_SELECTORS) break;
  }
  return out;
}

/** Validate + normalize raw input into a SiteScript. PURE — throws Error with a
 * user-facing message on invalid input; the caller supplies id + now.
 * This is the single validation chokepoint (tool, bridge, and UI all go through
 * it). */
export function buildSiteScript(input: SiteScriptInput, id: string, now: number): SiteScript {
  const matches = Array.isArray(input.matches)
    ? input.matches.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean)
    : [];
  if (!matches.length)
    throw new Error('matches cannot be empty: give at least one match pattern, e.g. https://*.zhihu.com/*');
  for (const m of matches) {
    if (!isValidMatchPattern(m))
      throw new Error(`Invalid match pattern: ${m} (should look like https://*.example.com/*)`);
    if (isTooBroadPattern(m)) {
      throw new Error(`Match pattern too broad: ${m} — a site script must target a specific site; <all_urls> / wildcard hosts are not allowed`);
    }
  }
  const hideSelectors = sanitizeSelectors(input.hideSelectors);
  const css = typeof input.css === 'string' && input.css.trim() ? input.css.trim() : undefined;
  const js = typeof input.js === 'string' && input.js.trim() ? input.js.trim() : undefined;
  if (!hideSelectors.length && !css && !js) {
    throw new Error('Script has no effect: provide at least one of hide_selectors, css, or js');
  }
  // Default timing: css/hide want document_start (minimal flash), but js that
  // READS the DOM at document_start sees an empty document and dies silently
  // (the injection wrapper swallows) — the F-37 bridge-verification bug. So a
  // js-bearing script defaults to document_idle unless explicitly overridden.
  const runAt =
    typeof input.runAt === 'string' && RUN_ATS.has(input.runAt)
      ? (input.runAt as SiteScript['runAt'])
      : js
        ? 'document_idle'
        : 'document_start';
  const label =
    typeof input.label === 'string' && input.label.trim()
      ? input.label.trim().slice(0, 80)
      : `${hostOfPattern(matches[0]!)} script`;
  const origin = input.origin ?? { type: 'manual' };
  return {
    id,
    label,
    matches,
    ...(hideSelectors.length ? { hideSelectors } : {}),
    ...(css ? { css } : {}),
    ...(js ? { js } : {}),
    // LLM access requires js (the bridge is a js-side API) — silently drop
    // the grant otherwise so a css-only rule can't carry a dangling grant.
    ...(input.llmAccess && js ? { llmAccess: true } : {}),
    runAt,
    enabled: input.enabled !== false,
    origin,
    createdAt: now,
    updatedAt: now,
  };
}

/** Compile a SiteScript into a chrome.userScripts.register entry. PURE.
 * hideSelectors → one `sel{display:none!important}` rule, raw css appended, then
 * the optional raw js — all wrapped into one injected code string (see
 * buildInjectionCode). USER_SCRIPT world (isolated; has DOM, not page JS). */
export function compileSiteScript(s: SiteScript): CompiledUserScript {
  return {
    id: s.id,
    matches: s.matches,
    runAt: s.runAt,
    world: 'USER_SCRIPT',
    js: [
      {
        code: buildInjectionCode(
          buildSiteCss(s.hideSelectors, s.css),
          s.js,
          s.llmAccess && s.js ? llmBridgePreamble(s.id) : undefined,
        ),
      },
    ],
  };
}

const isHashSeg = (h: string): boolean => (/[a-z]/.test(h) && /[A-Z]/.test(h)) || /[0-9]/.test(h); // mixed-case or letter+digit

/** Does a class token look auto-generated (hashed / CSS-modules / styled-
 * components / emotion)? Such classes rot on the next site build. Mirrors the
 * F-33 synth lint. PURE. */
function looksHashedClass(c: string): boolean {
  if (/-module__/.test(c)) return true; // webpack CSS Modules
  if (/^sc-[A-Za-z]{5,}$/.test(c)) return true; // styled-components
  if (/^(?:css|jss)-?[a-z0-9]{5,}$/i.test(c)) return true; // emotion / jss
  const m = /__([A-Za-z0-9]{4,10})$/.exec(c); // trailing __<hash> in a compound class
  if (m && (/-/.test(c) || (c.match(/__/g) ?? []).length >= 2) && isHashSeg(m[1]!)) return true;
  if (/[-_]/.test(c)) return false; // has separators but none of the above → treat as stable
  if (c.length < 5 || c.length > 8) return false; // separator-free: only short randoms
  return /[a-z][A-Z]/.test(c) || (/[0-9]/.test(c) && /[A-Za-z]/.test(c));
}

/** Return the class tokens across the given selectors that look auto-generated
 * (fragile — break on the next site rebuild), for a lint warning at the tool
 * layer. Empty = all selectors look durable. PURE; unit-tested. */
export function flagFragileSelectors(selectors: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const sel of selectors ?? []) {
    if (typeof sel !== 'string') continue;
    for (const t of sel.match(/\.[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? []) {
      if (looksHashedClass(t.slice(1))) out.add(t);
    }
  }
  return [...out];
}

/** One-line human summary for confirm dialogs / logs. PURE. */
export function describeSiteScript(s: SiteScript): string {
  const bits: string[] = [];
  if (s.hideSelectors?.length) bits.push(`hide ${s.hideSelectors.length} selector(s)`);
  if (s.css) bits.push('inject CSS');
  if (s.js) bits.push('⚠️ inject JS');
  return `${s.label} · matches ${s.matches.join(', ')} · ${bits.join(' + ') || '(empty)'}`;
}

/** All site-script ids share this prefix so a boot reconcile can tell OUR
 * registered content scripts apart from anything else. */
export const SITE_SCRIPT_ID_PREFIX = 'sitescript_';

export function isSiteScriptId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(SITE_SCRIPT_ID_PREFIX);
}

/** Fresh stable id. Impure (time + random) → not unit-tested. */
export function makeSiteScriptId(): string {
  return `${SITE_SCRIPT_ID_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── IndexedDB (best-effort; no-ops without indexedDB, same as health-store) ──

const DB_NAME = 'web-agent-site-scripts';
const STORE = 'site_scripts';

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      fn(store).then((result) => {
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error ?? new Error('IDB tx failed'));
        t.onabort = () => reject(t.error ?? new Error('IDB tx aborted'));
      }, reject);
    });
  } finally {
    db.close();
  }
}

export async function putSiteScript(s: SiteScript): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await withStore('readwrite', (store) => reqAsPromise(store.put(s)).then(() => undefined));
  } catch (e) {
    warn('site-scripts', 'putSiteScript failed', e);
  }
}

export async function getSiteScript(id: string): Promise<SiteScript | null> {
  if (!hasIndexedDb()) return null;
  try {
    return await withStore('readonly', async (store) => {
      const v = await reqAsPromise(store.get(id));
      return (v as SiteScript | undefined) ?? null;
    });
  } catch (e) {
    warn('site-scripts', 'getSiteScript failed', e);
    return null;
  }
}

export async function listSiteScripts(): Promise<SiteScript[]> {
  if (!hasIndexedDb()) return [];
  try {
    return await withStore('readonly', async (store) => {
      const all = (await reqAsPromise(store.getAll())) as SiteScript[] | undefined;
      const rows = all ?? [];
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      return rows;
    });
  } catch (e) {
    warn('site-scripts', 'listSiteScripts failed', e);
    return [];
  }
}

export async function deleteSiteScript(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await withStore('readwrite', (store) => reqAsPromise(store.delete(id)).then(() => undefined));
  } catch (e) {
    warn('site-scripts', 'deleteSiteScript failed', e);
  }
}

export async function setSiteScriptEnabled(id: string, enabled: boolean): Promise<void> {
  const row = await getSiteScript(id);
  if (!row) return;
  row.enabled = enabled;
  row.updatedAt = Date.now();
  await putSiteScript(row);
}
