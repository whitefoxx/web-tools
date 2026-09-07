/**
 * Tagged logger with config-driven enable/disable and a central ring buffer.
 *
 * Each context (service worker, sidepanel, content script) maintains its own
 * local buffer for last-N entries; non-SW contexts also fire-and-forget a
 * `LOG_ENTRY` message so the SW can aggregate everything into one timeline for
 * the sidepanel's log viewer.
 *
 * Filter Chrome DevTools by `web` to see only our logs, or by
 * `web:api` / `web:page` / `web:dispatcher` etc. to narrow scope.
 */

const PREFIX = '%c[web:%s]%c';
const TAG_STYLE = 'color: #0ea5e9; font-weight: 600';
const RESET_STYLE = '';
const BUFFER_MAX = 500;
const CONFIG_KEY = 'web:logConfig';

export type LogLevel = 'log' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

export interface LogConfig {
  enabled: boolean;
  /** Optional namespace whitelist. Empty/undefined = all namespaces. */
  namespaces?: string[];
}

const DEFAULT_CONFIG: LogConfig = { enabled: true };

let config: LogConfig = { ...DEFAULT_CONFIG };
const localBuffer: LogEntry[] = [];
const subscribers = new Set<(e: LogEntry) => void>();

function safeChrome(): typeof chrome | null {
  try {
    return typeof chrome !== 'undefined' ? chrome : null;
  } catch {
    return null;
  }
}

(function initFromStorage() {
  const c = safeChrome();
  if (!c?.storage?.local) return;
  c.storage.local
    .get(CONFIG_KEY)
    .then((r) => {
      const v = r?.[CONFIG_KEY] as LogConfig | undefined;
      if (v && typeof v.enabled === 'boolean') config = { ...DEFAULT_CONFIG, ...v };
    })
    .catch(() => {});
  try {
    c.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const change = changes[CONFIG_KEY];
      if (!change) return;
      const v = change.newValue as LogConfig | undefined;
      config =
        v && typeof v.enabled === 'boolean' ? { ...DEFAULT_CONFIG, ...v } : { ...DEFAULT_CONFIG };
    });
  } catch {}
})();

function shouldLog(scope: string): boolean {
  if (!config.enabled) return false;
  if (config.namespaces && config.namespaces.length > 0) {
    return config.namespaces.includes(scope);
  }
  return true;
}

function pushLocal(entry: LogEntry): void {
  localBuffer.push(entry);
  if (localBuffer.length > BUFFER_MAX) {
    localBuffer.splice(0, localBuffer.length - BUFFER_MAX);
  }
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {}
  }
}

function broadcast(entry: LogEntry): void {
  // Best-effort fan-out to the service worker so it can aggregate. Note:
  // `chrome.runtime.sendMessage` from inside the SW does NOT deliver to the
  // SW itself, so this is a no-op from SW context (no infinite loop risk).
  const c = safeChrome();
  if (!c?.runtime?.sendMessage) return;
  try {
    const p = c.runtime.sendMessage({ type: 'LOG_ENTRY', entry });
    if (p && typeof (p as Promise<unknown>).catch === 'function') {
      (p as Promise<unknown>).catch(() => {});
    }
  } catch {}
}

function emit(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (!shouldLog(scope)) return;
  const args: unknown[] = [PREFIX, TAG_STYLE, scope, RESET_STYLE, message];
  if (data !== undefined) args.push(data);
  // Print handled errors via console.warn: everything routed through this
  // module is caught-and-classified (retries / fallbacks / user notices), but
  // console.error feeds chrome://extensions' "Errors" page, which reads as
  // "the extension is broken" to users (real-machine feedback 2026-07-07).
  // The LogEntry keeps level 'error' so the in-app log view still classifies.
  // Genuinely unexpected crashes (e.g. the panel ErrorBoundary) still use
  // console.error directly and DO surface there.
  console[level === 'error' ? 'warn' : level](...args);
  const entry: LogEntry = { ts: Date.now(), level, scope, message, data };
  pushLocal(entry);
  broadcast(entry);
}

export function log(scope: string, message: string, data?: unknown): void {
  emit('log', scope, message, data);
}

export function warn(scope: string, message: string, data?: unknown): void {
  emit('warn', scope, message, data);
}

export function error(scope: string, message: string, data?: unknown): void {
  emit('error', scope, message, data);
}

export function group(scope: string, label: string, fn: () => void): void {
  if (!shouldLog(scope)) {
    fn();
    return;
  }
  console.groupCollapsed(`[web:${scope}] ${label}`);
  try {
    fn();
  } finally {
    console.groupEnd();
  }
}

/** Add a foreign entry (e.g. forwarded from another context) to this buffer. */
export function ingestEntry(entry: LogEntry): void {
  pushLocal(entry);
}

export function getLocalBuffer(): LogEntry[] {
  return localBuffer.slice();
}

export function clearBuffer(): void {
  localBuffer.length = 0;
}

export function getLogConfig(): LogConfig {
  return { ...config };
}

export async function setLogConfig(next: Partial<LogConfig>): Promise<void> {
  const merged: LogConfig = { ...config, ...next };
  config = merged;
  const c = safeChrome();
  if (!c?.storage?.local) return;
  try {
    await c.storage.local.set({ [CONFIG_KEY]: merged });
  } catch {}
}

/** Subscribe to new entries pushed into this context's buffer. Returns unsubscribe. */
export function subscribeLog(fn: (e: LogEntry) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
