import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchLlmsTxt, looksLikeLlmsTxt, __resetLlmsTxtCache } from '../src/tools/generic/llms-txt';

function mockFetch(
  handler: (url: string) => { ok: boolean; status?: number; body?: string; contentType?: string },
) {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const r = handler(url);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 404),
      headers: {
        get: (k: string) =>
          k.toLowerCase() === 'content-type' ? (r.contentType ?? 'text/plain') : null,
      },
      async text() {
        return r.body ?? '';
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('looksLikeLlmsTxt', () => {
  it('accepts markdown/plain text, rejects HTML and empty', () => {
    expect(looksLikeLlmsTxt('# My Site\n- /docs: guide', 'text/plain')).toBe(true);
    expect(looksLikeLlmsTxt('   ', null)).toBe(false);
    expect(looksLikeLlmsTxt('<!DOCTYPE html><html>…', null)).toBe(false);
    expect(looksLikeLlmsTxt('plain but served as html', 'text/html; charset=utf-8')).toBe(false);
    expect(looksLikeLlmsTxt('<html><body>spa</body></html>', null)).toBe(false);
  });
});

describe('fetchLlmsTxt', () => {
  beforeEach(() => __resetLlmsTxtCache());
  afterEach(() => {
    __resetLlmsTxtCache();
    vi.restoreAllMocks();
  });

  it('fetches <origin>/llms.txt and returns its text', async () => {
    mockFetch((url) =>
      url === 'https://example.com/llms.txt'
        ? { ok: true, body: '# Example\n- /api: the API' }
        : { ok: false },
    );
    expect(await fetchLlmsTxt('https://example.com/some/page?q=1')).toBe(
      '# Example\n- /api: the API',
    );
  });

  it('returns null on 404 and caches it (no re-fetch)', async () => {
    const fn = vi.fn(
      (url: string) => ({ ok: false, status: 404 }) as ReturnType<Parameters<typeof mockFetch>[0]>,
    );
    mockFetch(fn);
    expect(await fetchLlmsTxt('https://nollms.com/')).toBeNull();
    expect(await fetchLlmsTxt('https://nollms.com/other')).toBeNull(); // same origin → cached
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      1,
    );
  });

  it('rejects an HTML SPA catch-all (200 but HTML)', async () => {
    mockFetch(() => ({
      ok: true,
      body: '<!doctype html><html><body>app</body></html>',
      contentType: 'text/html',
    }));
    expect(await fetchLlmsTxt('https://spa.app/')).toBeNull();
  });

  it('truncates long content', async () => {
    mockFetch(() => ({ ok: true, body: 'x'.repeat(5000) }));
    const r = await fetchLlmsTxt('https://big.com/');
    expect(r).not.toBeNull();
    expect(r!.length).toBeLessThan(1600);
    expect(r!.endsWith('[truncated]')).toBe(true);
  });

  it('returns null for non-http origins / invalid URLs without fetching', async () => {
    const fn = vi.fn(() => ({ ok: false }) as ReturnType<Parameters<typeof mockFetch>[0]>);
    mockFetch(fn);
    expect(await fetchLlmsTxt('about:blank')).toBeNull();
    expect(await fetchLlmsTxt('not a url')).toBeNull();
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      0,
    );
  });
});
