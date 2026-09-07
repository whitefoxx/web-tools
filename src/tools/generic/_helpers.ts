/**
 * Shared utilities for site-independent ("generic") adapters. Each generic
 * adapter opens its own tab on demand instead of relying on a pre-bound
 * site tab (xiaohongshu adapters use `page` for that). These helpers
 * keep that boilerplate in one place.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve when `tabId`'s status flips to 'complete', or reject after
 * `timeoutMs`. Tolerates the tab being already-complete at call time. */
export function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let resolved = false;
    const done = (ok: boolean): void => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (ok) resolve();
      else reject(new Error(`tab-load timeout after ${timeoutMs}ms`));
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === 'complete') done(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') done(true);
      })
      .catch(() => {});
  });
}

export function assertHttpUrl(url: unknown, paramName = 'url'): string {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`${paramName} must start with http:// or https://`);
  }
  return s;
}

/** Validate that `tab_id` references a tab that still exists, returning the
 * chrome.tabs.Tab. Throws with a model-readable error otherwise. */
export async function assertTabId(tabId: unknown, paramName = 'tab_id'): Promise<chrome.tabs.Tab> {
  const n = Number(tabId);
  if (!Number.isFinite(n) || Math.trunc(n) !== n || n < 0) {
    throw new Error(`${paramName} must be a positive integer (the tabId returned by open_url)`);
  }
  try {
    return await chrome.tabs.get(n);
  } catch {
    throw new Error(`tab ${n} no longer exists (closed?)`);
  }
}

/**
 * iframe-scoped element refs. `get_interactives` scans every frame (allFrames)
 * and namespaces refs from a sub-frame as `f<frameId><localRef>` (e.g. `f5r3`);
 * a plain `r3` is the top frame (frameId 0). The action tools (click /
 * type_into) parse the prefix to inject into that specific frame — otherwise an
 * element inside an iframe is both invisible to perception AND unreachable to
 * action (a whole Tier-A blind spot). Pure; unit-tested.
 */
export function frameRef(frameId: number, localRef: string): string {
  return frameId ? `f${frameId}${localRef}` : localRef;
}

/** Split a (possibly frame-scoped) ref into its frameId + local ref. A plain ref
 * → { frameId: 0, localRef: ref }. Only `f<digits>r<base36>` is treated as
 * frame-scoped, so a real top-frame ref (`r3`) or a raw value never false-matches. */
export function parseFrameRef(ref: string): { frameId: number; localRef: string } {
  const m = /^f(\d+)(r[0-9a-z]+)$/.exec(ref);
  return m ? { frameId: Number(m[1]), localRef: m[2] } : { frameId: 0, localRef: ref };
}

export interface PageReadyOpts {
  /** Hard cap on total wait time (ms). Default 15000. */
  maxWaitMs?: number;
  /** Wait until document.body.innerText length stays unchanged for this
   * many ms; signals the page has stopped streaming content. Default 800. */
  quietMs?: number;
  /** If set, treat the page as "ready" the moment this CSS selector
   * matches (short-circuits the stability check). Useful for SPAs that
   * never quite stop mutating but DO render a known element when ready. */
  waitForSelector?: string;
  /** Poll interval (ms). Default 200. */
  pollMs?: number;
}

/** Smarter page-load wait than "navigate then setTimeout".
 *
 * Strategy:
 *   1. Tab status `complete` is already guaranteed by `waitForTabComplete`
 *      before we get here — but `complete` only means the `load` event
 *      fired, not that the SPA has hydrated. So we poll in-page.
 *   2. If `waitForSelector` is given and matches → ready.
 *   3. Otherwise, watch `document.body.innerText.length`. Once it stops
 *      changing for `quietMs`, ready.
 *   4. Cap at `maxWaitMs`; resolve anyway on timeout (best-effort —
 *      caller still gets to use the tab).
 *
 * Returns the final probe so callers can include timing diagnostics. */
export interface PageReadyResult {
  reason: 'selector' | 'stable' | 'timeout';
  elapsedMs: number;
  textLen: number;
  readyState: DocumentReadyState | 'unknown';
}

export async function waitForPageReady(
  tabId: number,
  opts: PageReadyOpts = {},
): Promise<PageReadyResult> {
  const maxWaitMs = Math.max(1000, opts.maxWaitMs ?? 15_000);
  const quietMs = Math.max(100, opts.quietMs ?? 800);
  const pollMs = Math.max(50, opts.pollMs ?? 200);
  const t0 = Date.now();
  const selector = opts.waitForSelector || null;

  let lastLen = -1;
  let lastChangeAt = Date.now();
  let lastReadyState: DocumentReadyState | 'unknown' = 'unknown';

  while (Date.now() - t0 < maxWaitMs) {
    let probe:
      | { readyState: DocumentReadyState; textLen: number; selectorMatched: boolean }
      | undefined;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string | null) => ({
          readyState: document.readyState,
          textLen: (document.body?.innerText ?? '').length,
          selectorMatched: !!(sel && document.querySelector(sel)),
        }),
        args: [selector],
      });
      probe = res[0]?.result;
    } catch {
      // The page may not be reachable yet (e.g., DNS still resolving),
      // or the host is on a restricted scheme (chrome://, file://, etc.).
      // Keep polling — `maxWaitMs` will cap us either way.
      await sleep(pollMs);
      continue;
    }

    if (!probe) {
      await sleep(pollMs);
      continue;
    }
    lastReadyState = probe.readyState;

    if (selector && probe.selectorMatched) {
      return {
        reason: 'selector',
        elapsedMs: Date.now() - t0,
        textLen: probe.textLen,
        readyState: probe.readyState,
      };
    }

    if (probe.readyState === 'complete') {
      if (probe.textLen !== lastLen) {
        lastLen = probe.textLen;
        lastChangeAt = Date.now();
      } else if (probe.textLen > 0 && Date.now() - lastChangeAt >= quietMs) {
        return {
          reason: 'stable',
          elapsedMs: Date.now() - t0,
          textLen: probe.textLen,
          readyState: probe.readyState,
        };
      }
    }

    await sleep(pollMs);
  }

  return {
    reason: 'timeout',
    elapsedMs: Date.now() - t0,
    textLen: lastLen >= 0 ? lastLen : 0,
    readyState: lastReadyState,
  };
}
