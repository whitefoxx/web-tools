/**
 * Site-scripts registration — projects the IDB records (source of truth) onto
 * chrome.userScripts (persistent registered user scripts). We use userScripts
 * (not scripting.registerContentScripts) because only it takes INLINE code,
 * which dynamic user rules need. Needs the "Allow user scripts" toggle (same as
 * Phase B func adapters); when it's off, register no-ops with a warning and the
 * UI surfaces the requirement. See docs/site-scripts-design.md.
 */

import { warn, log } from '../runtime/log';
import {
  compileSiteScript,
  buildSiteCss,
  buildDryRunCode,
  getSiteScript,
  listSiteScripts,
  isSiteScriptId,
} from './store';
import type { SiteScript } from './store';

const SCOPE = 'site-scripts';

/** Minimal shape of the chrome.userScripts methods we use — @types/chrome's
 * userScripts coverage is partial, and sw-runner already accesses it loosely. */
interface UserScriptsApi {
  register(scripts: unknown[]): Promise<void>;
  update(scripts: unknown[]): Promise<void>;
  unregister(filter?: { ids?: string[] }): Promise<void>;
  getScripts(filter?: { ids?: string[] }): Promise<Array<{ id: string }>>;
  /** One-shot injection (Chrome 135+) — used for the JS dry-run. Same
   * USER_SCRIPT world (CSP-exempt) the persistent scripts run in. */
  execute?(injection: {
    target: { tabId: number };
    js: Array<{ code: string }>;
    world?: string;
    injectImmediately?: boolean;
  }): Promise<Array<{ result?: unknown; error?: unknown }>>;
}

function us(): UserScriptsApi | null {
  const c = (globalThis as { chrome?: { userScripts?: unknown } }).chrome;
  const api = c?.userScripts as UserScriptsApi | undefined;
  return api && typeof api.register === 'function' ? api : null;
}

/** Whether persistent site scripts can run (userScripts API present = toggle on). */
export function siteScriptsRunnable(): boolean {
  return us() !== null;
}

/** Register or update ONE site script (idempotent). No-op + warn if userScripts
 * is unavailable (toggle off). */
export async function applySiteScript(s: SiteScript): Promise<void> {
  const api = us();
  if (!api) {
    warn(SCOPE, `userScripts unavailable — enable "Allow user scripts" to run ${s.id}`);
    return;
  }
  const compiled = compileSiteScript(s);
  const existing = await api.getScripts({ ids: [s.id] }).catch(() => []);
  if (existing.length) await api.update([compiled]);
  else await api.register([compiled]);
  log(SCOPE, `${existing.length ? 'updated' : 'registered'} ${s.id}`, { matches: s.matches });
}

/** Unregister ONE by id (ignores "not registered"). */
export async function unregisterSiteScriptById(id: string): Promise<void> {
  const api = us();
  if (!api) return;
  try {
    await api.unregister({ ids: [id] });
    log(SCOPE, `unregistered ${id}`);
  } catch {
    /* wasn't registered — fine */
  }
}

/** WYSIWYG preview (v1.1): temporarily inject a rule's CSS into a tab
 * (non-persistent — gone on reload) so the user eyeballs the effect BEFORE
 * committing a persistent rule. Returns how many elements the hide selectors
 * currently match (so the agent can tell if the selectors actually hit). Uses
 * chrome.scripting (no "Allow user scripts" toggle needed — this isn't a
 * registration). Best-effort. */
export async function previewSiteScript(
  tabId: number,
  hideSelectors: string[] | undefined,
  css?: string,
  highlight?: boolean,
): Promise<{ matched: number; injected: boolean }> {
  const hideSel = (hideSelectors ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');
  // `highlight` mode OUTLINES the would-be-hidden elements (instead of hiding
  // them) so the user sees WHICH elements a selector matches before committing.
  const cssText =
    highlight && hideSel
      ? `${hideSel}{outline:3px solid #ff2d2d !important;outline-offset:-2px;background:rgba(255,45,45,0.12) !important}`
      : buildSiteCss(hideSelectors, css);
  let injected = false;
  if (cssText) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, css: cssText });
      injected = true;
    } catch (e) {
      warn(SCOPE, 'preview insertCSS failed', e);
    }
  }
  let matched = 0;
  const sel = (hideSelectors ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');
  if (sel) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (s: string) => {
          try {
            return document.querySelectorAll(s).length;
          } catch {
            return -1;
          }
        },
        args: [sel],
      });
      matched = (res[0]?.result as number) ?? 0;
    } catch (e) {
      warn(SCOPE, 'preview count failed', e);
    }
  }
  return { matched, injected };
}

export interface DryRunResult {
  /** The dry-run actually executed (false = toggle off / API missing / inject error). */
  ran: boolean;
  /** Thrown error from the user JS (message + first stack line), or an infra error. */
  error?: string;
  /** The JS's top-level return value (if it `return`ed one) — JSON-cloned. */
  returnValue?: unknown;
  /** console.* output captured during the run, newest last. */
  logs: string[];
}

/** Run a candidate site-script JS ONCE on an open tab, in the SAME USER_SCRIPT
 * world the persistent script would run in, and return its console output +
 * thrown error + top-level return value — so the agent can verify the DOM logic
 * / selectors / URL guards BEFORE committing a persistent rule (the blind
 * create→reload→wait loop is the #1 reason these fail; see docs §site-scripts).
 * Non-persistent (gone on reload). No __webLLM (test the DOM logic first).
 * Best-effort; needs the "Allow user scripts" toggle. */
export async function dryRunSiteScriptJs(tabId: number, js: string): Promise<DryRunResult> {
  const api = us();
  if (!api || typeof api.execute !== 'function') {
    return {
      ran: false,
      error:
        'Cannot dry-run: first enable this extension\'s "Allow user scripts" toggle at chrome://extensions (the same execution world site scripts run in).',
      logs: [],
    };
  }
  try {
    const res = await api.execute({
      target: { tabId },
      js: [{ code: buildDryRunCode(js) }],
      world: 'USER_SCRIPT',
      injectImmediately: true,
    });
    const r = res?.[0];
    if (r?.error) return { ran: false, error: String(r.error), logs: [] };
    const out = r?.result as Partial<DryRunResult> & { ok?: boolean };
    // The wrapper (buildDryRunCode) always returns an object when it parses, so
    // getting nothing back means the whole injection failed to PARSE — the
    // caller's JS has a syntax error and took the wrapper's own try/catch down
    // with it. This used to answer `ran: true` with no logs, which is
    // indistinguishable from "your code ran and did nothing" and sends whoever
    // wrote it looking at the wrong thing (findings F-54).
    if (!out || typeof out !== 'object') {
      return {
        ran: false,
        error:
          'The JavaScript did not run: it could not be parsed. Chrome reports a parse failure with no message, so check the syntax. The usual causes: a top-level `await` (this runs inside a PLAIN function, not an async one), an unbalanced bracket or quote, or `return` outside a function. A RUNTIME error would have come back with its own message, so this is a syntax problem, not a logic one.',
        logs: [],
      };
    }
    return {
      ran: true,
      ...(out.error ? { error: out.error } : {}),
      returnValue: out.returnValue,
      logs: Array.isArray(out.logs) ? out.logs : [],
    };
  } catch (e) {
    return { ran: false, error: e instanceof Error ? e.message : String(e), logs: [] };
  }
}

/** Make chrome match the stored record: register if it exists + enabled, else
 * unregister. The single "apply my change" entry for create / update / toggle. */
export async function refreshSiteScript(id: string): Promise<void> {
  const s = await getSiteScript(id);
  if (!s || !s.enabled) {
    await unregisterSiteScriptById(id);
    return;
  }
  await applySiteScript(s);
}

/** Reconcile IDB (source of truth) ↔ registered user scripts on SW boot:
 * register/update every enabled record, and unregister any of OURS that no
 * longer should be there (drift guard). Best-effort. */
export async function syncSiteScriptsOnBoot(): Promise<{ registered: number; removed: number }> {
  const api = us();
  if (!api) return { registered: 0, removed: 0 };
  let registered = 0;
  let removed = 0;
  try {
    const enabled = (await listSiteScripts()).filter((s) => s.enabled);
    const wantIds = new Set(enabled.map((s) => s.id));
    for (const s of enabled) {
      try {
        await applySiteScript(s);
        registered++;
      } catch (e) {
        warn(SCOPE, `boot register ${s.id} failed`, e);
      }
    }
    const all = await api.getScripts().catch(() => []);
    for (const rs of all) {
      if (isSiteScriptId(rs.id) && !wantIds.has(rs.id)) {
        try {
          await api.unregister({ ids: [rs.id] });
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    log(SCOPE, `boot sync: ${registered} registered, ${removed} removed`);
  } catch (e) {
    warn(SCOPE, 'boot sync failed', e);
  }
  return { registered, removed };
}
