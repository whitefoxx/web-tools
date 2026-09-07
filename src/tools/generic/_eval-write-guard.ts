/**
 * Static write guard shared by every `eval_js` registration (the full shell's
 * explore-time one in tools/explore/eval-js.ts and localmd Connect's
 * tab-addressed one in tools/generic/eval-js-localmd.ts).
 *
 * Why it exists (F-29): eval_js is a MAIN-world channel that carries the user's
 * login cookies. A snippet that does `fetch('/star',{method:'POST'})` causes a
 * REAL side effect that no write-confirm ever saw — the confirm contracts gate
 * `access:'write'` adapters and site scripts, and eval_js is `read`. So the
 * obvious write shapes are refused unless the caller passes `allow_write:true`,
 * which the calling app is expected to put in front of the user first.
 */

const WRITE_SIGNALS: Array<{ re: RegExp; what: string }> = [
  // fetch / axios / ky options object with a mutating method
  {
    re: /\bmethod\s*:\s*['"`]\s*(post|put|delete|patch)\s*['"`]/i,
    what: 'fetch/XHR method:POST/PUT/DELETE/PATCH',
  },
  // XMLHttpRequest.open('POST', …)
  {
    re: /\.open\s*\(\s*['"`]\s*(post|put|delete|patch)\s*['"`]/i,
    what: 'XMLHttpRequest.open(write method)',
  },
  // form submission (native model update — the actual side effect on GitHub/etc.)
  { re: /\.(requestSubmit|submit)\s*\(/, what: 'form.submit()/requestSubmit()' },
  // beacon is always a write
  { re: /\bsendBeacon\s*\(/, what: 'navigator.sendBeacon()' },
];

/**
 * High-precision static scan for an obvious network write in an eval_js snippet.
 * Returns the matched signal description, or null. Deliberately conservative:
 * only flags the concrete write shapes (a `method:'POST'` options object, an XHR
 * open with a write verb, a form submit, a beacon) — a bare string `"POST"`
 * (e.g. reading/printing `form.method`) does NOT match, so read-only exploration
 * isn't nagged. Can't catch dynamically-built methods (`'PO'+'ST'`) — that's the
 * accepted gap; prompt-level recon discipline covers the rest. Pure; unit-tested.
 */
export function detectWriteIntent(code: string): string | null {
  for (const s of WRITE_SIGNALS) if (s.re.test(code)) return s.what;
  return null;
}
