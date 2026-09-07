/**
 * Marketplace client — fetch the adapter catalog (index + sha256-verified
 * per-adapter source). Lives in core/ because it is pure fetch +
 * chrome.storage + crypto.subtle with no shell dependency: the full shell's
 * SidePanel browses with it, and the headless shells (localmd Connect) load
 * adapters through it.
 *
 * The adapters live in a SEPARATE PUBLIC REPO (whitefoxx/web-agent-marketplace),
 * served via GitHub raw (`MARKETPLACE_BASE_URL`), so the extension bundle stays
 * small and adapters update without an extension release. (That repo is also a
 * git submodule at `marketplace/` here, for dev/tests/versioning — but the
 * runtime always fetches remote, never the local checkout.)
 *
 * Two-stage fetch (schema v2 — see docs/adapter-hot-plug.md):
 *   1. `fetchMarketIndex()` — pulls `index.json` (metadata only, no embedded
 *      source). Last-good index is cached in chrome.storage.local so browsing
 *      degrades gracefully offline.
 *   2. `fetchAdapterSource(adapter)` — only on Install. Fetches the per-adapter
 *      `.js` and verifies sha256 before returning. Hash mismatch → refuse
 *      install (defends against a tampered/raced remote file).
 */

/** Schema-v2 entry shape (matches scripts/build-marketplace-index.mjs output). */
export interface MarketAdapter {
  site: string;
  name: string;
  description: string;
  access?: 'read' | 'write';
  domain?: string;
  type: 'pipeline' | 'func' | 'unknown';
  /** Trust tier. Today every entry from the built-in tree is 'official';
   * 'community' lands when the remote marketplace + review pipeline ship. */
  tier: 'official' | 'community';
  /** Free-text. For opencli-sourced built-ins this is 'opencli'; community
   * adapters surface the submitting GitHub handle here. */
  author: string;
  /** Per-adapter semver. Bumped manually when the adapter's behaviour
   * changes; for upgrade detection prefer comparing sha256. */
  version: string;
  /** Relative path under the marketplace base URL — e.g. "zhihu/answer-detail.js".
   * Resolved via `new URL(adapter.source, baseUrl)` at fetch time. */
  source: string;
  /** SHA-256 (hex) of the EXACT source bytes the index promised. Verified by
   * fetchAdapterSource before handing off to install. */
  sha256: string;
}

export interface MarketIndex {
  /** Schema version. v1 inlined source per adapter; v2 (current) uses
   * per-file sources + sha256 + tier/author/version. Clients should refuse
   * to load unknown versions (rather than parsing and silently dropping
   * fields). */
  version: 2;
  bundledAt: string;
  generatedFrom: string;
  includeAll: boolean;
  count: number;
  adapters: MarketAdapter[];
}

// Index caching (2026-07-09): the catalog is REMOTE now (GitHub raw), so a
// network round-trip on every marketplace open / palette build was slow. `fetchMarketIndex`
// is now **cache-first with a TTL** (stale-while-revalidate): a fresh cache
// returns instantly with no network; a stale one returns instantly too but kicks
// off a background refresh so the next open is current. Periodic refresh is enough.
//
// §10.15 safety: a stale index carries stale sha256s, and the LOAD path
// (loadEphemeralAdapter → fetchAdapterSource) verifies a FRESHLY-fetched source
// against the index's sha256 — a stale-index + fresh-source pair would mismatch
// and refuse the load. So every path that then fetches+verifies source passes
// `{ forceFresh: true }` (load / restore / reconcile); only pure browse/search/
// palette use the cache. (Install — the original §10.15 victim — is gone.)
// fetchAdapterSource still uses `cache: 'no-store'` for the source body.

/** How long a cached index is served without a network refresh. Adapters are
 * hand-maintained + change infrequently, so a few hours is plenty; a stale hit
 * still triggers a background refresh. */
const INDEX_TTL_MS = 6 * 60 * 60 * 1000;

interface CachedIndex {
  index: MarketIndex;
  ts: number;
}

/** Read the cached index (new `{index,ts}` shape; tolerate the legacy raw-index
 * shape by treating it as maximally stale so it refreshes on next use). */
async function readCachedIndex(): Promise<CachedIndex | null> {
  try {
    const got = await chrome.storage?.local.get(INDEX_CACHE_KEY);
    const c = got?.[INDEX_CACHE_KEY] as unknown;
    if (c && typeof c === 'object') {
      const withTs = c as Partial<CachedIndex>;
      if (withTs.index && Array.isArray(withTs.index.adapters)) {
        return { index: withTs.index, ts: typeof withTs.ts === 'number' ? withTs.ts : 0 };
      }
      const raw = c as MarketIndex; // legacy: raw MarketIndex stored directly
      if (Array.isArray(raw.adapters)) return { index: raw, ts: 0 };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Network fetch + validate + cache (with timestamp). */
async function fetchFreshIndex(base: string): Promise<MarketIndex> {
  const url = new URL('index.json', base).toString();
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`market index fetch failed: ${resp.status} ${resp.statusText}`);
  const data = validateIndex((await resp.json()) as MarketIndex);
  try {
    await chrome.storage?.local.set({
      [INDEX_CACHE_KEY]: { index: data, ts: Date.now() } satisfies CachedIndex,
    });
  } catch {
    /* ignore */
  }
  return data;
}

/** Stable id used both as the IDB primary key (site/name) and as the
 * `bundled:<id>` origin URL recorded with the install. */
export function entryId(a: { site: string; name: string }): string {
  return `${a.site}/${a.name}`;
}

/** Remote marketplace base URL (the adapters live in a separate public repo,
 * served via GitHub raw — keeps the extension bundle small + lets adapters
 * update without an extension release). Overridable via the `remoteMarketUrl`
 * setting in chrome.storage.local for forks/testing. Trailing slash required so
 * `new URL('zhihu/x.js', base)` resolves under the repo root. */
export const MARKETPLACE_BASE_URL =
  'https://raw.githubusercontent.com/whitefoxx/web-agent-marketplace/main/';

/** storage.local key for the cached index. Exported so other SidePanel views
 * (App's `/` palette catalog) can sync off its `storage.onChanged` — a
 * force-refresh in one view then propagates to every composer's palette. */
export const INDEX_CACHE_KEY = 'marketIndexCache';

export async function resolveBaseUrl(): Promise<string> {
  try {
    const got = await chrome.storage?.local.get('remoteMarketUrl');
    const u = got?.remoteMarketUrl;
    if (typeof u === 'string' && u) return u.endsWith('/') ? u : `${u}/`;
  } catch {
    /* ignore */
  }
  return MARKETPLACE_BASE_URL;
}

function validateIndex(data: MarketIndex): MarketIndex {
  if (!data || !Array.isArray(data.adapters)) {
    throw new Error('market index malformed: missing adapters array');
  }
  if (data.version !== 2) {
    throw new Error(
      `market index schema mismatch: expected v2, got v${(data as { version?: unknown }).version}.`,
    );
  }
  return data;
}

/**
 * Fetch the marketplace index. Cache-first (stale-while-revalidate) by default —
 * a warm cache returns instantly; a stale cache returns instantly AND refreshes
 * in the background. Pass `{ forceFresh: true }` when the result feeds a
 * sha256-verified source fetch (load / restore / reconcile) — see the §10.15 note
 * above. On network failure, falls back to any cached index.
 */
export async function fetchMarketIndex(opts?: { forceFresh?: boolean }): Promise<MarketIndex> {
  const base = await resolveBaseUrl();
  if (opts?.forceFresh) {
    try {
      return await fetchFreshIndex(base);
    } catch (e) {
      const cached = await readCachedIndex();
      if (cached) return cached.index; // better a stale list than nothing
      throw e;
    }
  }
  const cached = await readCachedIndex();
  if (cached) {
    // Stale → refresh in the background so the NEXT open is current, but return
    // the cached copy now (instant open).
    if (Date.now() - cached.ts >= INDEX_TTL_MS) void fetchFreshIndex(base).catch(() => {});
    return cached.index;
  }
  // Cold cache: block on the network, then it's warm forever after.
  return fetchFreshIndex(base);
}

/** SHA-256 hex of a UTF-8 string. Pure (no I/O) so it's straight-line testable. */
export async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Fetch the actual adapter source for an entry and verify it matches the
 * index's promised sha256. Throws on fetch failure OR mismatch — install
 * code should propagate the error (don't fall back to the bytes; a hash
 * mismatch is either a CDN race, a stale cache, or active tampering, none
 * of which the user wants silently installed).
 */
export async function fetchAdapterSource(
  adapter: MarketAdapter,
  baseUrl?: string,
): Promise<string> {
  const base = baseUrl ?? (await resolveBaseUrl());
  const url = new URL(adapter.source, base).toString();
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`adapter source fetch failed: ${resp.status} ${resp.statusText} (${url})`);
  }
  const text = await resp.text();
  // NB (audit Tier3-#18): this sha256 is an index↔body CONSISTENCY check (the
  // body matches what index.json vouches for), NOT origin authenticity — both are
  // fetched from the same base, so a hostile base could serve a matching pair.
  // Accepted: the market base URL has no in-`src` writer (dev/fork-only), so no
  // in-product override vector; true authenticity would need a signed index /
  // pinned publisher key (out of scope).
  const got = await sha256Hex(text);
  if (got !== adapter.sha256) {
    throw new Error(
      `adapter source sha256 mismatch for ${entryId(adapter)}: index says ${adapter.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`,
    );
  }
  return text;
}

/**
 * Handpicked set surfaced in a "Featured" row at the top of the market browser.
 * Mix of pipeline (install-and-go, zero-config) and func (needs Phase B + Chrome 138+
 * Allow user scripts) so users see both categories from the get-go. Order matters:
 * shown left-to-right top-to-bottom; pipelines first for the smoothest first
 * impression.
 */
export const FEATURED_IDS: readonly string[] = [
  // pipeline — install-and-go
  'hackernews/top',
  'bilibili/hot',
  'binance/price',
  'zhihu/hot',
  // func — needs Phase B (Chrome 138+ + Allow user scripts toggle)
  'xiaohongshu/search',
  'twitter/timeline',
  'youtube/search',
  'weread/notes',
];
