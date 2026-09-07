/**
 * The last ten answers (docs/localmd-connect.md §14.4p). The key is the FILLED
 * prompt, which already carries the template, the passage and the output
 * language — so one saved prompt is separated from another for free, and any
 * change to any of them misses without anyone having to remember why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PROMPT_CACHE_MAX,
  cachedAnswer,
  lookup,
  promptKey,
  readCache,
  remember,
  rememberAnswer,
} from '../src/localmd-connect/prompt-cache';

describe('promptKey', () => {
  it('is stable, and moves on any change worth missing the cache for', () => {
    const a = 'Translate the following into 简体中文: """hello"""';
    expect(promptKey(a)).toBe(promptKey(a));
    // A different passage, a different language, a different template.
    expect(promptKey(a)).not.toBe(promptKey(a.replace('hello', 'hellp')));
    expect(promptKey(a)).not.toBe(promptKey(a.replace('简体中文', '日本語')));
    expect(promptKey(a)).not.toBe(promptKey(a.replace('Translate', 'Explain')));
  });

  it('is short whatever it hashes — a key nobody reads should not carry a page', () => {
    expect(promptKey('z'.repeat(20_000)).length).toBeLessThan(24);
  });
});

describe('the ring', () => {
  const row = (k: string) => ({ key: k, result: `r:${k}`, ts: 1 });

  it('keeps the newest ten, oldest out first', () => {
    let rows = readCache(null);
    for (let i = 0; i < PROMPT_CACHE_MAX + 4; i++) rows = remember(rows, row(`k${i}`));
    expect(rows).toHaveLength(PROMPT_CACHE_MAX);
    expect(rows[0].key).toBe(`k${PROMPT_CACHE_MAX + 3}`);
    expect(lookup(rows, 'k0')).toBeNull(); // fell off the end
    expect(lookup(rows, `k${PROMPT_CACHE_MAX + 3}`)).toBe(`r:k${PROMPT_CACHE_MAX + 3}`);
  });

  it('re-answering moves an entry rather than duplicating it', () => {
    let rows = remember(remember([], row('a')), row('b'));
    rows = remember(rows, { key: 'a', result: 'newer', ts: 2 });
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
    expect(lookup(rows, 'a')).toBe('newer');
  });

  it('reads anything out of storage without throwing — a bad cache is a miss', () => {
    expect(readCache(undefined)).toEqual([]);
    expect(readCache('nonsense')).toEqual([]);
    expect(readCache([null, { key: 1 }, { key: 'a' }, { key: 'b', result: 'x' }])).toEqual([
      { key: 'b', result: 'x', ts: 0 },
    ]);
  });
});

describe('over chrome.storage', () => {
  const store: Record<string, unknown> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (k: string) => ({ [k]: store[k] }),
          set: async (o: Record<string, unknown>) => Object.assign(store, o),
        },
      },
    });
  });

  it('remembers an answer and hands it back for the same prompt', async () => {
    const key = promptKey('Explain this: """x"""');
    expect(await cachedAnswer(key)).toBeNull();
    await rememberAnswer(key, 'because', 'Explain');
    expect(await cachedAnswer(key)).toBe('because');
    expect(await cachedAnswer(promptKey('Explain this: """y"""'))).toBeNull();
  });

  it('a storage that throws is a cache miss, not a failed answer', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async () => {
            throw new Error('no storage');
          },
          set: async () => {
            throw new Error('no storage');
          },
        },
      },
    });
    expect(await cachedAnswer('k')).toBeNull();
    await expect(rememberAnswer('k', 'v')).resolves.toBeUndefined();
  });
});
