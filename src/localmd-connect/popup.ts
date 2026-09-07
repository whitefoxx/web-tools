/**
 * localmd Connect's popup: about the page you are on, and nothing else.
 *
 * It used to be three things at once — an onboarding card, a settings page and
 * an action launcher — all visible on every open. Settings now live on their
 * own page (options.html), reached from the gear, because a settings page is
 * read rarely and carefully while a popup is opened for one quick thing.
 *
 * What remains is the quick thing, in the order it is asked: what IS this page
 * and does the folder already have it, then what can be done about it.
 */

import {
  ICON_ASK,
  ICON_CARET,
  ICON_CLIP,
  ICON_FOLDER,
  ICON_FULLPAGE,
  ICON_IN_KB,
  ICON_MARK,
  ICON_OPEN_APP,
  ICON_REGION,
  ICON_SETTINGS,
} from './ui-icons';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

$('ver').textContent = 'v' + chrome.runtime.getManifest().version;
$('icoClip').innerHTML = ICON_CLIP;
$('icoRegion').innerHTML = ICON_REGION;
$('icoFull').innerHTML = ICON_FULLPAGE;
$('icoAsk').innerHTML = ICON_ASK;
$('icoFolder').innerHTML = ICON_FOLDER;
$('icoCaret').innerHTML = ICON_CARET;
$('icoMarks').innerHTML = ICON_MARK;
$('openApp').innerHTML = ICON_OPEN_APP;
$('openOptions').innerHTML = ICON_SETTINGS;

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

/**
 * Somewhere to read every passage you have marked, and to get back to it.
 *
 * A tab rather than the popup: a list you browse must outlive a click
 * elsewhere, and the popup dies the moment focus leaves it.
 *
 * The path comes from the MANIFEST, never spelled out here. The bundler emits
 * these pages at their source path (`src/localmd-connect/options.html`), so a
 * hand-written `options.html` is a URL that has never existed — and it fails as
 * a blank tab with no error anywhere.
 */
export function optionsUrl(page: string, pageUrl?: string): string {
  const q = pageUrl ? `?page=${encodeURIComponent(pageUrl)}` : '';
  return chrome.runtime.getURL(`${page}${q}#annotations`);
}

function openAnnotations(pageUrl?: string): void {
  const page = chrome.runtime.getManifest().options_ui?.page;
  if (!page) {
    chrome.runtime.openOptionsPage(); // no query, but it opens
    window.close();
    return;
  }
  void chrome.tabs.create({ url: optionsUrl(page, pageUrl) });
  window.close();
}
$('openMarks').addEventListener('click', () => openAnnotations());

// "Take me to localmd" — the open tab if there is one, a new one if not. The
// service worker decides which, because it is the side that knows the origins
// this build talks to.
$('openApp').addEventListener('click', () => {
  try {
    chrome.runtime.sendMessage({ type: 'LOCALMD_OPEN_APP' }, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  } catch {
    window.close();
  }
});

/* ── ⓪ which knowledge base ──────────────────────────────────────────────── */

/**
 * The folder every button below writes into, and a way to change it.
 *
 * Mirrored from localmd (`sync_kb_folders`), never decided here: a File System
 * Access handle belongs to the page it was granted to, so the extension cannot
 * open a folder even if it wanted to. Picking one sends a request and takes the
 * user to localmd, which is also where a lapsed permission prompt has to be
 * answered. The name shown is therefore always what IS open, not what was last
 * asked for.
 */
const kbCurrent = $<HTMLButtonElement>('kbCurrent');
const kbName = $('kbName');
const kbList = $<HTMLUListElement>('kbList');

/* ── floating menus ──────────────────────────────────────────────────────── */

/**
 * Every menu that floats over the buttons, and the one rule they share: only
 * one is open, and any click that is not inside one closes it. A menu drawn on
 * top of the capture buttons would otherwise swallow the click the user meant.
 */
const openMenus: HTMLElement[] = [];

function setMenu(list: HTMLElement, open: boolean): void {
  for (const m of openMenus) if (m !== list) m.hidden = true;
  list.hidden = !open;
  const trigger = list.previousElementSibling;
  if (trigger) trigger.setAttribute('aria-expanded', String(open));
}

function closeMenus(): void {
  for (const m of openMenus) m.hidden = true;
  kbCurrent.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  const inside =
    e.target instanceof Node && openMenus.some((m) => m.parentElement?.contains(e.target as Node));
  if (!inside) closeMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
});

interface KbState {
  folders: string[];
  current: string | null;
}

let kb: KbState = { folders: [], current: null };
openMenus.push(kbList);

/** The five palette colours, kept in step with page-settings' HIGHLIGHT_COLORS
 *  — inlined rather than imported so the popup bundle stays free of the
 *  content-script modules. */
const MARK_COLORS: Record<string, string> = {
  yellow: '#FFD633',
  green: '#7ED67E',
  blue: '#57B7F0',
  pink: '#FF8AAE',
  purple: '#BB8AEA',
};
const colorOf = (name?: string): string => MARK_COLORS[name ?? ''] ?? MARK_COLORS.yellow;

function renderKb(): void {
  kbName.textContent = kb.current ?? (kb.folders.length ? 'None open' : 'localmd not connected');
  kbName.classList.toggle('none', !kb.current);
  const switchable = kb.folders.length > 0;
  kbCurrent.disabled = !switchable;
  if (!switchable) setKbOpen(false);
  kbList.textContent = '';
  for (const name of kb.folders) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = `kb-item${name === kb.current ? ' on' : ''}`;
    b.textContent = name;
    b.addEventListener('click', () => pickKb(name));
    li.append(b);
    kbList.append(li);
  }
}

/**
 * Ask localmd to open another folder, and stay here to see whether it did.
 *
 * The popup does NOT jump to localmd for this. Switching a folder is a thing
 * you do on your way to capturing something on THIS page; being thrown into
 * another tab loses the page you were on, which is the opposite of the point.
 * localmd switches in the background and its next `sync_kb_folders` updates the
 * name above — so the confirmation appears where the request was made.
 */
function pickKb(name: string): void {
  setKbOpen(false);
  if (name === kb.current) return;
  kbName.textContent = `${name}…`;
  try {
    chrome.runtime.sendMessage(
      { type: 'LOCALMD_OPEN_KB', name },
      (resp?: { ok?: boolean; error?: string }) => {
        void chrome.runtime.lastError;
        if (resp?.ok === false) {
          actionNote.textContent = resp.error ?? 'localmd could not be reached.';
          renderKb();
          return;
        }
        // Opening a folder takes a moment (and can need a permission prompt in
        // localmd). Look a few times rather than once, then let the 2s poll
        // carry it.
        for (const ms of [300, 900, 1800]) setTimeout(refreshKb, ms);
      },
    );
  } catch {
    actionNote.textContent = 'The extension is waking up — try again.';
    renderKb();
  }
}

function setKbOpen(open: boolean): void {
  setMenu(kbList, open);
}

kbCurrent.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(kbList, kbList.hidden);
});

function refreshKb(): void {
  try {
    chrome.runtime.sendMessage({ type: 'LOCALMD_KB_STATE' }, (resp?: KbState) => {
      void chrome.runtime.lastError;
      if (resp && Array.isArray(resp.folders)) {
        kb = { folders: resp.folders, current: resp.current ?? null };
        renderKb();
      }
    });
  } catch {
    /* the worker is waking; the row keeps its placeholder */
  }
}
$<HTMLButtonElement>('openSettings').addEventListener('click', () => {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

/* ── ① this page ─────────────────────────────────────────────────────────── */

const pageTitle = $('pageTitle');
const pageHost = $('pageHost');
const pageStatus = $('pageStatus');
const pageState = $('pageState');
const actionNote = $('actionNote');
const dot = $('dot');
const statusText = $('statusText');
const userScriptsWarn = $('userScriptsWarn');

interface PageMark {
  id: string;
  exact: string;
  color?: string;
  note?: string;
}

interface PageState {
  url: string;
  title: string;
  capturable: boolean;
  entry: { path: string; at: number; title?: string } | null;
  highlights: number;
  /** The passages themselves, capped by the worker. */
  marks?: PageMark[];
  pending: number;
}

const captureButtons: Array<[HTMLButtonElement, string]> = [
  [$<HTMLButtonElement>('clipPage'), 'clip_page'],
  [$<HTMLButtonElement>('shotRegion'), 'screenshot_region'],
  [$<HTMLButtonElement>('shotPage'), 'screenshot_page'],
  [$<HTMLButtonElement>('askPage'), 'ask_page'],
];

/**
 * The tab this popup belongs to.
 *
 * Asked HERE and passed to the service worker, never asked from there: a popup
 * can say `currentWindow` and mean it, while the worker's `lastFocusedWindow`
 * can resolve to the popup's own surface while it has focus — and then the
 * extension concludes the user is on no page, which is how every button in this
 * popup once came to do nothing at all (findings F-56).
 */
async function ownTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function chip(cls: string, icon: string, text: string, tag: 'span' | 'button' = 'span'): HTMLElement {
  const el = document.createElement(tag);
  el.className = `chip ${cls}`;
  if (icon) {
    const i = document.createElement('span');
    i.innerHTML = icon;
    el.append(i);
  }
  el.append(document.createTextNode(text));
  return el;
}

function renderPage(s: PageState | null): void {
  if (!s) return;
  // The page section is rebuilt below, so any menu inside it is about to be
  // detached — forget it rather than leaving a dead node in the list.
  for (let i = openMenus.length - 1; i >= 0; i--) {
    if (openMenus[i] !== kbList) openMenus.splice(i, 1);
  }
  pageTitle.textContent = s.title || s.url || 'This tab';
  pageHost.textContent = hostOf(s.url);
  // Whether the folder has this page sits ON the host line: it is the same
  // thought as where the page came from, and a one-word answer does not deserve
  // a line of its own. Anything longer (the note's path) goes below.
  pageStatus.textContent = '';
  pageState.textContent = '';

  if (s.url && !s.capturable) {
    pageStatus.append(chip('plain', '', 'Not a web page'));
  } else if (s.entry) {
    pageStatus.append(
      chip('saved', ICON_IN_KB, `Saved ${new Date(s.entry.at).toLocaleDateString()}`),
    );
    const path = document.createElement('div');
    path.className = 'path';
    path.textContent = s.entry.path;
    pageState.append(path);
  } else if (s.url) {
    pageStatus.append(chip('plain', '', 'Not saved yet'));
  }
  if (s.capturable && s.highlights) pageState.append(marksMenu(s));

  // FAIL OPEN: disabled only when the URL is KNOWN and is not a web page. One
  // unreadable tab must not turn the popup into a surface that answers no click.
  const known = !!s.url;
  for (const [b] of captureButtons) b.disabled = known && !s.capturable;
  actionNote.textContent = s.pending
    ? `${s.pending} capture${s.pending === 1 ? '' : 's'} waiting for localmd.`
    : '';
}

/**
 * This page's highlights, as a menu that jumps to them.
 *
 * A count is a question — which ones, and where? Answering it by opening
 * another page was a detour: the marks are on the tab right behind this popup,
 * so the answer belongs here and a click should land on the passage. The
 * annotations page is still one row away, for the pages that are not this one.
 */
function marksMenu(s: PageState): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'marks-wrap';
  const button = chip(
    'marks',
    ICON_MARK,
    `${s.highlights} highlight${s.highlights === 1 ? '' : 's'}`,
    'button',
  ) as HTMLButtonElement;
  button.title = 'Jump to a passage you marked on this page';
  const list = document.createElement('ul');
  list.className = 'mark-menu';
  list.hidden = true;

  for (const m of s.marks ?? []) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.className = 'mark-row';
    row.title = 'Scroll to this passage';
    const dot = document.createElement('span');
    dot.className = 'mark-dot';
    dot.style.background = colorOf(m.color);
    const body = document.createElement('span');
    body.className = 'mark-body';
    const quote = document.createElement('div');
    quote.className = 'mark-quote';
    quote.textContent = m.exact;
    body.append(quote);
    if (m.note) {
      const note = document.createElement('div');
      note.className = 'mark-note';
      note.textContent = m.note;
      body.append(note);
    }
    row.append(dot, body);
    row.addEventListener('click', () => jumpToMark(m.id));
    li.append(row);
    list.append(li);
  }

  const all = document.createElement('button');
  all.className = 'mark-all';
  const shown = (s.marks ?? []).length;
  all.textContent =
    shown < s.highlights ? `All ${s.highlights} on this page and elsewhere` : 'All annotations';
  all.addEventListener('click', () => openAnnotations(s.url));
  const allLi = document.createElement('li');
  allLi.append(all);
  list.append(allLi);

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(list, list.hidden);
  });
  wrap.append(button, list);
  openMenus.push(list);
  return wrap;
}

/** Take the tab behind this popup to that passage. The content script owns the
 *  scroll — it is the only side that knows where the mark ended up after
 *  re-anchoring. */
function jumpToMark(id: string): void {
  void ownTab().then((tab) => {
    if (!tab || typeof tab.id !== 'number') return;
    chrome.tabs.sendMessage(tab.id, { type: 'LOCALMD_FOCUS_HIGHLIGHT', id }, () => {
      // No content script on this page (blacklisted, or injected before the
      // last extension reload): say so rather than closing on nothing.
      if (chrome.runtime.lastError) {
        actionNote.textContent = 'Reload the page to reach its highlights.';
        return;
      }
      window.close();
    });
  });
}

function refreshPage(): void {
  void ownTab().then((tab) => {
    try {
      chrome.runtime.sendMessage(
        { type: 'LOCALMD_PAGE_STATE', tabId: tab?.id },
        (resp?: PageState) => {
          void chrome.runtime.lastError;
          if (resp) renderPage(resp);
        },
      );
    } catch {
      /* the worker is waking; the buttons stay usable either way */
    }
  });
}

/* ── ② what to do with it ────────────────────────────────────────────────── */

/** Actions that need the popup OUT OF THE WAY: a region capture is drawn on the
 *  page this popup covers, and an ask moves the user to localmd. Both close as
 *  soon as the message is dispatched — waiting for the reply means waiting for
 *  the drag to finish with the popup sitting on top of it. */
const CLOSE_AT_ONCE = new Set(['screenshot_region', 'ask_page', 'ask_selection']);

function runCapture(action: string, working: string): void {
  const all = captureButtons.map(([b]) => b);
  for (const b of all) b.disabled = true;
  actionNote.textContent = working;
  void ownTab().then((tab) => {
    if (!tab || typeof tab.id !== 'number') {
      for (const b of all) b.disabled = false;
      actionNote.textContent = 'Could not tell which tab this is about.';
      return;
    }
    chrome.runtime.sendMessage(
      { type: 'LOCALMD_CAPTURE', action, tabId: tab.id },
      (resp?: { ok: boolean; error?: string }) => {
        void chrome.runtime.lastError;
        for (const b of all) b.disabled = false;
        if (!resp) actionNote.textContent = 'The extension is waking up — try again.';
        else if (!resp.ok) actionNote.textContent = resp.error ?? 'That did not work.';
        else {
          actionNote.textContent = 'Done — the page says so too.';
          refreshPage();
        }
      },
    );
    if (CLOSE_AT_ONCE.has(action)) window.close();
  });
}

const WORKING: Record<string, string> = {
  clip_page: 'Clipping…',
  screenshot_region: 'Drag on the page…',
  screenshot_page: 'Capturing the whole page…',
  ask_page: 'Opening localmd…',
};

for (const [btn, action] of captureButtons) {
  btn.addEventListener('click', () => runCapture(action, WORKING[action] ?? 'Working…'));
}

/* ── ③ the one thing that can be wrong ───────────────────────────────────── */

function poll(): void {
  try {
    chrome.runtime.sendMessage(
      { type: 'LOCALMD_STATUS' },
      (resp?: { siteScriptsRunnable?: boolean }) => {
        void chrome.runtime.lastError;
        const runnable = resp?.siteScriptsRunnable !== false;
        dot.classList.toggle('on', !!resp && runnable);
        statusText.textContent = !resp ? 'Checking…' : runnable ? 'Ready' : 'One switch away';
        userScriptsWarn.classList.toggle('show', resp?.siteScriptsRunnable === false);
      },
    );
  } catch {
    /* next tick */
  }
}

poll();
refreshPage();
refreshKb();
const timer = setInterval(() => {
  poll();
  refreshKb(); // localmd may have switched folders while this popup is open
}, 2000);
window.addEventListener('unload', () => clearInterval(timer));
