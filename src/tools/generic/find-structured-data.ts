import { cli } from '../../runtime/registry.js';
import { getActiveExploreSession } from '../../core/explore-gate';
import { assertTabId } from './_helpers';
import { createPageShim } from '../../runtime/page';

/**
 * Explore-time structured-data sweep: in ONE call, surface the page's stable,
 * declarative data sources — the cheapest-to-synthesize and slowest-to-rot
 * sources, which beat scraping styled DOM. Covers (robustness-ladder rung ②):
 *   - JSON-LD (`<script type="application/ld+json">`, schema.org)
 *   - framework hydration state (__NEXT_DATA__ / __NUXT__ / __APOLLO_STATE__ /
 *     __INITIAL_STATE__ / Remix / SvelteKit) + raw `<script type=json>` blobs
 *   - OpenGraph / Twitter-card / product meta
 *   - RSS/Atom/JSON-Feed/oEmbed `<link rel=alternate>` autodiscovery
 *   - Microdata itemtypes
 *   - client storage: IndexedDB databases (+ object stores) and localStorage /
 *     sessionStorage keys — SPAs (chat apps, dashboards) often cache the full
 *     data there (e.g. DeepSeek's whole conversation lives in IndexedDB).
 * Returns types + key/store lists + small samples (bounded by construction —
 * never whole blobs, per the V2.4 freeze lesson). Runs in the page MAIN world via
 * the session's CDP eval (so it sees `window.__*` globals + storage + login
 * state). After a hit, dig in with eval_js (e.g. read `window.__NEXT_DATA__.props…`
 * or open the named IndexedDB store). Explore only.
 */

const SWEEP = `(async () => {
  const out = { jsonld: [], state: {}, meta: {}, feeds: [], microdata: [], storage: {} };
  const cap = (a, n) => (Array.isArray(a) ? a.slice(0, n) : a);
  try {
    out.jsonld = cap([...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((s) => {
      try { const j = JSON.parse(s.textContent || 'null'); const arr = Array.isArray(j) ? j : (j && j['@graph']) || [j];
        return (arr || []).filter(Boolean).map((o) => ({ type: o['@type'], keys: Object.keys(o).slice(0, 30) }));
      } catch { return []; }
    }), 30);
  } catch {}
  for (const k of ['__NEXT_DATA__','__NUXT__','__APOLLO_STATE__','__INITIAL_STATE__','__PRELOADED_STATE__','__remixContext','__sveltekit_data']) {
    try { const v = window[k]; if (v) out.state[k] = (v && typeof v === 'object') ? Object.keys(v).slice(0, 20) : typeof v; } catch {}
  }
  try { const nd = document.getElementById('__NEXT_DATA__'); if (nd) { const p = JSON.parse(nd.textContent || 'null'); out.state['__NEXT_DATA__.props.pageProps'] = Object.keys((p && p.props && p.props.pageProps) || {}).slice(0, 30); } } catch {}
  try { out.state.jsonScripts = cap([...document.querySelectorAll('script[type="application/json"]')].map((s) => ({ id: s.id || undefined, len: (s.textContent || '').length })), 20); } catch {}
  try { for (const m of document.querySelectorAll('meta[property^="og:"],meta[name^="twitter:"],meta[property^="product:"],meta[itemprop]')) { const key = m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop'); const val = m.getAttribute('content'); if (key && val && out.meta[key] === undefined) out.meta[key] = String(val).slice(0, 300); } } catch {}
  try { out.feeds = cap([...document.querySelectorAll('link[rel="alternate"]')].filter((l) => /rss|atom|feed\\+json|json\\+oembed/i.test(l.getAttribute('type') || '')).map((l) => ({ type: l.getAttribute('type'), href: l.href, title: l.getAttribute('title') || undefined })), 20); } catch {}
  try { out.microdata = cap([...document.querySelectorAll('[itemscope][itemtype]')].map((e) => e.getAttribute('itemtype')).filter((v, i, a) => v && a.indexOf(v) === i), 20); } catch {}
  try { out.storage.localStorage = cap(Object.keys(localStorage || {}), 40); } catch {}
  try { out.storage.sessionStorage = cap(Object.keys(sessionStorage || {}), 40); } catch {}
  try {
    if (indexedDB && indexedDB.databases) {
      const dbs = await indexedDB.databases();
      const idb = [];
      for (const d of (dbs || []).slice(0, 8)) {
        let stores = [];
        try {
          const db = await new Promise((res, rej) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          stores = Array.from(db.objectStoreNames || []);
          db.close();
        } catch {}
        idb.push({ name: d.name, version: d.version, stores: stores.slice(0, 20) });
      }
      out.storage.indexedDB = idb;
    }
  } catch {}
  return out;
})()`;

cli({
  site: 'generic',
  name: 'find_structured_data',
  access: 'read',
  description:
    'Scan the page in one pass for **stable data sources** (far more stable than scraping DOM classes, and cheapest to synthesize): JSON-LD (schema.org), framework-embedded state (__NEXT_DATA__/__NUXT__/__APOLLO_STATE__/<script type=json> etc.), OG/Twitter meta, RSS/Atom/JSON Feed/oEmbed <link>s, Microdata, and **client-side storage: IndexedDB databases (including object-store names) and localStorage/sessionStorage keys** (SPA/chat apps often cache the full data here — e.g. DeepSeek keeps entire sessions in IndexedDB). Returns type + fields/store names + a small sample. On a hit, use eval_js to read deeper (e.g. read window.__NEXT_DATA__, or open the named IndexedDB store). Prefer these before considering DOM scraping.',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      help: 'Target tab (required outside an explore session, where it defaults to the explore tab)',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    let tabId: number;
    if (kwargs.tab_id !== undefined && kwargs.tab_id !== null && kwargs.tab_id !== '') {
      await assertTabId(kwargs.tab_id);
      tabId = Number(kwargs.tab_id);
    } else if (session) {
      tabId = session.tabId;
    } else {
      return { error: 'provide tab_id, or start an explore session first' };
    }
    const page = await createPageShim(tabId);
    try {
      const data = await page.evaluate(SWEEP);
      return {
        ...(data as Record<string, unknown>),
        hint: 'Priority: 1) endpoints (list_network/find_in_network) 2) embedded JSON / IndexedDB / localStorage (read with eval_js and JSON.parse — becomes the evaluate step of the synthesized pipeline) 3) feeds suit "latest N items" 4) if none, fall back to DOM scraping. If IndexedDB holds the full data (common in chat/editor SPAs), it is more complete and more stable than the DOM (unaffected by virtual lists).',
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      try {
        await page.detach(); // no-op: session owns the CDP attachment
      } catch {
        /* ignore */
      }
    }
  },
});
