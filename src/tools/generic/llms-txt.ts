/**
 * Zero-config site hints (page-agent borrow ⑥): fetch a site's `/llms.txt` — the
 * emerging convention for an LLM-oriented site guide (like robots.txt, but for
 * agents) — and hand it to the model as context when it opens a URL on a site we
 * have no adapter for. Ported from page-agent (packages/core/src/utils
 * `fetchLlmsTxt`), with a robustness guard it lacks.
 *
 * Cached per origin for the SW lifetime (`null` = tried and absent / not a real
 * llms.txt); re-fetched after an SW restart, which is fine. The fetch runs in the
 * SW → CORS-free via host_permissions <all_urls>.
 */

const cache = new Map<string, string | null>();
const MAX_CHARS = 1500;
const TIMEOUT_MS = 2500;

/** Test-only: clear the per-origin cache between cases. */
export function __resetLlmsTxtCache(): void {
  cache.clear();
}

/** Fetch `<origin>/llms.txt` for `url`'s origin (cached). Returns the (truncated)
 * text, or null when absent / unreachable / not real llms.txt. Never throws. */
export async function fetchLlmsTxt(url: string): Promise<string | null> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null; // invalid URL
  }
  if (origin === 'null') return null; // about:blank / data: / file:
  if (cache.has(origin)) return cache.get(origin)!;

  let result: string | null = null;
  try {
    const res = await fetch(`${origin}/llms.txt`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) {
      const text = await res.text();
      if (looksLikeLlmsTxt(text, res.headers.get('content-type'))) {
        result = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…[truncated]` : text;
      }
    }
  } catch {
    /* timeout / network / abort → treat as absent */
  }
  cache.set(origin, result);
  return result;
}

/** llms.txt is markdown / plain text. Reject the common false positive: a SPA that
 * serves its index.html (HTTP 200) for any unknown path, including /llms.txt. */
export function looksLikeLlmsTxt(text: string, contentType: string | null): boolean {
  if (!text.trim()) return false;
  if (contentType && contentType.toLowerCase().includes('text/html')) return false;
  if (/^\s*<(?:!doctype html|html|head|body)\b/i.test(text)) return false;
  return true;
}
