/**
 * localmd Connect settings — its own page, opened from the popup's gear.
 *
 * It used to be four collapsed sections inside a 328px popup, which meant every
 * open of the popup showed a wall of things nobody was there to change. A
 * settings page is read rarely and read carefully; a popup is the opposite, and
 * the two do not belong in one surface.
 *
 * The blocks below moved here verbatim from the popup: the same message types,
 * the same element ids, so the service worker knows nothing about the split.
 */

import type { SiteScript } from '../site-scripts/store';
import {
  clearPageHighlights,
  listAllHighlights,
  pageKey,
  removeHighlight,
  requestHighlightFocus,
  updateHighlight,
  type PageHighlights,
} from '../selection/highlights-store';
import {
  DEFAULT_PROMPTS,
  HIGHLIGHT_COLORS,
  LANGUAGE_SUGGESTIONS,
  mergePageTools,
  resolveLang,
  type HighlightColor,
  type SavedPrompt,
} from './page-settings';
import {
  ICON_CARET,
  ICON_CODE,
  ICON_DATA,
  ICON_MARK,
  ICON_PENCIL,
  ICON_PLUG,
  ICON_QUOTE,
  ICON_SPARK,
  ICON_TERMINAL,
  ICON_TRASH,
} from './ui-icons';

const DOC_URL = 'https://localmd.app';
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const verEl = $('ver');
const docLink = $<HTMLAnchorElement>('docLink');

/* ── the two panes ────────────────────────────────────────────────────────── */

/**
 * A list of topics on the left, one topic on the right.
 *
 * The sections used to be stacked, so reaching the last one meant scrolling
 * past five others — and the popup's deep link into Annotations landed the
 * reader in the middle of a page with no sense of where they were. The nav is
 * built FROM the sections (`data-nav`, `data-icon`), so adding a section is one
 * edit to the HTML and nothing here.
 */
const NAV_ICONS: Record<string, string> = {
  quote: ICON_QUOTE,
  spark: ICON_SPARK,
  mark: ICON_MARK,
  data: ICON_DATA,
  code: ICON_CODE,
  plug: ICON_PLUG,
  terminal: ICON_TERMINAL,
};

const sections = [...document.querySelectorAll<HTMLElement>('main section[data-nav]')];
const nav = $('nav');
const navButtons = new Map<string, HTMLButtonElement>();

$<HTMLImageElement>('brandMark').src = chrome.runtime.getURL('icons/localmd-connect.svg');
$<HTMLImageElement>('footMark').src = chrome.runtime.getURL('icons/localmd-app.svg');

for (const section of sections) {
  const b = document.createElement('button');
  b.className = 'nav-item';
  b.dataset.section = section.id;
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.innerHTML = NAV_ICONS[section.dataset.icon ?? ''] ?? '';
  const label = document.createElement('span');
  label.textContent = section.dataset.nav ?? section.id;
  b.append(ico, label);
  b.addEventListener('click', () => {
    // Through the hash, so Back works and the popup's deep link is the same
    // mechanism the nav uses rather than a special case.
    location.hash = `#${section.id}`;
  });
  navButtons.set(section.id, b);
  nav.append(b);
}

/** A count beside a nav item — the same number its heading shows, so the left
 *  pane says what is in each topic without opening it. */
function navBadge(id: string, text: string): void {
  const b = navButtons.get(id);
  if (!b) return;
  let badge = b.querySelector<HTMLElement>('.badge');
  if (!text) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'badge';
    b.append(badge);
  }
  badge.textContent = text;
}

function visibleSections(): HTMLElement[] {
  // A section the build hides (the dev-only CLI block) is not a destination.
  return sections.filter((s) => !s.dataset.unavailable);
}

function show(id: string): void {
  const list = visibleSections();
  const target = list.find((s) => s.id === id) ?? list[0];
  if (!target) return;
  for (const s of sections) s.hidden = s !== target;
  for (const [sid, b] of navButtons) b.classList.toggle('on', sid === target.id);
  document.title = `${target.dataset.nav ?? 'Settings'} — localmd Connect`;
  $('main').scrollTo?.({ top: 0 });
}

function showFromHash(): void {
  show(location.hash.replace(/^#/, ''));
}
window.addEventListener('hashchange', showFromHash);

/** Hide a section AND its way in — used for the dev-only block. */
function setSectionAvailable(id: string, available: boolean): void {
  const section = sections.find((s) => s.id === id);
  if (!section) return;
  if (available) delete section.dataset.unavailable;
  else section.dataset.unavailable = '1';
  const b = navButtons.get(id);
  if (b) b.hidden = !available;
  if (!available && !section.hidden) showFromHash();
}
for (const s of sections) if (s.hidden) setSectionAvailable(s.id, false);
showFromHash();
const userScriptsWarn = $('userScriptsWarn');
const openSettings = $<HTMLButtonElement>('openSettings');
const daemonHint = $('daemonHint');

verEl.textContent = 'v' + chrome.runtime.getManifest().version;
docLink.href = DOC_URL;

openSettings.addEventListener('click', () => {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

async function copyInto(btn: HTMLButtonElement, text: string): Promise<void> {
  const label = btn.textContent ?? 'Copy';
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => (btn.textContent = label), 1200);
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
  btn.addEventListener('click', () => {
    const src = document.getElementById(btn.dataset.copy ?? '');
    if (src) void copyInto(btn, (src.textContent ?? '').trim());
  });
}

// ── Annotations — everything marked, and the way back to it ──
//
// The popup can say "3 highlights on this page"; it cannot answer "which ones,
// and where". This list can, and clicking a passage opens its page and scrolls
// to it — the anchoring lives in the content script (selection/anchor), so a
// page that changed under the highlight is still found by its text.

const markCount = $('markCount');
const markList = $('markList');
const markEmpty = $('markEmpty');
const markSearch = $<HTMLInputElement>('markSearch');

/** The page this view was opened FOR, when it was opened from that page's chip
 *  in the popup — scrolled to and outlined, rather than filtered to, so the
 *  rest of the list is still there to browse. */
const focusPage = new URL(location.href).searchParams.get('page');

let allMarks: PageHighlights[] = [];

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "3 days ago", down to "just now". Dates on a list of quotes are noise; how
 *  long ago is the part anyone reads. */
export function whenLabel(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Pages whose title, url, quoted text or note matches. Pure. */
export function filterMarks(pages: PageHighlights[], query: string): PageHighlights[] {
  const q = query.trim().toLowerCase();
  if (!q) return pages;
  const out: PageHighlights[] = [];
  for (const page of pages) {
    const pageMatch = page.url.toLowerCase().includes(q);
    const entries = page.entries.filter(
      (e) =>
        pageMatch ||
        (e.exact ?? '').toLowerCase().includes(q) ||
        (e.note ?? '').toLowerCase().includes(q) ||
        (e.title ?? '').toLowerCase().includes(q),
    );
    if (entries.length) out.push({ ...page, entries });
  }
  return out;
}

function colorOf(name: string | undefined): string {
  return HIGHLIGHT_COLORS.find((c) => c.name === name)?.value ?? HIGHLIGHT_COLORS[0].value;
}

/* ── one dialog for the page ──────────────────────────────────────────────── */

const modal = $('modal');
const modalTitle = $('modalTitle');
const modalBody = $('modalBody');
const modalOk = $<HTMLButtonElement>('modalOk');
const modalCancel = $<HTMLButtonElement>('modalCancel');
let settleModal: ((yes: boolean) => void) | null = null;

/**
 * Ask before doing something irreversible.
 *
 * Ours rather than `window.confirm`, which is a different typeface, a different
 * button order and a bar pinned to the top of the window naming the page's URL
 * — it reads as the browser interrupting rather than as this page asking, and
 * it cannot show the passage it is about to remove.
 *
 * The SAFE button takes focus, so a reflexive Enter cancels. Escape and a click
 * on the backdrop cancel too: every quick way out of this dialog leads away
 * from the destructive thing.
 */
function askConfirm(o: { title: string; body?: string; ok?: string }): Promise<boolean> {
  settleModal?.(false); // never leave an older question waiting
  modalTitle.textContent = o.title;
  modalBody.textContent = o.body ?? '';
  modalOk.textContent = o.ok ?? 'Remove';
  modal.hidden = false;
  modalCancel.focus();
  return new Promise<boolean>((resolve) => {
    settleModal = (yes) => {
      settleModal = null;
      modal.hidden = true;
      resolve(yes);
    };
  });
}

modalOk.addEventListener('click', () => settleModal?.(true));
modalCancel.addEventListener('click', () => settleModal?.(false));
modal.addEventListener('click', (e) => {
  if (e.target === modal) settleModal?.(false); // the backdrop, not the card
});
document.addEventListener('keydown', (e) => {
  if (!modal.hidden && e.key === 'Escape') settleModal?.(false);
});

/**
 * Edit a note where it is read.
 *
 * In place rather than in a dialog: the passage it belongs to is the line above
 * it, and that context is most of what makes a note editable at all. Saving
 * re-reads the list, so the row comes back with whatever was written — and an
 * empty note removes the note without touching the highlight.
 */
function openNoteEditor(
  page: PageHighlights,
  id: string,
  initial: string,
  host: HTMLElement,
  noteEl: HTMLElement,
): void {
  if (host.querySelector('.note-edit')) return;
  noteEl.hidden = true;
  const box = document.createElement('div');
  box.className = 'note-edit';
  const ta = document.createElement('textarea');
  ta.value = initial;
  ta.rows = 2;
  ta.placeholder = 'Why this passage matters…';
  const row = document.createElement('div');
  row.className = 'note-edit-row';
  const save = document.createElement('button');
  save.className = 'btn primary';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  const close = (): void => {
    box.remove();
    noteEl.hidden = !noteEl.textContent;
    // Anything that changed while this was open is shown now.
    if (marksStale) refreshMarksSoon();
  };
  const commit = (): void => {
    const note = ta.value.trim();
    void updateHighlight(page.key, id, { note }).then(loadMarks);
    close();
  };
  save.addEventListener('click', (e) => {
    e.stopPropagation();
    commit();
  });
  cancel.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });
  // The row this sits in opens the page when clicked; typing in here must not.
  for (const ev of ['click', 'keydown'] as const) {
    box.addEventListener(ev, (e) => e.stopPropagation());
  }
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
  });
  row.append(save, cancel);
  box.append(ta, row);
  host.append(box);
  ta.focus();
}

function renderMarks(): void {
  const pages = filterMarks(allMarks, markSearch.value);
  const total = allMarks.reduce((n, p) => n + p.entries.length, 0);
  markCount.textContent = total
    ? `${total} on ${allMarks.length} page${allMarks.length === 1 ? '' : 's'}`
    : '';
  navBadge('annotations', total ? String(total) : '');
  markList.textContent = '';
  markEmpty.textContent = allMarks.length
    ? pages.length
      ? ''
      : 'Nothing matches that.'
    : 'Nothing highlighted yet. Select text on any page to start.';

  let focusEl: HTMLElement | null = null;
  for (const page of pages) {
    const card = document.createElement('div');
    card.className = 'mark-page';
    const head = document.createElement('div');
    head.className = 'mark-page-head';
    const title = document.createElement('span');
    title.className = 'mark-page-title';
    title.textContent = page.entries.find((e) => e.title)?.title || hostOf(page.url);
    const host = document.createElement('span');
    host.className = 'mark-page-host';
    host.textContent = hostOf(page.url);
    // These are the user's own annotations and there is no undo, so both
    // removals ask — the same way deleting a site script does, which is the
    // other irreversible thing this page can do.
    const clear = document.createElement('button');
    clear.className = 'mark-page-clear';
    clear.textContent = 'Remove all';
    clear.title = 'Remove every highlight on this page';
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = page.entries.length;
      const where = page.entries.find((x) => x.title)?.title || hostOf(page.url);
      void askConfirm({
        title: `Remove ${n} highlight${n === 1 ? '' : 's'}?`,
        body: `Everything highlighted on “${where}”. This cannot be undone.`,
        ok: 'Remove all',
      }).then((yes) => {
        if (yes) void clearPageHighlights(page.key).then(loadMarks);
      });
    });
    head.append(title, host, clear);
    card.append(head);

    for (const entry of page.entries) {
      // A div, not a button: the row now carries buttons of its own, and a
      // button inside a button is not a thing the DOM has.
      const row = document.createElement('div');
      row.className = 'mark';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = 'Open the page and scroll to this passage';
      const dot = document.createElement('span');
      dot.className = 'swatch';
      dot.style.background = colorOf(entry.color);
      const text = document.createElement('span');
      text.className = 'mark-text';
      const quote = document.createElement('div');
      quote.className = 'mark-quote';
      quote.textContent = entry.exact ?? '';
      text.append(quote);
      const note = document.createElement('div');
      note.className = 'mark-note';
      note.textContent = entry.note ?? '';
      note.hidden = !entry.note;
      text.append(note);
      const when = document.createElement('span');
      when.className = 'mark-when';
      when.textContent = whenLabel(entry.ts);

      // The note is the reason the passage was marked, and it was readable
      // here and editable only by going back to the page and clicking the
      // highlight. It edits in place instead.
      const edit = document.createElement('button');
      edit.className = 'mark-act';
      edit.innerHTML = ICON_PENCIL;
      edit.title = entry.note ? 'Edit the note' : 'Write a note';
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        openNoteEditor(page, entry.id, entry.note ?? '', text, note);
      });
      const del = document.createElement('button');
      del.className = 'mark-act';
      del.innerHTML = ICON_TRASH;
      del.title = 'Remove this highlight';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        const what = (entry.exact ?? '').trim();
        const snippet = what.length > 90 ? `${what.slice(0, 90)}…` : what;
        void askConfirm({
          title: 'Remove this highlight?',
          body: snippet ? `“${snippet}”` : '',
        }).then((yes) => {
          if (yes) void removeHighlight(page.key, entry.id).then(loadMarks);
        });
      });
      row.append(dot, text, when, edit, del);
      const go = (): void => void jumpTo(page, entry.id);
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
      card.append(row);
    }
    if (focusPage && pageKey(focusPage) === page.key) {
      card.classList.add('focus');
      focusEl = card;
    }
    markList.append(card);
  }
  focusEl?.scrollIntoView?.({ block: 'center' });
}

/** Open the page and ask its highlighter to take us to the passage. The request
 *  is left in storage rather than sent as a message: the tab does not exist yet,
 *  and the content script consumes it once it has finished re-anchoring. */
async function jumpTo(page: PageHighlights, id: string): Promise<void> {
  await requestHighlightFocus(page.key, id);
  const [open] = await chrome.tabs.query({ url: page.url.split('#')[0] });
  if (open && typeof open.id === 'number') {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true }).catch(() => {});
    // An already-open tab has already restored its highlights, so nothing will
    // read the request on its own — ask directly.
    await chrome.tabs
      .sendMessage(open.id, { type: 'LOCALMD_FOCUS_HIGHLIGHT', id })
      .catch(() => undefined);
    return;
  }
  await chrome.tabs.create({ url: page.url });
}

/**
 * Highlights made (or removed) while this page is open.
 *
 * The content script already listens the other way — a mark deleted here stops
 * being painted on an open tab — and this is the missing half: a list of
 * annotations that goes stale the moment you highlight something is a list you
 * stop trusting. Storage is the shared surface, so both directions are the
 * same one line of plumbing.
 *
 * A reload rebuilds every row, which would take an open note editor with it.
 * So while one is open the refresh is DEFERRED rather than skipped: losing what
 * somebody is typing to show them a row they did not ask about is a bad trade.
 */
let marksStale = false;

function refreshMarksSoon(): void {
  if (markList.querySelector('.note-edit')) {
    marksStale = true;
    return;
  }
  marksStale = false;
  void loadMarks();
}

let marksTimer: ReturnType<typeof setTimeout> | null = null;
chrome.storage.onChanged.addListener((changes, area) => {
  // Several marks at once (a page restoring, a page-wide clear) fire one change
  // per key; one repaint is enough for all of them.
  if (area !== 'local' || !Object.keys(changes).some((k) => k.startsWith('selHl:'))) return;
  if (marksTimer) clearTimeout(marksTimer);
  marksTimer = setTimeout(refreshMarksSoon, 200);
});

async function loadMarks(): Promise<void> {
  allMarks = await listAllHighlights();
  renderMarks();
}

markSearch.addEventListener('input', renderMarks);
void loadMarks();

// ── Highlighting — the one thing this extension puts on every page ──
// A blacklist, not an allowlist: a feature you have to switch on per site is a
// feature nobody uses, and the sites where it is unwelcome are few and known to
// the person browsing.
import type { PageToolsSettings } from './page-settings';

const hlEnabled = $<HTMLInputElement>('hlEnabled');
const hlBlock = $<HTMLInputElement>('hlBlock');
const hlList = $('hlList');
const hlState = $('hlState');
const hlNote = $('hlNote');

let pageTools: PageToolsSettings | null = null;

function renderPageTools(): void {
  if (!pageTools) return;
  hlEnabled.checked = pageTools.enabled;
  hlState.textContent = pageTools.enabled
    ? pageTools.blacklist.length
      ? `(${pageTools.blacklist.length})`
      : ''
    : '(highlighting is off)';
  hlBlock.disabled = !pageTools.enabled;
  hlList.textContent = '';
  for (const host of pageTools.blacklist) {
    const row = document.createElement('div');
    row.className = 'item';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = host;
    const del = document.createElement('button');
    del.innerHTML = ICON_TRASH;
    del.title = `Highlight on ${host} again`;
    del.addEventListener('click', () => {
      if (!pageTools) return;
      savePageTools({ ...pageTools, blacklist: pageTools.blacklist.filter((h) => h !== host) });
    });
    row.append(name, del);
    hlList.append(row);
  }
  renderColors();
  renderPrompts();
  hlNote.textContent = pageTools.enabled
    ? pageTools.blacklist.length
      ? ''
      : 'Otherwise everywhere. Add a hostname above to stay off a site.'
    : 'Highlighting is off everywhere. Existing highlights are kept.';
}

function savePageTools(next: PageToolsSettings): void {
  pageTools = next;
  renderPageTools();
  chrome.runtime.sendMessage({ type: 'SET_PAGE_TOOLS', settings: next }, () => {
    void chrome.runtime.lastError;
  });
}

function refreshPageTools(): void {
  chrome.runtime.sendMessage(
    { type: 'GET_PAGE_TOOLS' },
    (resp?: { settings?: PageToolsSettings }) => {
      void chrome.runtime.lastError;
      if (resp?.settings) {
        // Merged rather than trusted: this crosses a process boundary, and
        // during an extension update the worker on the other side can be a
        // version whose settings object has a field fewer than this page
        // reads. Merging costs nothing and removes the whole class.
        pageTools = mergePageTools(resp.settings);
        renderPageTools();
      }
    },
  );
}

hlEnabled.addEventListener('change', () => {
  if (pageTools) savePageTools({ ...pageTools, enabled: hlEnabled.checked });
});
hlBlock.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !pageTools) return;
  const raw = hlBlock.value.trim();
  if (!raw) return;
  // Accept a pasted URL as readily as a hostname — that is what someone has on
  // their clipboard when they decide a site should be left alone.
  let host = raw;
  try {
    if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname;
  } catch {
    /* keep what they typed */
  }
  host = host.toLowerCase().replace(/^www\./, '');
  if (!host || pageTools.blacklist.includes(host)) {
    hlBlock.value = '';
    return;
  }
  savePageTools({ ...pageTools, blacklist: [...pageTools.blacklist, host] });
  hlBlock.value = '';
});

// ── Prompts — name + template, run on a passage and answered in a popover ──
// The list is the user's; what ships is two worked examples and an escape
// hatch (a prompt with no text, which the page asks you for when you use it).
// Everything here edits ONE field of PageToolsSettings and hands the whole
// object back through the same SET_PAGE_TOOLS message the rest of this section
// uses, so there is no second storage path to keep in step.
const barOn = $<HTMLInputElement>('barOn');
const hlColors = $('hlColors');
const promptLang = $<HTMLInputElement>('promptLang');
const langMenu = $('langMenu');
const langOpen = $<HTMLButtonElement>('langOpen');
const promptList = $('promptList');
const promptEmpty = $('promptEmpty');
const promptCount = $('promptCount');
const promptAdd = $<HTMLButtonElement>('promptAdd');
const promptReset = $<HTMLButtonElement>('promptReset');
const promptEditor = $('promptEditor');
const promptEditorTitle = $('promptEditorTitle');
const promptName = $<HTMLInputElement>('promptName');
const promptText = $<HTMLTextAreaElement>('promptText');
const promptSave = $<HTMLButtonElement>('promptSave');
const promptCancel = $<HTMLButtonElement>('promptCancel');

/** Written from here rather than in the HTML: the example is a prompt, and a
 *  prompt full of ${…} in markup is one entity-escaping mistake from being
 *  wrong on the page that teaches people the syntax. */
promptText.placeholder =
  'Summarise the following in three bullet points, in ${lang}: """${content}"""';
$('promptExample').textContent =
  'Turn the following into an outline with headings and sub-points, in Markdown, in ' +
  '${lang}. Output only the outline: """${content}"""';

/**
 * The language box's own list.
 *
 * A `<datalist>` was the obvious control and the wrong one twice over: it draws
 * no arrow until the field has focus, so nothing said the suggestions were
 * there, and it FILTERS its options by what is already typed — so with a
 * language in the box the list came up empty, which reads as broken. This one
 * always shows every suggestion and marks the current answer. The field stays
 * free text: "formal Japanese" is a fine answer and no list would have it.
 */
langOpen.innerHTML = ICON_CARET;

function renderLangMenu(): void {
  langMenu.textContent = '';
  for (const lang of LANGUAGE_SUGGESTIONS) {
    const b = document.createElement('button');
    b.textContent = lang;
    b.className = promptLang.value.trim() === lang ? 'on' : '';
    b.addEventListener('click', () => {
      promptLang.value = lang;
      closeLangMenu();
      if (pageTools) savePageTools({ ...pageTools, lang });
    });
    langMenu.append(b);
  }
}

function openLangMenu(): void {
  renderLangMenu();
  langMenu.hidden = false;
}

function closeLangMenu(): void {
  langMenu.hidden = true;
}

langOpen.addEventListener('click', (e) => {
  e.stopPropagation();
  if (langMenu.hidden) openLangMenu();
  else closeLangMenu();
});
// Anywhere else, and Escape: a menu that only closes by picking something is a
// menu you cannot get out of.
document.addEventListener('click', (e) => {
  if (!langMenu.hidden && !(e.target as Element)?.closest?.('.combo')) closeLangMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLangMenu();
});

/** Which ask the editor is on: an id, '' for a new one, null when closed. */
let editing: string | null = null;

function renderColors(): void {
  if (!pageTools) return;
  hlColors.textContent = '';
  for (const c of HIGHLIGHT_COLORS) {
    const b = document.createElement('button');
    b.style.background = c.value;
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    b.classList.toggle('on', pageTools.defaultColor === c.name);
    b.addEventListener('click', () => {
      if (pageTools) savePageTools({ ...pageTools, defaultColor: c.name as HighlightColor });
    });
    hlColors.append(b);
  }
}

function renderPrompts(): void {
  if (!pageTools) return;
  barOn.checked = pageTools.bar;
  promptLang.value = pageTools.lang;
  promptLang.placeholder = resolveLang('');
  const list = pageTools.prompts;
  const on = list.filter((a) => a.on).length;
  promptCount.textContent = list.length ? `(${on} of ${list.length} on)` : '';
  navBadge('prompts', list.length ? String(on) : '');
  promptList.textContent = '';
  for (const a of list) {
    const row = document.createElement('div');
    row.className = 'item';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = a.on;
    toggle.title = a.on ? 'On the toolbar' : 'Kept, but not shown';
    toggle.addEventListener('change', () => {
      patchPrompts(list.map((x) => (x.id === a.id ? { ...x, on: toggle.checked } : x)));
    });
    const name = document.createElement('span');
    name.className = a.on ? 'name' : 'name off';
    name.textContent = a.label;
    const kind = document.createElement('span');
    kind.className = 'kind';
    // Whole prompt, cut by CSS: the row's width is what decides how much fits,
    // and a fixed character count either wastes the space or overflows it.
    kind.textContent = a.prompt || 'You type the question each time';
    if (!a.prompt) kind.style.fontStyle = 'italic';
    kind.title = a.prompt;
    const edit = document.createElement('button');
    edit.innerHTML = ICON_PENCIL;
    edit.title = `Edit ${a.label}`;
    edit.addEventListener('click', () => openEditor(a));
    const del = document.createElement('button');
    del.innerHTML = ICON_TRASH;
    del.title = `Delete ${a.label}`;
    del.addEventListener('click', () => {
      if (editing === a.id) closeEditor();
      patchPrompts(list.filter((x) => x.id !== a.id));
    });
    row.append(toggle, name, kind, edit, del);
    promptList.append(row);
  }
  promptEmpty.textContent = list.length
    ? ''
    : 'No prompts. The toolbar shows the wand only when there is at least one.';
}

function patchPrompts(next: SavedPrompt[]): void {
  if (pageTools) savePageTools({ ...pageTools, prompts: next });
}

function openEditor(a?: SavedPrompt): void {
  editing = a ? a.id : '';
  promptEditorTitle.textContent = a ? `Edit ${a.label}` : 'New prompt';
  promptName.value = a?.label ?? '';
  promptText.value = a?.prompt ?? '';
  promptEditor.hidden = false;
  // Optional call, like the highlighter's: a convenience, and not every
  // environment this code is exercised in has it.
  promptEditor.scrollIntoView?.({ block: 'nearest' });
  promptName.focus();
}

function closeEditor(): void {
  editing = null;
  promptEditor.hidden = true;
}

promptAdd.addEventListener('click', () => openEditor());
promptCancel.addEventListener('click', closeEditor);
promptSave.addEventListener('click', () => {
  if (!pageTools || editing === null) return;
  const label = promptName.value.trim();
  const prompt = promptText.value.trim();
  // A NAME is the requirement. An empty prompt is the open-ended kind — the
  // page asks for the instruction when it is used — so it saves like any other.
  // A missing name is said by focusing the box, not by an alert.
  if (!label) return promptName.focus();
  const list = pageTools.prompts;
  patchPrompts(
    editing
      ? list.map((x) => (x.id === editing ? { ...x, label, prompt } : x))
      : [...list, { id: `p_${Date.now().toString(36)}`, label, prompt, on: true }],
  );
  closeEditor();
});
promptReset.addEventListener('click', () => {
  closeEditor();
  patchPrompts(DEFAULT_PROMPTS);
});
barOn.addEventListener('change', () => {
  if (pageTools) savePageTools({ ...pageTools, bar: barOn.checked });
});
promptLang.addEventListener('change', () => {
  if (pageTools) savePageTools({ ...pageTools, lang: promptLang.value.trim() });
});

// Below the blocks above, not beside the other listeners: this is the only
// thing that calls renderPageTools() before a user does anything, and that
// render reads consts declared up there. (F-58 was this shape, one file over.)
refreshPageTools();

// ── Browser data — the optional permissions, granted here or nowhere ──
// `chrome.permissions.request` needs a user gesture in an extension page, so
// this popup is the only surface that can ask. The tools behind them fail with
// a message naming these switches rather than answering empty.
const permList = $('permList');
const permCount = $('permCount');

const BROWSER_DATA: Array<{ id: string; label: string; why: string }> = [
  { id: 'bookmarks', label: 'Bookmarks', why: 'find and add pages you saved' },
  { id: 'history', label: 'Browsing history', why: 'find pages you have already read' },
  { id: 'readingList', label: 'Reading list', why: 'see and add read-it-later pages' },
  { id: 'sessions', label: 'Recently closed tabs', why: 'recover a reading session' },
];

function renderPerms(granted: Set<string>): void {
  permCount.textContent = granted.size ? `(${granted.size}/${BROWSER_DATA.length})` : '';
  permList.textContent = '';
  for (const p of BROWSER_DATA) {
    const row = document.createElement('div');
    row.className = 'perm';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `perm-${p.id}`;
    box.checked = granted.has(p.id);
    box.addEventListener('change', () => {
      const want = box.checked;
      // The call must happen IN the click's gesture; re-reading the state
      // afterwards is what keeps the box honest when the user cancels Chrome's
      // own prompt (which resolves false rather than throwing).
      const done = (ok: boolean): void => {
        void chrome.runtime.lastError;
        if (!ok) box.checked = !want;
        void refreshPerms();
      };
      if (want) chrome.permissions.request({ permissions: [p.id] }, done);
      else chrome.permissions.remove({ permissions: [p.id] }, done);
    });
    const label = document.createElement('label');
    label.htmlFor = box.id;
    label.textContent = p.label;
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = `— ${p.why}`;
    row.append(box, label, why);
    permList.append(row);
  }
}

async function refreshPerms(): Promise<void> {
  const granted = new Set<string>();
  await Promise.all(
    BROWSER_DATA.map(
      (p) =>
        new Promise<void>((resolve) => {
          chrome.permissions.contains({ permissions: [p.id] }, (has) => {
            void chrome.runtime.lastError;
            if (has) granted.add(p.id);
            resolve();
          });
        }),
    ),
  );
  renderPerms(granted);
}

void refreshPerms();

// ── Site scripts — the user's fallback control over agent-created rules ──
const scriptList = $('scriptList');
const scriptsCount = $('scriptsCount');
const scriptsEmpty = $('scriptsEmpty');

function scriptKind(s: SiteScript): string {
  const parts: string[] = [];
  if (s.hideSelectors?.length) parts.push(`hide×${s.hideSelectors.length}`);
  if (s.css) parts.push('css');
  if (s.js) parts.push('js');
  return parts.join('+') || '—';
}

/** One labelled block of a site script's source (matches / selectors / css / js),
 * code set with textContent so a script's own text can never inject markup. */
function codeBlock(label: string, content: string): HTMLDivElement {
  const block = document.createElement('div');
  block.className = 'code-block';
  const lbl = document.createElement('div');
  lbl.className = 'code-label';
  lbl.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = content;
  block.append(lbl, pre);
  return block;
}

function renderScripts(scripts: SiteScript[]): void {
  scriptList.textContent = '';
  scriptsCount.textContent = scripts.length ? `(${scripts.length})` : '';
  scriptsEmpty.style.display = scripts.length ? 'none' : '';
  for (const s of scripts) {
    const entry = document.createElement('div');
    entry.className = 'script-entry';

    const row = document.createElement('div');
    row.className = 'item';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = s.enabled;
    toggle.title = s.enabled ? 'Enabled — click to pause' : 'Paused — click to enable';
    toggle.addEventListener('change', () => {
      chrome.runtime.sendMessage(
        { type: 'SET_SITE_SCRIPT_ENABLED', id: s.id, enabled: toggle.checked },
        () => {
          void chrome.runtime.lastError;
          refreshScripts();
        },
      );
    });
    const name = document.createElement('span');
    name.className = 'name' + (s.enabled ? '' : ' off');
    name.textContent = s.label;
    name.title = `${s.label}\n${s.matches.join('\n')}`;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = scriptKind(s);

    // View the FULL source — persistent injected code must be inspectable, not
    // just summarised. Tap to expand (mobile-first: no hover-only reveal).
    const code = document.createElement('div');
    code.className = 'script-code';
    code.hidden = true;
    code.append(codeBlock('Matches', s.matches.join('\n')));
    if (s.hideSelectors?.length) code.append(codeBlock('Hidden selectors', s.hideSelectors.join('\n')));
    if (s.css) code.append(codeBlock('CSS', s.css));
    if (s.js) code.append(codeBlock(s.llmAccess ? 'JS · can call the LLM' : 'JS', s.js));

    const view = document.createElement('button');
    view.innerHTML = ICON_CODE;
    view.title = 'View code';
    view.setAttribute('aria-expanded', 'false');
    view.addEventListener('click', () => {
      code.hidden = !code.hidden;
      view.setAttribute('aria-expanded', String(!code.hidden));
      view.classList.toggle('active', !code.hidden);
    });

    const del = document.createElement('button');
    del.innerHTML = ICON_TRASH;
    del.title = `Delete "${s.label}"`;
    del.addEventListener('click', () => {
      // The same dialog: one page, one way of asking.
      void askConfirm({
        title: 'Delete this site script?',
        body: `“${s.label}” — it will stop running on ${s.matches.join(', ')}.`,
        ok: 'Delete',
      }).then((yes) => {
        if (!yes) return;
        chrome.runtime.sendMessage({ type: 'DELETE_SITE_SCRIPT', id: s.id }, () => {
          void chrome.runtime.lastError;
          refreshScripts();
        });
      });
    });
    row.append(toggle, name, kind, view, del);
    entry.append(row, code);
    scriptList.append(entry);
  }
}

function refreshScripts(): void {
  try {
    chrome.runtime.sendMessage(
      { type: 'LIST_SITE_SCRIPTS' },
      (resp?: { scripts?: SiteScript[] }) => {
        void chrome.runtime.lastError; // SW may be waking — next poll retries
        if (resp?.scripts) renderScripts(resp.scripts);
      },
    );
  } catch {
    /* ignore — next poll retries */
  }
}

// ── Status: only the one thing a user can get wrong ──
// With the origin list compiled in, "Allow user scripts" is it. The dev build
// additionally has a daemon, and only that build has a row for it.
interface Status {
  siteScriptsRunnable?: boolean;
  dev?: boolean;
  connected?: boolean;
  port?: number;
}

function poll(): void {
  try {
    chrome.runtime.sendMessage({ type: 'LOCALMD_STATUS' }, (resp?: Status) => {
      void chrome.runtime.lastError;
      if (!resp) return;
      userScriptsWarn.classList.toggle('show', resp.siteScriptsRunnable === false);
      if (resp.dev) {
        // A dev build has one more topic; the nav grows with it.
        setSectionAvailable('cliSetup', true);
        daemonHint.textContent = resp.connected
          ? `Daemon connected (port ${resp.port}).`
          : `No daemon connected (port ${resp.port}).`;
      }
    });
  } catch {
    /* next tick */
  }
}

poll();
refreshScripts();
const timer = setInterval(poll, 2000);
window.addEventListener('unload', () => clearInterval(timer));
