/**
 * Which knowledge base is open, as far as this browser knows.
 *
 * The extension has no folder of its own: localmd holds the directory handles
 * (a File System Access handle cannot leave the page that was granted it), so
 * this is a mirror of localmd's recent-folders list plus which one is open —
 * pushed here by `sync_kb_folders` whenever it changes.
 *
 * Kept because the popup's whole job is answering "what will this button do to
 * my knowledge base", and a capture that silently went to a different folder
 * than the user pictured is the kind of mistake that is only discovered later.
 * Switching runs the other way: the popup asks, the extension broadcasts
 * `notifications/localmd/open-kb`, and localmd — the only side that can open a
 * folder — decides. The mirror is corrected by the sync that follows, never by
 * the request, so it says what IS open rather than what was asked for.
 */

const KEY = 'kbFolders';

export interface KbFolders {
  /** Folder names localmd offers, most recently opened first. */
  folders: string[];
  /** The one that is open right now, or null for none. */
  current: string | null;
  /** When localmd last told us (ms). */
  at: number;
}

export const NO_FOLDERS: KbFolders = { folders: [], current: null, at: 0 };

export async function saveKbFolders(folders: string[], current: string | null): Promise<KbFolders> {
  const value: KbFolders = {
    // Deduplicated, order kept: localmd sends its recents list, and the open
    // folder is usually also its first row.
    folders: [...new Set(folders.map((f) => f.trim()).filter(Boolean))],
    current: current && current.trim() ? current.trim() : null,
    at: Date.now(),
  };
  try {
    await chrome.storage.local.set({ [KEY]: value });
  } catch {
    /* the popup falls back to saying nothing about the folder */
  }
  return value;
}

export async function loadKbFolders(): Promise<KbFolders> {
  try {
    const got = await chrome.storage.local.get(KEY);
    const v = got?.[KEY] as KbFolders | undefined;
    if (!v || !Array.isArray(v.folders)) return NO_FOLDERS;
    return {
      folders: v.folders.filter((f) => typeof f === 'string'),
      current: typeof v.current === 'string' ? v.current : null,
      at: typeof v.at === 'number' ? v.at : 0,
    };
  } catch {
    return NO_FOLDERS;
  }
}

/** A folder list from a tool argument: JSON array, or a comma list. Pure. */
export function parseFolderList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String);
    } catch {
      /* fall through */
    }
  }
  return s.split(',').map((x) => x.trim());
}
