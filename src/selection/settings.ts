/**
 * Selection toolbar (text-selection toolbar) — settings shared by the content script
 * (guard + actions), the SidePanel settings page, and the SW (nothing yet).
 *
 * Storage: chrome.storage.local['selToolbarSettings']. The content script is
 * declared in the manifest for every http(s) page but exits/idles unless
 * `enabled` && host not blacklisted — the user's model is BLACKLIST, not
 * allowlist: turning the feature on covers every site, entries here opt OUT.
 *
 * KEEP THIS MODULE LEAN: it is part of the content-script bundle that loads on
 * every page. chrome.storage only — no panel/background imports.
 */

export interface SelAction {
  id: string;
  /** Button label on the toolbar (keep to ~2-4 chars). */
  label: string;
  /** Instruction applied to the selected text via one LLM completion. */
  prompt: string;
  /** Only show the button when the selection has at least this many chars
   * (0/absent = always). E.g. Summarize makes no sense on a 5-word selection. */
  minChars?: number;
}

export type SelTrigger = 'auto' | 'alt';

export interface SelToolbarSettings {
  /** Master switch — default OFF (avoid it unless needed). */
  enabled: boolean;
  /** 'auto' = toolbar appears on any selection; 'alt' = only while holding
   * Alt/⌥ at mouse-up (the low-distraction mode). */
  trigger: SelTrigger;
  /** Hostname entries that opt OUT (suffix match: "example.com" also covers
   * "sub.example.com"). */
  blacklist: string[];
  /** LLM quick actions, in toolbar order. The two BUILT-IN actions (Highlight first,
   * Ask last) are fixed and not stored here. */
  actions: SelAction[];
}

/** Preset LLM actions — the most-used trio; the user edits/extends in settings. */
export const DEFAULT_SEL_ACTIONS: SelAction[] = [
  {
    id: 'translate',
    label: 'Translate',
    prompt:
      'Translate the selected text into English; if the source is already mostly English, translate it into Chinese instead. Output only the translation itself.',
  },
  {
    id: 'explain',
    label: 'Explain',
    prompt:
      'Explain the selected text in plain language (add background on any terms/concepts if needed), concise and to the point, without going off on unrelated tangents.',
  },
  {
    id: 'summarize',
    label: 'Summarize',
    prompt:
      'Condense the selected text into no more than 3 bullet points, keeping the key conclusions and numbers.',
    minChars: 120,
  },
];

export const DEFAULT_SEL_SETTINGS: SelToolbarSettings = {
  enabled: false,
  trigger: 'auto',
  blacklist: [],
  actions: DEFAULT_SEL_ACTIONS,
};

const KEY = 'selToolbarSettings';

/** Merge a stored blob over the defaults — tolerates missing/older fields. */
export function mergeSelSettings(raw: unknown): SelToolbarSettings {
  const r = (raw ?? {}) as Partial<SelToolbarSettings>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_SEL_SETTINGS.enabled,
    trigger: r.trigger === 'alt' ? 'alt' : 'auto',
    blacklist: Array.isArray(r.blacklist)
      ? r.blacklist.filter((h): h is string => typeof h === 'string' && !!h)
      : [],
    actions: mergeSelActions(r.actions, DEFAULT_SEL_ACTIONS),
  };
}

/**
 * A stored actions array → usable actions, falling back when there is nothing
 * usable in it. Shared with localmd Connect, whose in-page bar runs the same
 * recipes against the app's model rather than this shell's — the ACTIONS are
 * data, and only who answers them differs.
 */
export function mergeSelActions(raw: unknown, fallback: SelAction[]): SelAction[] {
  if (!Array.isArray(raw) || !raw.length) return fallback;
  const out = raw
    .filter(
      (a): a is SelAction =>
        !!a &&
        typeof a.id === 'string' &&
        typeof a.label === 'string' &&
        typeof a.prompt === 'string',
    )
    .map((a) => ({
      id: a.id,
      label: a.label,
      prompt: a.prompt,
      // Keep an explicit number (0 = user chose "always show"). Legacy
      // blobs (field absent) get Summarize's sensible default backfilled.
      ...(typeof a.minChars === 'number' && a.minChars >= 0
        ? { minChars: Math.floor(a.minChars) }
        : a.id === 'summarize'
          ? { minChars: 120 }
          : {}),
    }))
    .slice(0, 12);
  return out.length ? out : fallback;
}

/** The actions visible for a selection of `textLen` chars (minChars gate). */
export function visibleSelActions(actions: SelAction[], textLen: number): SelAction[] {
  return actions.filter((a) => !a.minChars || textLen >= a.minChars);
}

export async function loadSelSettings(): Promise<SelToolbarSettings> {
  try {
    const got = await chrome.storage.local.get(KEY);
    return mergeSelSettings(got?.[KEY]);
  } catch {
    return { ...DEFAULT_SEL_SETTINGS };
  }
}

export async function saveSelSettings(s: SelToolbarSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}

/** Live re-config: fires with fresh settings whenever they change. */
export function watchSelSettings(cb: (s: SelToolbarSettings) => void): () => void {
  const on = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !changes[KEY]) return;
    cb(mergeSelSettings(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(on);
  return () => chrome.storage.onChanged.removeListener(on);
}

/** Suffix hostname match: entry "example.com" blocks example.com AND
 * sub.example.com; an entry never matches a mere substring (notexample.com). */
export function isHostBlacklisted(host: string, blacklist: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return blacklist.some((raw) => {
    const e = raw.toLowerCase().replace(/^www\./, '');
    return !!e && (h === e || h.endsWith('.' + e));
  });
}

/** Parse a user-typed blacklist entry (bare host or full URL) → hostname. */
export function normalizeBlacklistEntry(v: string): string | null {
  const t = v.trim().toLowerCase();
  if (!t) return null;
  try {
    return new URL(t.includes('://') ? t : `https://${t}`).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}
