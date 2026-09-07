/**
 * The last few answers, so running the same prompt on the same passage twice
 * costs nothing.
 *
 * The key is the FILLED prompt — template, passage and output language already
 * combined (`fillPromptTemplate`). That is exactly the input the model saw, so
 * it separates one saved prompt from another for free, and any change to the
 * wording, the passage or the language misses the cache without anyone having
 * to remember to include it in a key.
 *
 * Ten entries, oldest out first. Small on purpose: this is for the "wait, what
 * did that say" of the last few minutes, not a history — a knowledge base is
 * where an answer goes when it is worth keeping, and that is a clip, not a
 * cache.
 */

export const PROMPT_CACHE_KEY = 'localmdPromptCache';
export const PROMPT_CACHE_MAX = 10;

/** What one remembered answer carries. `label` and `ts` are for debugging and
 *  for anything that later wants to show the list; the lookup uses `key`. */
export interface CachedAnswer {
  key: string;
  result: string;
  ts: number;
  label?: string;
}

/**
 * A short, stable digest of a prompt.
 *
 * Hashed rather than stored whole because a filled prompt carries the passage —
 * up to a few thousand characters, ten times over, for a key nobody reads.
 * cyrb53: two accumulators, so a one-character change moves it, and the length
 * is folded in as a cheap second dimension.
 */
export function promptKey(prompt: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < prompt.length; i++) {
    const ch = prompt.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${n.toString(36)}.${prompt.length.toString(36)}`;
}

/** Anything unrecognisable in storage reads as an empty cache, never as a
 *  crash: this sits in front of every quick answer. */
export function readCache(raw: unknown): CachedAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (r): r is CachedAnswer => !!r && typeof r.key === 'string' && typeof r.result === 'string',
    )
    .map((r) => ({
      key: r.key,
      result: r.result,
      ts: typeof r.ts === 'number' ? r.ts : 0,
      ...(typeof r.label === 'string' ? { label: r.label } : {}),
    }))
    .slice(0, PROMPT_CACHE_MAX);
}

export function lookup(rows: CachedAnswer[], key: string): string | null {
  return rows.find((r) => r.key === key)?.result ?? null;
}

/** Newest first, one entry per key, ten at most. Re-answering something already
 *  cached moves it to the front rather than adding a second copy. */
export function remember(rows: CachedAnswer[], entry: CachedAnswer): CachedAnswer[] {
  return [entry, ...rows.filter((r) => r.key !== entry.key)].slice(0, PROMPT_CACHE_MAX);
}

/* ── the storage half ─────────────────────────────────────────────────────── */

export async function cachedAnswer(key: string): Promise<string | null> {
  try {
    const got = await chrome.storage.local.get(PROMPT_CACHE_KEY);
    return lookup(readCache(got?.[PROMPT_CACHE_KEY]), key);
  } catch {
    return null; // a cache that cannot be read is a cache miss, never an error
  }
}

export async function rememberAnswer(key: string, result: string, label?: string): Promise<void> {
  try {
    const got = await chrome.storage.local.get(PROMPT_CACHE_KEY);
    const next = remember(readCache(got?.[PROMPT_CACHE_KEY]), {
      key,
      result,
      ts: Date.now(),
      ...(label ? { label } : {}),
    });
    await chrome.storage.local.set({ [PROMPT_CACHE_KEY]: next });
  } catch {
    /* not being able to remember an answer must not fail the answer */
  }
}
