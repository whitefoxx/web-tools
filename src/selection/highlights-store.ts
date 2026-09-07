/**
 * Persistent highlights (selection-toolbar highlights) — chrome.storage.local, one key per
 * page (`selHl:<url-sans-hash>`), value = HighlightEntry[]. Content-script
 * only; kept tiny (ships in the every-page bundle).
 */

import type { QuoteDescriptor } from './anchor';

export interface HighlightEntry extends QuoteDescriptor {
  id: string;
  ts: number;
  /** Page title at creation time — for the panel's highlight-management list. */
  title?: string;
  /** Palette name (localmd Connect's in-page highlighter). Absent on entries
   *  made by the full shell's toolbar, which has one colour; readers treat an
   *  absent value as yellow rather than as a missing field. */
  color?: string;
  /** The user's own note on the passage, if they wrote one. Absent means they
   *  did not — a highlight without a note is the normal case, not an
   *  incomplete one. */
  note?: string;
}

/** Highlights are per-document: same page ± #hash shares them. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return `selHl:${u.href}`;
  } catch {
    return `selHl:${url}`;
  }
}

const MAX_PER_PAGE = 200;

export async function loadHighlights(key: string): Promise<HighlightEntry[]> {
  try {
    const got = await chrome.storage.local.get(key);
    const list = got?.[key];
    return Array.isArray(list) ? (list as HighlightEntry[]) : [];
  } catch {
    return [];
  }
}

export async function addHighlight(key: string, entry: HighlightEntry): Promise<void> {
  const list = await loadHighlights(key);
  list.push(entry);
  await chrome.storage.local.set({ [key]: list.slice(-MAX_PER_PAGE) });
}

export async function removeHighlight(key: string, id: string): Promise<void> {
  const list = await loadHighlights(key);
  const next = list.filter((e) => e.id !== id);
  if (next.length === 0) await chrome.storage.local.remove(key);
  else await chrome.storage.local.set({ [key]: next });
}

/** Change one entry in place, leaving the rest of the page's list alone.
 *  Returns the updated entry, or null when the id is no longer there. */
export async function updateHighlight(
  key: string,
  id: string,
  patch: Partial<Pick<HighlightEntry, 'color' | 'note'>>,
): Promise<HighlightEntry | null> {
  const list = await loadHighlights(key);
  const hit = list.find((e) => e.id === id);
  if (!hit) return null;
  if (patch.color !== undefined) hit.color = patch.color;
  if (patch.note !== undefined) {
    // An emptied note is a removed note, not an empty string sitting in storage.
    if (patch.note.trim()) hit.note = patch.note.trim();
    else delete hit.note;
  }
  await chrome.storage.local.set({ [key]: list });
  return hit;
}

export function makeHighlightId(): string {
  return `hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

const KEY_PREFIX = 'selHl:';

export interface PageHighlights {
  key: string;
  url: string;
  entries: HighlightEntry[];
}

/** Every page's highlights, newest page first — the panel's highlight-management list.
 * Uses storage.local.getKeys() (Chrome 130+; we require 138) so we never pull
 * unrelated large values (installed adapter sources etc.); get(null) fallback. */
export async function listAllHighlights(): Promise<PageHighlights[]> {
  try {
    const local = chrome.storage.local as chrome.storage.LocalStorageArea & {
      getKeys?: () => Promise<string[]>;
    };
    const keys = (
      local.getKeys ? await local.getKeys() : Object.keys(await local.get(null))
    ).filter((k) => k.startsWith(KEY_PREFIX));
    if (!keys.length) return [];
    const got = await local.get(keys);
    const out: PageHighlights[] = [];
    for (const k of keys) {
      const v = got?.[k];
      if (!Array.isArray(v) || v.length === 0) continue;
      out.push({ key: k, url: k.slice(KEY_PREFIX.length), entries: v as HighlightEntry[] });
    }
    out.sort(
      (a, b) => Math.max(...b.entries.map((e) => e.ts)) - Math.max(...a.entries.map((e) => e.ts)),
    );
    return out;
  } catch {
    return [];
  }
}

/** Drop every highlight of one page (the panel's "clear this page"). */
export async function clearPageHighlights(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

// ── "open that page and take me to this passage" ──────────────────────────────

/** One pending focus request, keyed by page. Storage rather than a message
 *  because the tab may not exist yet when the request is made: the annotations
 *  list opens the page and the content script picks the request up when it has
 *  finished re-anchoring. */
const FOCUS_KEY = 'hlFocus';

/** Ask the next load of `key`'s page to scroll to this highlight. */
export async function requestHighlightFocus(key: string, id: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [FOCUS_KEY]: { key, id, at: Date.now() } });
  } catch {
    /* the page still opens, just without the jump */
  }
}

/** The pending request for this page, if it is fresh — and clear it, so a
 *  later visit to the same page does not jump again. Two minutes: long enough
 *  for a slow page, short enough that a request nobody consumed expires. */
export async function takeHighlightFocus(key: string): Promise<string | null> {
  try {
    const got = await chrome.storage.local.get(FOCUS_KEY);
    const req = got?.[FOCUS_KEY] as { key?: string; id?: string; at?: number } | undefined;
    if (!req || req.key !== key || typeof req.id !== 'string') return null;
    await chrome.storage.local.remove(FOCUS_KEY);
    if (typeof req.at === 'number' && Date.now() - req.at > 120_000) return null;
    return req.id;
  } catch {
    return null;
  }
}
