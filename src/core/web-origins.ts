/**
 * User-configurable web-app origins — who may talk to WebCLI from a web page.
 *
 * Why this exists (docs/webcli.md §15): the old path hardcoded localmd.app in
 * `externally_connectable.matches`, and that field is a dead end for user
 * configuration — it is read once at install time (no runtime API touches it),
 * and Chrome refuses wildcard-TLD patterns in it, so "let the user add a site"
 * cannot be expressed there at all. The replacement:
 *
 *   popup writes the origin list here (`chrome.storage.local.webOrigins`)
 *     → the SW registers a tiny relay content script on each origin
 *       (`chrome.scripting.registerContentScripts`, which DOES take runtime
 *       patterns, under the <all_urls> host permission we already hold)
 *     → the page speaks `window.postMessage` to the relay (src/webcli/web-relay.ts)
 *     → the relay forwards over an internal Port to the same MCP handler.
 *
 * Two-layer gate, on purpose: match patterns cannot carry a port (invalid in
 * the scripting API — only `externally_connectable` ever allowed them), so the
 * INJECTION is scoped per host (`https://host/*`) and the SERVICE check in the
 * MCP handler compares the exact origin, port included. A page on the right
 * host but the wrong port gets a relay that connects to a wall.
 *
 * Empty list = nobody. There is deliberately no seed entry — localmd.app lost
 * its special status when this shipped; a user who wants it adds it like any
 * other site.
 */

export const WEB_ORIGINS_KEY = 'webOrigins';

/** The Port name the relay connects with; the SW routes it to the MCP handler. */
export const RELAY_PORT_NAME = 'webcli-web-mcp';

const RELAY_SCRIPT_PREFIX = 'webcli-relay-';

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Parse what a user typed into an exact origin + the injection match pattern.
 * Forgiving on input (scheme optional, paths ignored), strict on output — and
 * every rejection names the rule, because this string is typed by a human into
 * a 320px popup with no docs in sight.
 */
export function normalizeOriginInput(raw: string): { origin: string; pattern: string } {
  const s = (raw ?? '').trim();
  if (!s) throw new Error('enter a site, e.g. localmd.app or localhost:5173');
  if (s.includes('*')) throw new Error('wildcards are not supported — add each site separately');
  // No scheme → assume https, except bare loopback hosts, which are http in practice.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
    ? s
    : (isLoopbackHost(s.split(/[/:]/)[0]) ? 'http://' : 'https://') + s;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error('not a valid address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('only http(s) sites can connect');
  }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    throw new Error('plain http is only allowed for localhost');
  }
  if (u.username || u.password) throw new Error('not a valid address');
  return { origin: u.origin, pattern: `${u.protocol}//${u.hostname}/*` };
}

/** Stable registration id for one injection pattern (host-level, see header). */
export function relayScriptIdFor(pattern: string): string {
  return RELAY_SCRIPT_PREFIX + pattern.replace(/[^a-z0-9.-]+/gi, '_');
}

export function isRelayScriptId(id: string): boolean {
  return id.startsWith(RELAY_SCRIPT_PREFIX);
}

/** Storage can hold anything an old build or a hand edit left there; keep only
 * exact, well-formed origins and drop duplicates — never throw. */
export function sanitizeStoredOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    try {
      const u = new URL(v);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v) out.add(v);
    } catch {
      /* not an origin — drop */
    }
  }
  return [...out];
}

export async function loadWebOrigins(): Promise<string[]> {
  try {
    const got = await chrome.storage.local.get([WEB_ORIGINS_KEY]);
    return sanitizeStoredOrigins(got[WEB_ORIGINS_KEY]);
  } catch {
    return [];
  }
}
