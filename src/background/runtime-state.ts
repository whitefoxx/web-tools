/**
 * Service-worker shared runtime state + low-level primitives — part of the
 * shared BASE (every shell's SW imports it for the keep-alive + `sendToSidepanel`
 * / `msgOf`).
 *
 * Everything here is LOST when the MV3 worker is recycled (~30s idle). Durable
 * state lives in IndexedDB (sessions, adapters, traces, schedules…); these
 * maps/sets are pure in-memory coordination that the boot path rebuilds or
 * recovers. Split out of service-worker.ts so every SW module shares the same
 * keep-alive and `sendToSidepanel` / `msgOf` helpers without a circular
 * dependency.
 *
 * The engine's `activeSessions` registry does NOT live here — it holds a
 * `SessionState` (a full-shell `agent/*` type), so it lives in the full-only
 * `active-sessions.ts` and reaches the keep-alive only through the probe below
 * (P4, docs/architecture.md §A).
 */

/* ───────── keep-alive (MV3 30s idle timer) ───────── */

/** Open keep-alive ports from extension pages (SidePanel). Originally we
 * relied SOLELY on an open port to pin the SW — but an IDLE connected port
 * does NOT reliably reset Chrome's 30s idle timer (observed: "keepalive port
 * connected" logged, yet the SW still got recycled mid-`bilibili__comment`,
 * which waits on a write-confirm + userScripts RPC with no chrome.* calls of
 * its own). The reliable mechanism is the active self-ping below; the port is
 * kept as a secondary signal + so the SW dies promptly when the panel closes. */
export const keepaliveConnections = new Set<chrome.runtime.Port>();

/** Active self-ping: while ANY session is being driven, fire a cheap chrome.*
 * call every 20s (< the 30s idle timeout) so the worker is never recycled
 * mid-turn. setInterval only ticks while the SW is alive, and each tick's
 * chrome.* call resets the idle timer — so an active session keeps the SW
 * alive indefinitely, and it's released the moment the last session ends.
 * This is what actually fixes the "session interrupted because the extension
 * background was recycled" interruptions; the open port alone did not. */
let keepalivePingTimer: ReturnType<typeof setInterval> | null = null;
const KEEPALIVE_PING_MS = 20_000;

export function startKeepalivePing(): void {
  if (keepalivePingTimer) return;
  keepalivePingTimer = setInterval(() => {
    // Any async extension API call counts as activity and resets the 30s
    // idle timer. getPlatformInfo is cheap and side-effect-free.
    try {
      chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    } catch {
      /* SW tearing down; nothing to do */
    }
  }, KEEPALIVE_PING_MS);
}

/** In-flight bridge tool calls (F-8). Bridge calls don't populate activeSessions,
 * and the WS heartbeat alone doesn't reset the 30s idle timer (§10.19) — so while
 * any external call runs we keep the active ping going too. */
let bridgeBusyCount = 0;

/** Whether any engine session is currently being driven. The full SW wires this
 * to `() => activeSessions.size > 0` at boot (setActiveSessionProbe); the lean
 * shells never wire it, so it stays false and the keep-alive tracks only bridge
 * calls. Kept as a probe — not an import of the full-only `activeSessions` map —
 * so the base keep-alive has no compile-time edge into `agent/*`. */
let hasActiveSession: () => boolean = () => false;
export function setActiveSessionProbe(fn: () => boolean): void {
  hasActiveSession = fn;
}

export function stopKeepalivePingIfIdle(): void {
  if (keepalivePingTimer && !hasActiveSession() && bridgeBusyCount === 0) {
    clearInterval(keepalivePingTimer);
    keepalivePingTimer = null;
  }
}

/** Bridge busy/idle hooks (wired into bridge-client from the SW entry). A bridge
 * call in flight keeps the worker pinned even with no active chat session. */
export function onBridgeBusy(): void {
  bridgeBusyCount++;
  startKeepalivePing();
}
export function onBridgeIdle(): void {
  bridgeBusyCount = Math.max(0, bridgeBusyCount - 1);
  stopKeepalivePingIfIdle();
}

/* ───────── messaging primitives ───────── */

/** Forward a tagged message to every extension page. Generic over any
 * `{ type }`-tagged message rather than importing the full `Message` union
 * (messages.ts): this function only forwards, and the union's full-only arms
 * (plan / memory / notes / schedule / adapter-health) import `agent/*` +
 * `schedules/*`. Taking the structural minimum is the last edge that kept
 * messages.ts — and with it those subsystems — out of the shared base
 * (P4, docs/architecture.md §A). Full-shell callers still pass real `Message`
 * values; `M` infers their exact shape, so no call site loses type checking. */
export function sendToSidepanel<M extends { type: string }>(m: M): void {
  // chrome.runtime.sendMessage from SW delivers to all extension pages
  // (sidepanel, popup), but NOT back to SW itself. SidePanel filters by type.
  void chrome.runtime.sendMessage(m).catch(() => {
    // No listener (e.g. sidepanel closed). Not fatal.
  });
}

export function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
