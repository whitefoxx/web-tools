/**
 * What the knowledge base already holds, as far as this browser knows.
 *
 * The only way the extension learns that a page became a note is localmd
 * saying so: when it acks a clip it names the file it wrote, and that pair —
 * page URL → note path — is kept here.
 *
 * It is a CACHE of a folder this browser cannot see, so it can be wrong in the
 * one direction that matters: a note deleted or moved in the app left an entry
 * claiming the page is saved, at a path that no longer exists, and the popup
 * said so with a green tick (findings F-61). A cache of someone else's state is
 * kept honest by REVALIDATION, not by hoping every mutation remembers to tell
 * us — so the whole index is readable (`list_saved_pages`) and correctable
 * (`sync_saved_pages`), and localmd reconciles it against the real folder when
 * it connects, when a file is deleted or renamed, and when the user comes back
 * to it. Nothing in the KB depends on this being right; the user's trust in a
 * green tick does.
 *
 * What it buys: the toolbar icon says "KB" on a page you already saved, the
 * popup names the note, and clip_page can tell the agent it is about to clip a
 * page twice. That is the browser starting to know what the folder knows.
 *
 * Keyed by the page's canonical URL when the clip had one (the same article
 * reached through two tracking URLs is one note), with the #fragment dropped.
 */

const PREFIX = 'kbIndex:';

export interface KbEntry {
  /** KB-relative path of the note localmd wrote. */
  path: string;
  /** When it was recorded (ms). */
  at: number;
  title?: string;
}

/** The index key for a page: canonical if given, fragment stripped. Pure. */
export function kbKey(url: string, canonical?: string): string {
  const pick = canonical && /^https?:/i.test(canonical) ? canonical : url;
  try {
    const u = new URL(pick);
    u.hash = '';
    return PREFIX + u.href;
  } catch {
    return PREFIX + pick;
  }
}

export async function rememberInKb(url: string, entry: KbEntry, canonical?: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [kbKey(url, canonical)]: entry });
  } catch {
    /* storage unavailable — the badge just stays quiet */
  }
}

export async function lookupInKb(url: string, canonical?: string): Promise<KbEntry | null> {
  try {
    const key = kbKey(url, canonical);
    const got = await chrome.storage.local.get(key);
    const v = got?.[key] as KbEntry | undefined;
    return v && typeof v.path === 'string' ? v : null;
  } catch {
    return null;
  }
}

export async function forgetInKb(url: string, canonical?: string): Promise<void> {
  try {
    await chrome.storage.local.remove(kbKey(url, canonical));
  } catch {
    /* ignore */
  }
}

/** One row of the index, with the page URL its key encodes. */
export interface KbRow extends KbEntry {
  url: string;
}

/**
 * Everything this browser believes the knowledge base holds.
 *
 * Reads the whole of storage.local and filters by prefix: the alternative is a
 * second key holding a list of keys, and two structures that can disagree is
 * how an index acquires ghosts of its own.
 */
export async function listKbEntries(): Promise<KbRow[]> {
  try {
    const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
    const rows: KbRow[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(PREFIX)) continue;
      const v = value as KbEntry | undefined;
      if (!v || typeof v.path !== 'string') continue;
      rows.push({ url: key.slice(PREFIX.length), path: v.path, at: v.at, ...(v.title ? { title: v.title } : {}) });
    }
    return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  } catch {
    return [];
  }
}

/** Forget several pages at once; returns how many entries went away. */
export async function forgetManyInKb(urls: string[]): Promise<number> {
  const keys = urls.map((u) => kbKey(u));
  if (!keys.length) return 0;
  try {
    const before = await chrome.storage.local.get(keys);
    await chrome.storage.local.remove(keys);
    return Object.keys(before ?? {}).length;
  } catch {
    return 0;
  }
}
