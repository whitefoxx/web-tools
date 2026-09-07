/**
 * Settings for the in-page highlighter — the only thing this shell injects into
 * every page, so the only thing a user might want to switch off.
 *
 * A BLACKLIST, not an allowlist, for the reason the full shell's selection
 * toolbar settled on one (docs/selection-toolbar.md §2.1): a feature you have to
 * enable per site is a feature nobody uses, and the sites where an injected
 * toolbar is genuinely unwelcome are few and known to the person browsing.
 *
 * The script is registered for every http(s) page and DISABLES ITSELF from
 * these settings rather than being registered per host. That keeps registration
 * a constant (no churn when the list changes), covers SPAs for free, and lets a
 * `storage.onChanged` listener switch already-open tabs without a reload.
 */
import { isHostBlacklisted, normalizeBlacklistEntry } from '../selection/settings';

export { isHostBlacklisted, normalizeBlacklistEntry };

export const PAGE_TOOLS_KEY = 'localmdPageTools';

export interface PageToolsSettings {
  /** Master switch. On by default: a highlighter nobody switched on is a
   *  highlighter nobody has. */
  enabled: boolean;
  /** Hosts to stay out of. Suffix match, `www.` transparent on both sides. */
  blacklist: string[];
  /** Colour a new highlight gets when none is picked. */
  defaultColor: HighlightColor;
  /** Show the toolbar when text is selected. Off leaves the rest of the
   *  feature alone: highlights still come back on a revisit and clicking one
   *  still opens its own bar — what stops is the thing that appears every time
   *  you select a sentence, which is the part someone reading might not want. */
  bar: boolean;
  /** Saved prompts, in toolbar order — name + template, run on the passage and
   *  answered in place by localmd's model (docs/localmd-connect.md §14.4o).
   *  `on` is whether it appears; one the user switched off is kept, not
   *  deleted. */
  prompts: SavedPrompt[];
  /** What ${lang} becomes. Empty = follow the browser's own language, which is
   *  resolved at USE time (`resolveLang`) rather than baked in here, so a user
   *  who never opens Settings still gets a sensible answer. */
  lang: string;
}

/**
 * One saved prompt: a name and a template.
 *
 * Deliberately nothing else. The whole point of the editor is that anybody can
 * add one in fifteen seconds, and every field it asks for is a field somebody
 * has to have an opinion about. Variables carry what the prompt cannot say by
 * itself — ${content} for the passage, ${lang} for the output language.
 *
 * An EMPTY prompt is not a broken entry, it is the general one: the page
 * asks for the instruction when you use it, and what you type becomes the
 * template. That is the same engine, with the template written later — so the
 * variables and the append-in-triple-quotes rule apply to a typed question
 * exactly as they do to a saved one, and nothing here knows about a special
 * case. It is also the honest answer to "what about the fourth thing I want to
 * ask": do it the long way, and promote it to a saved ask if it recurs.
 */
export interface SavedPrompt {
  id: string;
  label: string;
  prompt: string;
  on: boolean;
}

/** The palette, and the names it stores. Deliberately the same five colours
 *  localmd renders annotations in, so a highlight archived into the knowledge
 *  base looks like the one on the page rather than approximately like it. */
export const HIGHLIGHT_COLORS = [
  { name: 'yellow', value: '#FFD633' },
  { name: 'green', value: '#7ED67E' },
  { name: 'blue', value: '#57B7F0' },
  { name: 'pink', value: '#FF8AAE' },
  { name: 'purple', value: '#BB8AEA' },
] as const;

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]['name'];

/**
 * The three that ship.
 *
 * Two prompts and an escape hatch. The two are examples as much as features:
 * they are what a reader wants often enough to be worth a click, and between
 * them they demonstrate both variables — so the first thing anybody sees on
 * opening the editor is a working template to copy. The third has no prompt,
 * which is what makes it general: it asks.
 */
export const DEFAULT_PROMPTS: SavedPrompt[] = [
  {
    id: 'translate',
    label: 'Translate',
    prompt: 'Translate the following into ${lang}. Output only the translation: """${content}"""',
    on: true,
  },
  {
    id: 'explain',
    label: 'Explain',
    prompt:
      'Explain the following clearly and concisely in ${lang}, with any background needed to make sense of it: """${content}"""',
    on: true,
  },
  {
    id: 'ask',
    label: 'Ask…',
    prompt: '',
    on: true,
  },
];

/** Offered in the language box. Free text is still accepted — "formal Japanese"
 *  is a perfectly good answer and no list would have it. */
export const LANGUAGE_SUGGESTIONS = [
  'English',
  '简体中文',
  '繁體中文',
  '日本語',
  '한국어',
  'Français',
  'Deutsch',
  'Español',
  'Português',
  'Русский',
  'Italiano',
  'العربية',
] as const;

/** The browser's own language, as something to put in a prompt. Pure, so the
 *  caller passes `chrome.i18n.getUILanguage()` and a test passes a string. */
export function defaultLanguage(locale: string | undefined): string {
  const l = (locale ?? '').toLowerCase();
  if (l.startsWith('zh')) return /hant|tw|hk|mo/.test(l) ? '繁體中文' : '简体中文';
  if (l.startsWith('ja')) return '日本語';
  if (l.startsWith('ko')) return '한국어';
  if (l.startsWith('fr')) return 'Français';
  if (l.startsWith('de')) return 'Deutsch';
  if (l.startsWith('es')) return 'Español';
  if (l.startsWith('pt')) return 'Português';
  if (l.startsWith('ru')) return 'Русский';
  if (l.startsWith('it')) return 'Italiano';
  if (l.startsWith('ar')) return 'العربية';
  return 'English';
}

/** The output language to actually use: what was chosen, else the browser's. */
export function resolveLang(stored: string, locale?: string): string {
  const s = stored.trim();
  if (s) return s;
  try {
    return defaultLanguage(locale ?? chrome.i18n?.getUILanguage?.());
  } catch {
    return defaultLanguage(locale);
  }
}

/**
 * Where the highlighter stays out of the way to begin with.
 *
 * localmd's own pages: selecting text in an editor means "edit this", and a
 * toolbar on every selection there is in the way of the thing this extension
 * exists to serve. It was a hard-coded rule for a day, which was one mechanism
 * too many — as a DEFAULT it is the same behaviour expressed as data the user
 * can see in the list and remove if they disagree. Suffix-matched, so
 * `app.localmd.app` is covered; the development app on another host is not, and
 * can be added like any other site.
 */
export const DEFAULT_BLACKLIST = ['localmd.app'];

export const DEFAULT_PAGE_TOOLS: PageToolsSettings = {
  enabled: true,
  blacklist: DEFAULT_BLACKLIST,
  defaultColor: 'yellow',
  bar: true,
  prompts: DEFAULT_PROMPTS,
  lang: '',
};

/** A stored prompt list → a usable one. An entry that survives keeps its own
 *  `on`. Capped, so a corrupted blob cannot produce a hundred-item menu. */
export function mergePrompts(raw: unknown): SavedPrompt[] {
  if (!Array.isArray(raw)) return DEFAULT_PROMPTS;
  const out: SavedPrompt[] = [];
  for (const item of raw) {
    const a = (item ?? {}) as Partial<SavedPrompt>;
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
    // A NAME is the whole requirement. No prompt means the open-ended kind,
    // which is a setting, not a broken row.
    if (!label) continue;
    out.push({
      id: typeof a.id === 'string' && a.id ? a.id : `p_${out.length + 1}`,
      label: label.slice(0, 40),
      prompt,
      on: a.on !== false,
    });
    if (out.length >= 20) break;
  }
  // An EMPTY array is a real answer here, unlike a missing one: "I switched
  // them all off and deleted the rest" has to survive a reload.
  return out;
}

export function isHighlightColor(v: unknown): v is HighlightColor {
  return HIGHLIGHT_COLORS.some((c) => c.name === v);
}

/** Stored value → settings, tolerating anything (an older build, a hand-edited
 *  storage entry). Pure, so the merge is unit-testable without chrome. */
export function mergePageTools(raw: unknown): PageToolsSettings {
  const o = (raw ?? {}) as Partial<PageToolsSettings>;
  // An array that is PRESENT is the user's answer, even when it is empty —
  // deleting the default entry has to survive a reload. The default applies
  // only where no list has been stored at all.
  const blacklist = Array.isArray(o.blacklist)
    ? o.blacklist
        .map((v) => normalizeBlacklistEntry(String(v)))
        .filter((v): v is string => !!v)
        .slice(0, 200)
    : [...DEFAULT_BLACKLIST];
  return {
    enabled: o.enabled !== false,
    blacklist,
    defaultColor: isHighlightColor(o.defaultColor) ? o.defaultColor : 'yellow',
    bar: o.bar !== false,
    // `asks` was this field's name for a day; read it so nobody's list
    // vanishes on the update that renamed it.
    prompts: mergePrompts(o.prompts ?? (o as { asks?: unknown }).asks),
    lang: typeof o.lang === 'string' ? o.lang.trim().slice(0, 40) : '',
  };
}

/** Whether the highlighter should run on this URL at all. */
export function runsOn(url: string, s: PageToolsSettings): boolean {
  if (!s.enabled) return false;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname;
  } catch {
    return false;
  }
  return !isHostBlacklisted(host, s.blacklist);
}

export async function loadPageTools(): Promise<PageToolsSettings> {
  try {
    const got = await chrome.storage.local.get(PAGE_TOOLS_KEY);
    return mergePageTools(got?.[PAGE_TOOLS_KEY]);
  } catch {
    return { ...DEFAULT_PAGE_TOOLS };
  }
}

export async function savePageTools(s: PageToolsSettings): Promise<void> {
  await chrome.storage.local.set({ [PAGE_TOOLS_KEY]: s });
}

/** Live settings, so a toggle reaches tabs that are already open. */
export function watchPageTools(cb: (s: PageToolsSettings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[PAGE_TOOLS_KEY]) return;
    cb(mergePageTools(changes[PAGE_TOOLS_KEY].newValue));
  });
}
