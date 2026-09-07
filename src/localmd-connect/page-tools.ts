/**
 * The in-page highlighter — localmd Connect's only injection into ordinary
 * pages, and the third layer of "the browser as a context container"
 * (docs/localmd-connect.md §14.1): what the user marked while reading.
 *
 * It is NOT the full shell's selection toolbar (src/content/selection-toolbar.ts).
 * What it keeps from that one is the machinery that was hard to get right — the
 * shadow-root UI, the TextQuote anchoring in `selection/anchor.ts`, and the
 * restore-on-revisit loop — and what it adds is the part a knowledge base
 * needs: a colour, a note, and two ways to hand the passage to localmd.
 *
 * It also runs that toolbar's one-shot LLM actions (Translate / Explain), but
 * borrowed rather than owned: this shell holds no API key and runs no model, so
 * the question goes down the relay and localmd's model answers it
 * (`./ask-model.ts`, docs/localmd-connect.md §14.4o). The recipes themselves
 * are the full shell's, because a prompt is data — see DEFAULT_PAGE_ACTIONS.
 *
 * Highlights do NOT push into the capture inbox. Twenty highlights on one page
 * would be twenty pokes and twenty drains for something the user is not asking
 * anyone to act on yet. They are a WORKING COPY here; they become knowledge
 * base content when a clip is written (clip_page carries the page's highlights)
 * or when localmd asks (get_highlights). That is the same "recall is a view or
 * a note, never a record" rule the inbox follows, applied one layer out.
 *
 * Top frame only, and never in an editable field: this is a reading tool.
 */
import {
  buildTextIndex,
  describeRange,
  findQuote,
  hlSelector,
  segmentsFromSpan,
  unwrapById,
  wrapSegments,
  HL_CLASS,
} from '../selection/anchor';
import {
  addHighlight,
  loadHighlights,
  makeHighlightId,
  pageKey,
  removeHighlight,
  takeHighlightFocus,
  updateHighlight,
} from '../selection/highlights-store';
import {
  HIGHLIGHT_COLORS,
  loadPageTools,
  resolveLang,
  runsOn,
  watchPageTools,
  type HighlightColor,
  type PageToolsSettings,
  type SavedPrompt,
} from './page-settings';
import { clampSelection, fillPromptTemplate } from '../selection/prompt';
import { renderMarkdown } from './mini-markdown';
import {
  ICON_ASK,
  ICON_CARET,
  ICON_CLIP,
  ICON_PENCIL,
  ICON_PIN,
  ICON_REFRESH,
  ICON_SPARK,
  ICON_TRASH,
} from './ui-icons';

export {};

const MAX_HL_CHARS = 4000;
const MAX_NOTE_CHARS = 2000;
/** How long to keep re-checking the URL for a soft (SPA) navigation. A poll
 *  rather than a History hook: a hook misses `replaceState` inside frameworks
 *  that patch it, and this costs one string compare every two seconds. */
const URL_POLL_MS = 2000;
const RESTORE_RETRY_MS = 2500;

const w = window as unknown as { __localmdPageTools?: boolean };
if (window.top === window && !w.__localmdPageTools) {
  w.__localmdPageTools = true;
  void start();
}

async function start(): Promise<void> {
  let settings: PageToolsSettings = await loadPageTools();
  let active = runsOn(location.href, settings);

  watchPageTools((next) => {
    settings = next;
    const nowActive = runsOn(location.href, settings);
    if (nowActive === active) return;
    active = nowActive;
    if (active) void restore();
    else teardown();
  });

  /* ── UI shell: a shadow root, so no page stylesheet can reach it ── */

  let host: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let bar: HTMLDivElement | null = null;
  /** When a bar button (swatch / prompt / icon) was last pressed. The click's
   *  trailing `mouseup` can land off the bar (the action hides it, or the
   *  selection shifts under it) and the document mouseup listener would then
   *  re-show a bar over the still-live selection — the passage the user JUST
   *  acted on. That re-show was the "first click never dismisses, second does"
   *  bug (the re-shown bar was the mark bar, which hides synchronously). A press
   *  stamps this; the mouseup listener ignores a re-show for a moment after. */
  let barActionAt = 0;
  /** The hover note popover. Declared HERE, beside the bar, because showBar and
   *  showMarkBar take it away when they open — and a `let` read before its
   *  declaration has run is a TDZ error, which is findings F-58 verbatim. */
  let peek: HTMLElement | null = null;
  function hidePeek(): void {
    peek?.remove();
    peek = null;
  }
  /** The quick action's answer. One at a time — a second question replaces the
   *  first, the way asking again replaces the answer you were reading. */
  let panel: HTMLDivElement | null = null;
  /** Where the answer hangs: the passage it is about, in PAGE coordinates.
   *
   *  Page and not viewport because the answer arrives seconds later and the
   *  reader may well have scrolled in the meantime — re-placing the grown
   *  panel against a stale viewport rect would fling it somewhere unrelated.
   *  Kept beside `panel` (and not next to the function that reads it) for the
   *  reason `peek` is: a `let` read before its declaration has run is F-58 all
   *  over again. */
  let panelAnchor: DOMRect | null = null;
  /** The open "type your question" box, so a click on the page can dismiss an
   *  EMPTY one. Declared here with the other floating things for the reason
   *  `peek` is (F-58). */
  let askBox: { empty: () => boolean; dismiss: () => void } | null = null;
  function hidePanel(): void {
    panel?.remove();
    panel = null;
    panelAnchor = null;
    hideScan();
  }

  /** The boxes drawn over the passage while it is being worked on. */
  let scan: HTMLElement[] = [];
  function hideScan(): void {
    for (const el of scan) el.remove();
    scan = [];
  }

  /**
   * Light up the passage, and leave it lit.
   *
   * Drawn OVER the page, one box per line, rather than wrapped around its text:
   * a transient effect must not touch a page's own DOM, and `getClientRects`
   * hands over the line boxes for free. It stays up for as long as the popover
   * about that passage does — the mark is what ties the two together, and
   * `working` only changes how the same boxes look while the model is busy.
   */
  function showScan(rects: DOMRect[], working = false): void {
    hideScan();
    if (!rects.length) return;
    const sh = ensureShell();
    for (const r of rects) {
      const el = document.createElement('div');
      el.className = working ? 'scan working' : 'scan';
      el.style.left = `${Math.round(r.left)}px`;
      el.style.top = `${Math.round(r.top)}px`;
      el.style.width = `${Math.round(r.width)}px`;
      el.style.height = `${Math.round(r.height)}px`;
      sh.appendChild(el);
      scan.push(el);
    }
  }

  /** Change how the boxes look without rebuilding them — repainting would put a
   *  flash exactly where the eye already is. */
  function markScan(cls: 'working' | 'hot', on: boolean): void {
    for (const el of scan) el.classList.toggle(cls, on);
  }

  // NO BACKTICKS IN THIS LITERAL. It is a template string, and one closes it
  // mid-stylesheet — which the bundler reports as a JS syntax error twenty
  // lines away from the CSS that caused it. Name selectors in prose.
  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", sans-serif; }
    /* align-items:stretch + gap:0 so every child fills the bar's full height and
       the children TILE the row edge-to-edge: no 2px gaps and no strips above or
       below a short child where a click lands on the bar itself (no handler) and
       "some colours / prompts do nothing, and the bar just sits there". Spacing
       lives inside each child's padding now, not in a dead gap (F-63 redux). */
    .bar {
      position: absolute; z-index: 2147483646; display: flex; align-items: stretch; gap: 0;
      box-sizing: content-box;
      background: #23272e; color: #e8eaed; border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px; padding: 4px; box-shadow: 0 4px 18px rgba(0,0,0,.28);
      user-select: none; white-space: nowrap;
    }
    .bar button {
      all: unset; cursor: pointer; font-size: 12.5px; line-height: 1; color: #e8eaed;
      display: flex; align-items: center; justify-content: center;
      padding: 6px 9px; border-radius: 7px;
    }
    .bar button:hover { background: rgba(255,255,255,.12); }
    /* .bar button.icon, not .icon: the .bar button rule above uses all:unset,
       which resets EVERY property and wins on specificity — the same trap the
       swatches fell into (F-63). Everything this needs is restated. */
    .bar button.icon {
      all: unset; cursor: pointer; display: flex; align-items: center; justify-content: center;
      gap: 1px; color: #e8eaed; padding: 6px 7px; border-radius: 7px;
    }
    .bar button.icon:hover { background: rgba(255,255,255,.12); }
    .bar button.icon svg { display: block; }
    /* The caret rides small and dim beside the wand: it is a hint that there is
       a list, not a second control. */
    .bar button.icon svg + svg { width: 11px; height: 11px; opacity: .6; margin-left: -1px; }
    .menu {
      position: absolute; top: 100%; left: 0; margin-top: 6px; z-index: 2147483647;
      min-width: 132px; max-width: 240px; padding: 4px;
      background: #23272e; color: #e8eaed; border: 1px solid rgba(255,255,255,.08);
      border-radius: 9px; box-shadow: 0 8px 26px rgba(0,0,0,.35);
      display: flex; flex-direction: column; gap: 1px;
    }
    .menu button {
      all: unset; cursor: pointer; display: block; font-size: 12.5px; line-height: 1.3;
      color: #e8eaed; padding: 7px 10px; border-radius: 6px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .menu button:hover { background: rgba(255,255,255,.12); }
    /* One box per line of the passage, drawn OVER the page rather than wrapped
       around its text: a transient effect must not touch a page's own DOM, and
       Range.getClientRects gives the line boxes for free. Below the bar's
       z-index so it never covers the controls. */
    /* The passage stays marked for as long as the popover about it is open —
       the mark is what ties the two together, and it was disappearing at the
       exact moment the answer arrived and you wanted to compare them. Three
       states on the same boxes, so nothing is rebuilt and nothing flashes:
       steady (open), working (a sweep), hot (the quote is hovered). */
    .scan {
      position: absolute; z-index: 2147483644; pointer-events: none; overflow: hidden;
      border-radius: 3px; background: rgba(88,166,255,.17);
      box-shadow: 0 0 0 1px rgba(88,166,255,.28);
      transition: background .15s ease, box-shadow .15s ease;
    }
    .scan.working { background: rgba(88,166,255,.22); }
    .scan.working::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(100deg,
        rgba(255,255,255,0) 25%, rgba(255,255,255,.55) 50%, rgba(255,255,255,0) 75%);
      transform: translateX(-110%);
      animation: localmd-scan 1.15s ease-in-out infinite;
    }
    .scan.hot { background: rgba(88,166,255,.38); box-shadow: 0 0 0 1px rgba(88,166,255,.6); }
    @keyframes localmd-scan { to { transform: translateX(110%); } }
    /* The passage the answer is about, kept in the panel: the scan goes away
       when the answer arrives, and comparing a translation with its original is
       exactly the moment you need to see the original. */
    .panel .quote {
      display: flex; gap: 8px; align-items: stretch;
      padding: 8px 12px 0; font-size: 12px; color: #9aa0a6; cursor: pointer;
    }
    .panel .quote i {
      flex: 0 0 auto; width: 2px; min-height: 15px; border-radius: 1px;
      background: rgba(88,166,255,.65);
    }
    .panel .quote span {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: italic;
    }
    .panel .quote:hover span { color: #c9ced6; }
    .bar .sep { align-self: center; width: 1px; height: 16px; background: rgba(255,255,255,.12); margin: 0 3px; }
    /* .bar .swatch, not .swatch: '.bar button' above is MORE SPECIFIC, and its
       all:unset resets EVERY property — so every property the swatch needs is
       restated here (findings F-63). The 16px circle is now an inner .dot; the
       BUTTON is a full-height, padded hit area with NO margin, so swatches tile
       the row edge-to-edge — the target is the whole cell, not just the ink, and
       there is nowhere between or around the circles for a click to fall through
       (the recurring "clicking some colours does nothing / the bar just sits
       there"). */
    .bar .swatch {
      all: unset; cursor: pointer; flex: 0 0 auto; box-sizing: border-box;
      display: flex; align-items: center; justify-content: center;
      padding: 4px; border-radius: 7px;
    }
    .bar .swatch .dot {
      width: 16px; height: 16px; border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(0,0,0,.35) inset;
    }
    .bar .swatch:hover { background: rgba(255,255,255,.10); }
    .bar .swatch:hover .dot { outline: 2px solid rgba(255,255,255,.55); outline-offset: 1px; }
    .note {
      position: absolute; z-index: 2147483646; width: 320px; max-width: calc(100vw - 24px);
      background: #23272e; color: #e8eaed; border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.35); padding: 8px;
    }
    .note textarea {
      all: unset; display: block; width: 100%; min-height: 68px; font-size: 13px;
      line-height: 1.55; color: #e8eaed; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .note .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
    .note button {
      all: unset; cursor: pointer; font-size: 12px; padding: 5px 10px; border-radius: 6px;
      color: #e8eaed; background: rgba(255,255,255,.10);
    }
    .note button:hover { background: rgba(255,255,255,.18); }
    /* WIDTH, not max-width: the shadow host is a 0x0 box, so an absolutely
       positioned child shrinks to fit an available width of ZERO — which is
       one character per line, and read as "why is the note vertical". Sizing to
       max-content asks for the natural single-line width first, and the cap
       then wraps it like ordinary prose. */
    .peek {
      position: absolute; z-index: 2147483645;
      width: max-content; max-width: min(320px, 78vw);
      background: #23272e; color: #e8eaed; border: 1px solid rgba(255,255,255,.08);
      border-radius: 9px; padding: 8px 11px; font-size: 12.5px; line-height: 1.5;
      box-shadow: 0 6px 22px rgba(0,0,0,.3); white-space: pre-wrap;
      overflow-wrap: anywhere; pointer-events: none;
    }
    .toast {
      position: absolute; z-index: 2147483646; background: #23272e; color: #e8eaed;
      border-radius: 8px; padding: 7px 11px; font-size: 12.5px;
      width: max-content; max-width: min(320px, 78vw);
      box-shadow: 0 4px 18px rgba(0,0,0,.28);
    }
    /* The answer to a quick action. Sized like something you READ — wider than
       the note editor and scrollable — because an explanation runs longer than
       the passage it is about. */
    .panel {
      position: absolute; z-index: 2147483646; width: 380px; max-width: calc(100vw - 24px);
      background: #23272e; color: #e8eaed; border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.35);
    }
    .panel .head {
      display: flex; align-items: center; gap: 4px; padding: 7px 8px 5px 11px;
      border-bottom: 1px solid rgba(255,255,255,.07);
      cursor: move; user-select: none;
    }
    .panel .head .title { flex: 1; font-size: 12px; font-weight: 600; color: #e8eaed; }
    /* .panel .head button, not .panel button: the head sets cursor:move, and a
       descendant selector of equal specificity would lose to it on source
       order, leaving the buttons claiming to be a drag handle (F-63's lesson,
       one rule over). */
    .panel .head button {
      all: unset; cursor: pointer; color: #9aa0a6; font-size: 12px; line-height: 1;
      padding: 4px 6px; border-radius: 6px;
    }
    .panel .head button:hover { background: rgba(255,255,255,.12); color: #e8eaed; }
    .panel .head button.pin.on { color: #ffd54f; }
    .panel .head button.go { color: #7ab6ff; }
    .panel .head button.go:hover { background: rgba(122,182,255,.16); color: #a9d0ff; }
    /* .panel .head .tag beats .panel .head button on specificity, and restates
       everything it needs — the all:unset lesson from F-63. */
    .panel .head .tag {
      all: unset; cursor: pointer; flex: 0 0 auto;
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 10.5px; line-height: 1.5; color: #9aa0a6;
      border: 1px solid rgba(255,255,255,.18); border-radius: 999px; padding: 1px 7px 1px 5px;
    }
    .panel .head .tag svg { display: block; width: 11px; height: 11px; }
    .panel .head .tag:hover { color: #e8eaed; border-color: rgba(255,255,255,.45); }
    .panel .head button svg { display: block; }
    .panel .body {
      padding: 10px 12px 12px; font-size: 13px; line-height: 1.6;
      white-space: pre-wrap; overflow-wrap: anywhere; max-height: 46vh; overflow: auto;
      user-select: text;
    }
    .panel .body.loading { color: #9aa0a6; display: flex; align-items: center; gap: 8px; }
    /* The rendered answer. Tight margins: this is a popover over somebody's
       paragraph, not a document, so the space between two bullets matters more
       than it would in a page. */
    .panel .body.md { white-space: normal; }
    .panel .body.md > :first-child { margin-top: 0; }
    .panel .body.md > :last-child { margin-bottom: 0; }
    .panel .body.md p { margin: 0 0 8px; }
    .panel .body.md ul, .panel .body.md ol { margin: 0 0 8px; padding-left: 20px; }
    .panel .body.md li { margin: 2px 0; }
    .panel .body.md .md-h { font-weight: 600; margin: 10px 0 5px; }
    .panel .body.md blockquote {
      margin: 0 0 8px; padding-left: 9px; color: #b6bcc6;
      border-left: 2px solid rgba(255,255,255,.2);
    }
    .panel .body.md code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
      background: rgba(255,255,255,.1); padding: 1px 4px; border-radius: 4px;
    }
    .panel .body.md pre {
      margin: 0 0 8px; padding: 8px 10px; border-radius: 7px; overflow-x: auto;
      background: rgba(0,0,0,.3);
    }
    .panel .body.md pre code { background: none; padding: 0; }
    .panel .body.md a { color: #7ab6ff; }
    .spin {
      width: 11px; height: 11px; border-radius: 50%; flex: 0 0 auto;
      border: 2px solid rgba(255,255,255,.25); border-top-color: rgba(255,255,255,.8);
      animation: localmd-spin .8s linear infinite;
    }
    @keyframes localmd-spin { to { transform: rotate(360deg); } }
  `;

  function ensureShell(): ShadowRoot {
    if (shadow) return shadow;
    host = document.createElement('div');
    host.setAttribute('data-localmd-page-tools', '');
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
    return shadow;
  }

  /** Mark styling lives in the PAGE, not the shadow root — the marks wrap the
   *  page's own text nodes and cannot be moved out of it. One rule per colour,
   *  plus a bare fallback so an entry written before colours existed still
   *  looks like a highlight. */
  function ensureMarkStyle(): void {
    if (document.getElementById('localmd-hl-style')) return;
    const rules = HIGHLIGHT_COLORS.map(
      (c) => `mark.${HL_CLASS}[data-hl-color="${c.name}"]{background:${c.value}66;}`,
    ).join('');
    const s = document.createElement('style');
    s.id = 'localmd-hl-style';
    s.textContent =
      `mark.${HL_CLASS}{background:#FFD63366;color:inherit;padding:0;border-radius:2px;cursor:pointer;}` +
      rules +
      `mark.${HL_CLASS}[data-hl-note]{border-bottom:2px solid rgba(0,0,0,.35);}`;
    document.documentElement.appendChild(s);
  }

  function place(el: HTMLElement, rect: DOMRect): void {
    const sx = window.scrollX;
    const sy = window.scrollY;
    el.style.visibility = 'hidden';
    el.style.left = '0px';
    el.style.top = '0px';
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    let left = sx + rect.left + rect.width / 2 - bw / 2;
    left = Math.max(sx + 8, Math.min(left, sx + window.innerWidth - bw - 8));
    let top = sy + rect.top - bh - 8;
    if (rect.top - bh - 8 < 4) top = sy + rect.bottom + 8;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = 'visible';
  }

  function hideBar(): void {
    bar?.remove();
    bar = null;
  }

  /**
   * Let the passage go.
   *
   * Everything the bar offers has captured what it needs by the time this
   * runs, and leaving the selection live is not neutral: the mouseup that ENDS
   * the click lands on the PAGE — the button under the cursor has just been
   * removed — the selection is still there, and the toolbar comes straight back
   * up on top of the answer. Measured on a real page (`barBack: true`), not
   * guessed; the open-ended prompt only escaped it because focusing its
   * textarea cleared the selection as a side effect.
   *
   * The scan overlay takes over saying which passage this is about, so nothing
   * is lost visually.
   */
  function releaseSelection(): void {
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* no selection to release */
    }
  }

  function toast(rect: DOMRect, text: string): void {
    const sh = ensureShell();
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    sh.appendChild(t);
    place(t, rect);
    setTimeout(() => t.remove(), 2200);
  }

  /** A button whose label is a picture. `title` carries the words: the bar sits
   *  over the reader's own paragraph, and "Translate / Explain / Note / Clip /
   *  Chat" spelled out is wider than most sentences it is about. */
  function iconButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'icon';
    b.innerHTML = icon;
    b.title = title;
    b.setAttribute('aria-label', title);
    // mousedown, not click: a click would have already cleared the selection.
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      barActionAt = Date.now();
      onClick();
    });
    return b;
  }

  function swatch(
    color: HighlightColor,
    value: string,
    onPick: (c: HighlightColor) => void,
  ): HTMLElement {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = `Highlight in ${color}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = value;
    b.appendChild(dot);
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      barActionAt = Date.now();
      onPick(color);
    });
    return b;
  }

  /* ── the selection toolbar ── */

  /** The passage a bar is about. `rects` is its LINE BOXES in page
   *  coordinates — what the scan overlay draws on, kept at capture time
   *  because a Range does not survive the click that dismisses the bar. */
  let captured: { text: string; rect: DOMRect; rects: DOMRect[] } | null = null;

  /** Client rects → page coordinates, which is what the shadow host's children
   *  are positioned in (see `place`). */
  function pageRects(source: Range | Element): DOMRect[] {
    const sx = window.scrollX;
    const sy = window.scrollY;
    return [...source.getClientRects()]
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => new DOMRect(r.left + sx, r.top + sy, r.width, r.height));
  }

  function separator(): HTMLElement {
    const sep = document.createElement('div');
    sep.className = 'sep';
    return sep;
  }

  function showBar(rect: DOMRect, text: string, range?: Range): void {
    const sh = ensureShell();
    hideBar();
    hidePeek();
    captured = { text, rect, rects: range ? pageRects(range) : [] };
    bar = document.createElement('div');
    bar.className = 'bar';
    for (const c of HIGHLIGHT_COLORS) {
      bar.appendChild(swatch(c.name, c.value, (color) => void highlightSelection(color)));
    }
    // Icons past this point, because five words of English is a wide thing to
    // put over somebody's paragraph and the tooltips say the same. Order: the
    // colours MARK the passage, the prompts make sense OF it, and the last
    // three put it somewhere.
    const shown = settings.prompts.filter((a) => a.on);
    if (shown.length) {
      bar.appendChild(separator());
      bar.appendChild(promptMenuButton(shown));
    }
    bar.appendChild(separator());
    bar.appendChild(
      iconButton(ICON_PENCIL, 'Highlight and write a note', () => {
        void highlightSelection(settings.defaultColor, true);
      }),
    );
    bar.appendChild(
      iconButton(ICON_CLIP, 'Clip this passage to localmd', () => void send('clip_selection')),
    );
    // Kept apart from the prompts on purpose: those answer HERE, this one
    // takes you to localmd to keep talking. Same passage, two different places
    // to end up, and one button that did both was the thing to separate.
    bar.appendChild(
      iconButton(
        ICON_ASK,
        'Chat in localmd about this passage (opens localmd)',
        () => void send('ask_selection'),
      ),
    );
    sh.appendChild(bar);
    place(bar, rect);
  }

  /**
   * The saved prompts, behind one button.
   *
   * One button and a list rather than one button each: the set is the user's to
   * grow, and a toolbar that got wider every time somebody wrote a prompt would
   * end up covering the paragraph it is about.
   */
  function promptMenuButton(
    prompts: SavedPrompt[],
    source?: () => { text: string; rect: DOMRect; rects: DOMRect[] },
  ): HTMLElement {
    return iconButton(ICON_SPARK + ICON_CARET, 'Run a prompt on this passage', () => {
      const open = bar?.querySelector('.menu');
      if (open) {
        open.remove(); // a second click closes it
        return;
      }
      const menu = document.createElement('div');
      menu.className = 'menu';
      for (const a of prompts) {
        const item = document.createElement('button');
        item.textContent = a.label;
        // The prompt itself, for anyone wondering what a name will do.
        item.title = a.prompt.trim() || 'Type your own question about this passage';
        item.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          barActionAt = Date.now();
          // A selection was captured when the bar went up; a highlight has to
          // be read off the element now, because nothing selected it.
          if (source) captured = source();
          void runPrompt(a);
        });
        menu.appendChild(item);
      }
      bar?.appendChild(menu);
    });
  }

  async function send(
    action: 'clip_selection' | 'ask_selection',
    context?: { prompt?: string; answer?: string },
  ): Promise<void> {
    const snap = captured;
    hideBar();
    releaseSelection();
    if (!snap) return;
    try {
      const r = (await chrome.runtime.sendMessage({
        type: 'LOCALMD_PAGE_CAPTURE',
        action,
        selection: snap.text.slice(0, MAX_HL_CHARS),
        ...(context?.prompt ? { prompt: context.prompt } : {}),
        ...(context?.answer ? { answer: context.answer } : {}),
      })) as { ok?: boolean; error?: string } | undefined;
      toast(
        snap.rect,
        r?.ok
          ? action === 'clip_selection'
            ? 'Clipped to localmd'
            : 'Opening localmd…'
          : (r?.error ?? 'Could not reach localmd Connect'),
      );
    } catch {
      // The extension was updated or reloaded under this page: its content
      // script is orphaned and no message will ever arrive.
      toast(snap.rect, 'Extension reloaded — refresh this page');
    }
  }

  /* ── quick actions, answered by localmd's model ── */

  /**
   * Run one prompt recipe over the selected passage and show the answer here.
   *
   * The extension holds no API key and runs no model. The question travels the
   * relay to localmd, whose configured model answers it and hands the text back
   * (`sampling/createMessage` — src/localmd-connect/ask-model.ts). If no localmd
   * tab is open the service worker opens one in the background first, so the
   * first action of a session is a second slower and the rest are not.
   */
  async function runPrompt(a: SavedPrompt, fresh = false): Promise<void> {
    const snap = captured;
    hideBar();
    releaseSelection();
    if (!snap) return;
    // No saved prompt means the general one: ask for the instruction, and use
    // what was typed AS the template. Nothing below knows the difference — the
    // variables and the append-in-triple-quotes rule apply to a typed question
    // exactly as they do to a saved one.
    if (!a.prompt.trim()) {
      // Marked while the question is being TYPED, not only once it is sent:
      // the selection has just been released, so without this there is nothing
      // on the page saying what the box is about.
      //
      // AFTER openAskBox, not before. That call closes any open answer, and
      // closing an answer takes its mark with it — so painting first painted
      // something that was wiped a line later. Measured on a real page:
      // `scanWhileTyping: 0`.
      openAskBox(
        snap.rect,
        (typed) => {
          captured = snap;
          void runPrompt({ ...a, prompt: typed });
        },
        hideScan,
      );
      showScan(snap.rects);
      return;
    }
    const p = showPanel(a.label, snap.rect, snap);
    // "Working on THIS" — said on the passage itself, where the user is
    // looking, rather than only in a popover that says "Asking localmd…". The
    // sweep stops when the answer lands; the mark does NOT, because comparing
    // an answer with its passage is what happens next.
    showScan(snap.rects, true);
    try {
      const r = (await chrome.runtime.sendMessage({
        type: 'LOCALMD_SELECTION_LLM',
        label: a.label,
        // Set only by the "cached" tag: ask again for real.
        ...(fresh ? { fresh: true } : {}),
        // Filled HERE, where the settings already are: the template, the
        // passage and the chosen output language are three things this side
        // holds and the service worker would have to go and read.
        prompt: fillPromptTemplate({
          template: a.prompt,
          content: clampSelection(snap.text),
          lang: resolveLang(settings.lang),
        }),
        url: location.href,
      })) as { ok?: boolean; result?: string; error?: string; cached?: boolean } | undefined;
      // The user may have closed this one or asked something else while the
      // model was thinking; a late answer must not overwrite what replaced it.
      if (p !== panel) return;
      markScan('working', false);
      if (r?.ok && typeof r.result === 'string') {
        setPanelAnswer(r.result);
        addContinue(p, snap, a.label, r.result);
        // Say when an answer was remembered rather than asked for. A cache
        // nobody can see past is a cache that eventually lies — the model in
        // localmd can change under an unchanged prompt — so the tag IS the way
        // to ask again.
        if (r.cached) {
          markCached(p, () => {
            captured = snap;
            void runPrompt(a, true);
          });
        }
      } else setPanelBody(r?.error ?? 'localmd returned nothing', false);
    } catch {
      if (p !== panel) return;
      markScan('working', false);
      setPanelBody('Extension reloaded — refresh this page', false);
    }
  }

  /**
   * Type a question about this passage.
   *
   * Modelled on the note editor rather than on a browser prompt(): it has to
   * sit on the passage, survive a page that listens for single-key shortcuts,
   * and take a sentence with punctuation in it.
   */
  function openAskBox(rect: DOMRect, onAsk: (typed: string) => void, onCancel?: () => void): void {
    const sh = ensureShell();
    hidePanel();
    const box = document.createElement('div');
    box.className = 'note';
    const ta = document.createElement('textarea');
    ta.maxLength = MAX_NOTE_CHARS;
    ta.placeholder = 'Ask anything about this passage…';
    const row = document.createElement('div');
    row.className = 'row';
    const close = (): void => {
      box.remove();
      askBox = null;
    };
    const dropped = (): void => {
      close();
      onCancel?.();
    };
    askBox = { empty: () => !ta.value.trim(), dismiss: dropped };
    const send = (): void => {
      const typed = ta.value.trim();
      if (!typed) return;
      close();
      onAsk(typed);
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', dropped);
    const ok = document.createElement('button');
    ok.textContent = 'Ask';
    ok.addEventListener('click', send);
    row.append(cancel, ok);
    box.append(ta, row);
    // Keystrokes stay in the box, and Enter sends: this is one question, not a
    // document — a newline is the rarer intent, so it takes the modifier.
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') dropped();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    sh.appendChild(box);
    place(box, rect);
    ta.focus();
  }

  function showPanel(
    title: string,
    rect: DOMRect,
    about?: { text: string; rects: DOMRect[] },
  ): HTMLDivElement {
    const sh = ensureShell();
    hidePanel();
    hidePeek();
    const el = document.createElement('div');
    el.className = 'panel';

    const head = document.createElement('div');
    head.className = 'head';
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = title;
    const pinB = document.createElement('button');
    pinB.innerHTML = ICON_PIN;
    pinB.className = 'pin';
    pinB.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPinned(el, el.dataset.pinned !== '1');
    });
    const copyB = document.createElement('button');
    copyB.textContent = 'Copy';
    copyB.title = 'Copy the answer';
    copyB.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const body = el.querySelector('.body');
      if (!body || body.classList.contains('loading')) return;
      // What the model said, not what the renderer drew.
      void navigator.clipboard?.writeText(el.dataset.raw || (body.textContent ?? '')).then(
        () => {
          copyB.textContent = 'Copied';
          setTimeout(() => (copyB.textContent = 'Copy'), 1200);
        },
        () => {
          copyB.textContent = 'Failed';
          setTimeout(() => (copyB.textContent = 'Copy'), 1200);
        },
      );
    });
    const closeB = document.createElement('button');
    closeB.textContent = '✕';
    closeB.title = 'Close';
    closeB.setAttribute('aria-label', 'Close');
    closeB.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hidePanel();
    });
    head.appendChild(t);
    head.appendChild(pinB);
    head.appendChild(copyB);
    head.appendChild(closeB);
    head.addEventListener('mousedown', (e) => dragPanel(el, e));

    const body = document.createElement('div');
    body.className = 'body loading';
    const spin = document.createElement('span');
    spin.className = 'spin';
    body.appendChild(spin);
    body.appendChild(document.createTextNode('Asking localmd…'));

    el.appendChild(head);
    // The passage, kept: the scan goes away when the answer arrives, and
    // comparing a translation with its original is exactly then. Hovering it
    // lights the passage up again — "which part was that?" answered on the
    // page rather than by scrolling and guessing.
    if (about?.text.trim()) {
      const quote = document.createElement('div');
      quote.className = 'quote';
      const bar2 = document.createElement('i');
      const q = document.createElement('span');
      q.textContent = about.text.replace(/\s+/g, ' ').trim();
      quote.append(bar2, q);
      quote.title = 'The passage this is about — click to go to it';
      // The boxes are already up; hovering only deepens them, so the sweep is
      // undisturbed while the model is still working.
      quote.addEventListener('mouseenter', () => markScan('hot', true));
      quote.addEventListener('mouseleave', () => markScan('hot', false));
      // And clicking goes there. An answer read long enough is an answer whose
      // passage has scrolled away, and hovering can only point at something
      // still on screen.
      quote.addEventListener('click', () => {
        const first = about.rects[0];
        if (!first) return;
        window.scrollTo({
          top: Math.max(0, first.top - window.innerHeight / 2 + first.height / 2),
          behavior: 'smooth',
        });
      });
      el.appendChild(quote);
    }
    el.appendChild(body);
    sh.appendChild(el);
    setPinned(el, false);
    panel = el;
    panelAnchor = new DOMRect(
      rect.left + window.scrollX,
      rect.top + window.scrollY,
      rect.width,
      rect.height,
    );
    place(el, rect);
    return el;
  }

  /**
   * Drag the answer by its header.
   *
   * Moving it says "keep this where I put it", so a moved panel stops closing
   * on a click elsewhere — otherwise dragging it clear of the passage and then
   * clicking back into the article would throw away the thing you just made
   * room for. ✕ and Esc still close it, which is why no visible pin is needed.
   *
   * The listeners go on `document` in the CAPTURE phase: the pointer leaves the
   * shadow root almost immediately, and a page that stops mousemove on its own
   * content would otherwise freeze the drag halfway.
   */
  /** Pin state lives on the element, so the drag handler and the button cannot
   *  disagree about it, and the look follows in one place. */
  function setPinned(el: HTMLElement, on: boolean): void {
    el.dataset.pinned = on ? '1' : '';
    const b = el.querySelector('.pin');
    b?.classList.toggle('on', on);
    if (b) {
      (b as HTMLElement).title = on
        ? 'Pinned — clicking the page leaves it open. Click to unpin.'
        : 'Pin it: clicking the page will not close it (dragging pins it too)';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function dragPanel(el: HTMLDivElement, e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('button')) return; // Copy / Close
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const fromLeft = parseFloat(el.style.left) || 0;
    const fromTop = parseFloat(el.style.top) || 0;
    const move = (ev: MouseEvent): void => {
      setPinned(el, true);
      // Clamped to the window, so a panel cannot be dragged somewhere it can
      // no longer be reached or closed.
      const maxLeft = window.scrollX + window.innerWidth - el.offsetWidth - 4;
      const maxTop = window.scrollY + window.innerHeight - el.offsetHeight - 4;
      const left = fromLeft + ev.clientX - startX;
      const top = fromTop + ev.clientY - startY;
      el.style.left = `${Math.round(Math.max(window.scrollX + 4, Math.min(left, maxLeft)))}px`;
      el.style.top = `${Math.round(Math.max(window.scrollY + 4, Math.min(top, maxTop)))}px`;
    };
    const up = (): void => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  }

  /** A pinned panel stays where it is and stays open. Set by the pin button, or
   *  by a drag — moving something IS saying you want to keep it. */
  function panelPinned(): boolean {
    return panel?.dataset.pinned === '1';
  }

  /**
   * "Continue in localmd" — the same destination the toolbar's speech bubble
   * goes to, but carrying what has already been said.
   *
   * The popover answers one question well and is deliberately not a chat. This
   * is the door out of it: the passage, the prompt that was run on it AND the
   * answer go over, so the conversation starts where the reader already is
   * rather than making them re-explain what they just read.
   */
  function addContinue(
    el: HTMLDivElement,
    snap: { text: string; rect: DOMRect; rects: DOMRect[] },
    label: string,
    answer: string,
  ): void {
    const head = el.querySelector('.head');
    if (!head || head.querySelector('.go')) return;
    const b = document.createElement('button');
    b.className = 'go';
    b.innerHTML = ICON_ASK;
    b.title = 'Continue in localmd — with this passage and this answer';
    b.setAttribute('aria-label', 'Continue in localmd');
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      captured = snap;
      void send('ask_selection', { prompt: label, answer });
    });
    head.querySelector('.title')?.after(b);
  }

  /** A tag on the head saying this answer came from the last-ten cache, and
   *  clicking it asks again. */
  function markCached(el: HTMLDivElement, again: () => void): void {
    const head = el.querySelector('.head');
    const title = head?.querySelector('.title');
    if (!head || !title || head.querySelector('.tag')) return;
    const tag = document.createElement('button');
    tag.className = 'tag';
    // The word alone said where the answer came from and nothing about what
    // clicking would do. The arrow is the verb.
    tag.innerHTML = ICON_REFRESH;
    tag.appendChild(document.createTextNode('cached'));
    tag.title = 'A remembered answer — click to ask again';
    tag.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      again();
    });
    title.after(tag);
  }

  /**
   * The answer, rendered.
   *
   * A model asked to explain something answers in paragraphs and bullets, and
   * showing the reader `**like this**` is the worst of both — telling it not to
   * use Markdown would throw away structure it produces for free. The renderer
   * builds nodes, never HTML (`./mini-markdown`), because this text lands in a
   * shadow root inside somebody's page.
   *
   * The raw text is kept on the element so Copy hands over what the model
   * actually said, asterisks and all, rather than the flattened rendering.
   */
  function setPanelAnswer(md: string): void {
    const body = panel?.querySelector('.body') as HTMLElement | null;
    if (!body || !panel) return;
    body.classList.remove('loading');
    body.classList.add('md');
    renderMarkdown(body, md);
    panel.dataset.raw = md;
    reflowPanel();
  }

  function setPanelBody(text: string, loading: boolean): void {
    const body = panel?.querySelector('.body') as HTMLElement | null;
    if (!body || !panel) return;
    body.classList.toggle('loading', loading);
    body.classList.remove('md');
    body.textContent = text;
    reflowPanel();
  }

  /** The answer is a different height than "Asking localmd…", and a popover
   *  anchored above a passage would otherwise overlap the words it is about.
   *  Unless the reader pinned it, in which case moving it undoes exactly what
   *  they asked for. */
  function reflowPanel(): void {
    if (panelAnchor && panel && !panelPinned()) {
      place(
        panel,
        new DOMRect(
          panelAnchor.left - window.scrollX,
          panelAnchor.top - window.scrollY,
          panelAnchor.width,
          panelAnchor.height,
        ),
      );
    }
  }

  /* ── highlighting ── */

  async function highlightSelection(color: HighlightColor, withNote = false): Promise<void> {
    const sel = window.getSelection();
    const snapRect = captured?.rect;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideBar();
    const range = sel.getRangeAt(0);
    const text = range.toString();
    if (text.length > MAX_HL_CHARS) {
      hideBar();
      if (snapRect)
        toast(snapRect, `Too long to highlight (${text.length} of ${MAX_HL_CHARS} chars)`);
      return;
    }
    ensureMarkStyle();
    const idx = buildTextIndex(document.body);
    const desc = describeRange(idx, range);
    if (!desc) return hideBar();
    const span = findQuote(idx, desc.exact, desc.prefix, desc.suffix);
    if (!span) return hideBar();
    const id = makeHighlightId();
    paint(wrapSegments(segmentsFromSpan(idx, span.start, span.end), id), color, false);
    // Clear the selection and drop the bar NOW — synchronously, before the
    // async store write — so the click's trailing mouseup finds a collapsed
    // selection and no bar to race with. Doing this after `await` left a window
    // where the mouseup re-showed a bar over the just-highlighted passage (the
    // "first click never dismisses" bug). `span` (not `range`) drove the paint,
    // so releasing the selection here is safe.
    sel.removeAllRanges();
    hideBar();
    await addHighlight(pageKey(location.href), {
      id,
      ...desc,
      ts: Date.now(),
      title: document.title,
      color,
    });
    if (withNote) {
      const mark = document.querySelector(hlSelector(id)) as HTMLElement | null;
      if (mark) openNote(mark, id, '', true);
    }
  }

  /** Stamp colour and note-ness onto the marks of one highlight. `wrapSegments`
   *  returns them, and a restore looks them up. */
  function paint(marks: HTMLElement[] | number, color: string | undefined, hasNote: boolean): void {
    const list = Array.isArray(marks)
      ? marks
      : (Array.from(document.querySelectorAll(hlSelector(String(marks)))) as HTMLElement[]);
    for (const m of list) {
      if (color) m.dataset.hlColor = color;
      if (hasNote) m.dataset.hlNote = '1';
      else delete m.dataset.hlNote;
    }
  }

  function paintById(id: string, color: string | undefined, hasNote: boolean): void {
    const marks = Array.from(document.querySelectorAll(hlSelector(id))) as HTMLElement[];
    paint(marks, color, hasNote);
  }

  /* ── clicking an existing highlight ── */

  function showMarkBar(mark: HTMLElement): void {
    const id = mark.dataset.webagentHl;
    if (!id) return;
    const sh = ensureShell();
    hideBar();
    hidePeek(); // the hover note was showing on this very passage
    const rect = mark.getBoundingClientRect();
    bar = document.createElement('div');
    bar.className = 'bar';
    for (const c of HIGHLIGHT_COLORS) {
      bar.appendChild(
        swatch(c.name, c.value, (color) => {
          paintById(id, color, !!mark.dataset.hlNote);
          void updateHighlight(pageKey(location.href), id, { color });
          hideBar();
        }),
      );
    }
    bar.appendChild(separator());
    // The same offers the selection toolbar makes, on a passage that is already
    // marked: a highlight IS the passage the user wants to do something with,
    // and re-selecting its text to reach the other bar was the only way to.
    const marked = settings.prompts.filter((a) => a.on);
    if (marked.length) {
      bar.appendChild(
        promptMenuButton(marked, () => ({
          text: mark.textContent ?? '',
          rect: mark.getBoundingClientRect(),
          rects: pageRects(mark),
        })),
      );
    }
    bar.appendChild(
      iconButton(
        ICON_PENCIL,
        mark.dataset.hlNote ? 'Edit the note on this passage' : 'Write a note on this passage',
        () => {
          hideBar();
          void openNoteFor(mark, id);
        },
      ),
    );
    bar.appendChild(
      iconButton(ICON_ASK, 'Chat in localmd about this passage (opens localmd)', () => {
        captured = {
          text: mark.textContent ?? '',
          rect: mark.getBoundingClientRect(),
          rects: pageRects(mark),
        };
        void send('ask_selection');
      }),
    );
    bar.appendChild(
      iconButton(ICON_TRASH, 'Remove this highlight', () => {
        unwrapById(document.body, id);
        void removeHighlight(pageKey(location.href), id);
        hideBar();
      }),
    );
    sh.appendChild(bar);
    place(bar, rect);
  }

  async function openNoteFor(mark: HTMLElement, id: string): Promise<void> {
    const entries = await loadHighlights(pageKey(location.href));
    openNote(mark, id, entries.find((e) => e.id === id)?.note ?? '');
  }

  /** `isNew` marks a note opened straight after creating the highlight (the
   *  Note button on a selection). Cancelling there means "I did not want this
   *  after all", so the highlight goes with it — leaving a mark the user only
   *  made in order to attach a note they then abandoned is litter they now have
   *  to clean up. Cancelling an EDIT of an existing note leaves it alone. */
  function openNote(mark: HTMLElement, id: string, initial: string, isNew = false): void {
    const sh = ensureShell();
    const box = document.createElement('div');
    box.className = 'note';
    const ta = document.createElement('textarea');
    ta.value = initial;
    ta.maxLength = MAX_NOTE_CHARS;
    ta.placeholder = 'Your note on this passage…';
    const row = document.createElement('div');
    row.className = 'row';
    const close = (): void => box.remove();
    const cancelled = (): void => {
      close();
      if (!isNew) return;
      unwrapById(document.body, id);
      void removeHighlight(pageKey(location.href), id);
    };
    const save = (): void => {
      const note = ta.value.slice(0, MAX_NOTE_CHARS);
      paintById(id, undefined, !!note.trim());
      void updateHighlight(pageKey(location.href), id, { note });
      close();
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', cancelled);
    const ok = document.createElement('button');
    ok.textContent = 'Save';
    ok.addEventListener('click', save);
    row.append(cancel, ok);
    box.append(ta, row);
    // Keystrokes stay in the box: a page listening for "/" or "j" must not act
    // on someone typing a note.
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') cancelled();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
    });
    sh.appendChild(box);
    place(box, mark.getBoundingClientRect());
    ta.focus();
  }

  /* ── restore on load, on retry, and after a soft navigation ── */

  let restoredKey = '';

  async function restore(): Promise<void> {
    if (!active) return;
    const key = pageKey(location.href);
    const entries = await loadHighlights(key);
    restoredKey = key;
    if (!entries.length) return;
    ensureMarkStyle();
    const idx = buildTextIndex(document.body);
    for (const e of entries) {
      if (document.querySelector(hlSelector(e.id))) continue; // already painted
      const span = findQuote(idx, e.exact, e.prefix, e.suffix);
      if (!span) continue; // the page's own words changed — nothing to anchor to
      paint(wrapSegments(segmentsFromSpan(idx, span.start, span.end), e.id), e.color, !!e.note);
    }
    // Someone arrived here from the annotations list. Consumed AFTER the marks
    // exist, because there is nothing to scroll to before that.
    const wanted = await takeHighlightFocus(key);
    if (wanted) focusHighlight(wanted);
  }

  /**
   * Take the reader to a passage: scroll it into the middle of the window and
   * flash it twice.
   *
   * The flash is a Web Animation on the mark itself rather than a class plus a
   * transition — no stylesheet to inject, nothing left behind if the page
   * navigates mid-animation, and it cannot be overridden by the page's own CSS
   * for `mark`. Retried once: an anchor can land before a lazy image above it
   * has taken its space, which moves the passage out from under the scroll.
   */
  function focusHighlight(id: string, attempt = 0): void {
    const mark = document.querySelector<HTMLElement>(hlSelector(id));
    if (!mark) {
      // Not painted yet (a slow page, or the retry pass has not run) — one more
      // look after the usual re-anchor delay, then give up quietly.
      if (attempt < 2) setTimeout(() => focusHighlight(id, attempt + 1), RESTORE_RETRY_MS);
      return;
    }
    mark.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    try {
      mark.animate(
        [
          { outline: '2px solid rgba(37,99,235,0)', outlineOffset: '2px' },
          { outline: '2px solid rgba(37,99,235,0.9)', outlineOffset: '3px' },
          { outline: '2px solid rgba(37,99,235,0)', outlineOffset: '2px' },
        ],
        { duration: 900, iterations: 2, easing: 'ease-in-out' },
      );
    } catch {
      /* no WAAPI here — the scroll already did the important half */
    }
    if (attempt === 0) setTimeout(() => focusHighlight(id, 1), 700); // settle after reflow
  }

  // The annotations list, for a page that is ALREADY open: its highlights were
  // restored long ago, so nothing would pick up a stored request.
  chrome.runtime.onMessage.addListener((msg: { type?: string; id?: string }) => {
    if (msg?.type !== 'LOCALMD_FOCUS_HIGHLIGHT' || typeof msg.id !== 'string') return;
    focusHighlight(msg.id);
  });

  function teardown(): void {
    hideBar();
    hidePanel();
    for (const m of Array.from(document.querySelectorAll(`mark.${HL_CLASS}`))) {
      const id = (m as HTMLElement).dataset.webagentHl;
      if (id) unwrapById(document.body, id);
    }
    host?.remove();
    host = null;
    shadow = null;
  }

  /* ── events ── */

  function inEditable(): boolean {
    const ae = document.activeElement as HTMLElement | null;
    if (!ae) return false;
    return ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable === true;
  }

  /** True once the extension has been reloaded or updated under this page: its
   *  context is gone, but this script's document listeners are not — they keep
   *  putting bars up. And the fresh injection that follows a reload runs BESIDE
   *  them, guard or no guard: a new isolated world has no `__localmdPageTools`.
   *  Two instances, two bars, two sets of listeners — dismiss one and the other's
   *  mouseup re-shows its own. That pair was the recurring "the bar won't
   *  dismiss" after every dev reload of the extension. */
  function orphaned(): boolean {
    try {
      return !chrome.runtime?.id;
    } catch {
      return true; // "Extension context invalidated" — same thing
    }
  }

  /** An orphan stops acting on its next event: no more bars, host gone. The
   *  marks STAY — the live instance owns them now (its restore paints from
   *  storage), so the full teardown's unwrap would strip the new instance's. */
  function retireIfOrphaned(): boolean {
    if (!orphaned()) return false;
    active = false;
    hideBar();
    hidePeek();
    hidePanel();
    host?.remove();
    host = null;
    shadow = null;
    return true;
  }

  document.addEventListener('mouseup', (e) => {
    if (retireIfOrphaned()) return;
    if (!active) return;
    if (host && e.composedPath().includes(host)) return;
    // Let the selection settle — a double-click's word selection is not final
    // at mouseup.
    setTimeout(() => {
      if (!active) return;
      // A bar button was just pressed: this mouseup is that click's release,
      // not a fresh selection, and re-showing a bar over the passage the user
      // just acted on is the bug. (Well under the gap between two deliberate
      // selections, so a real new selection still gets its bar.)
      if (Date.now() - barActionAt < 250) return;
      // The toolbar is optional on its own: someone who wants their highlights
      // to come back but does not want a bar over every sentence they select
      // turns this off, and everything else stays.
      if (!settings.bar) return;
      const sel = window.getSelection();
      const text = sel?.toString() ?? '';
      if (!sel || sel.isCollapsed || !text.trim() || inEditable()) return;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      showBar(rect, text, range);
    }, 0);
  });

  document.addEventListener('mousedown', (e) => {
    if (retireIfOrphaned()) return;
    if (!active) return;
    if (host && e.composedPath().includes(host)) return;
    hideBar();
    // The answer goes with the click, but NOT with a scroll (unlike the bar):
    // reading a long explanation and scrolling the article underneath it is the
    // normal way to use one. A panel the reader pinned stays until they close
    // it — pinning, or moving it, is how you say you want to keep it.
    if (!panelPinned()) hidePanel();
    // An EMPTY question box goes too: there is nothing to lose, and making
    // someone aim at Cancel to dismiss a box they never typed in is a click
    // spent on nothing. One with text in it stays — that IS something to lose.
    if (askBox?.empty()) askBox.dismiss();
    const mark = (e.target as Element | null)?.closest?.(`mark.${HL_CLASS}`) as HTMLElement | null;
    // Deferred so this mousedown's own hide does not race the new bar.
    if (mark) setTimeout(() => showMarkBar(mark), 0);
  });

  // Hovering a highlight that carries a note shows it. The note is the reason
  // the passage was marked, and it was previously reachable only by clicking
  // through to an editor — invisible on the page it belongs to. (`peek` and
  // `hidePeek` are declared with `bar` above: showBar and showMarkBar call
  // hidePeek, and a `let` read before its declaration runs is a TDZ error —
  // findings F-58 was exactly that mistake one file over.)
  document.addEventListener(
    'mouseover',
    (e) => {
      if (!active) return;
      // Not while a bar is up. The bar sits on the same passage and offers
      // "Edit note" — two floating things over one highlight is one too many,
      // and the peek lands on top of the buttons the user is reaching for.
      if (bar) return;
      const mark = (e.target as Element | null)?.closest?.(
        `mark.${HL_CLASS}[data-hl-note]`,
      ) as HTMLElement | null;
      if (!mark) return;
      const id = mark.dataset.webagentHl;
      if (!id) return;
      void loadHighlights(pageKey(location.href)).then((entries) => {
        const note = entries.find((x) => x.id === id)?.note;
        if (!note || !mark.isConnected) return;
        hidePeek();
        const sh = ensureShell();
        const el = document.createElement('div');
        el.className = 'peek';
        el.textContent = note;
        sh.appendChild(el);
        place(el, mark.getBoundingClientRect());
        peek = el;
      });
    },
    true,
  );
  document.addEventListener(
    'mouseout',
    (e) => {
      const to = (e as MouseEvent).relatedTarget as Element | null;
      if (to?.closest?.(`mark.${HL_CLASS}[data-hl-note]`)) return;
      hidePeek();
    },
    true,
  );
  window.addEventListener('scroll', hidePeek, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideBar();
      hidePeek();
      hidePanel();
    }
  });
  window.addEventListener('scroll', () => hideBar(), { passive: true });

  // A highlight deleted in another tab (or from localmd) must stop being
  // painted here too.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !active) return;
    const key = pageKey(location.href);
    if (!changes[key]) return;
    const next = (changes[key].newValue ?? []) as Array<{ id: string }>;
    const alive = new Set(next.map((e) => e.id));
    for (const m of Array.from(document.querySelectorAll(`mark.${HL_CLASS}`))) {
      const id = (m as HTMLElement).dataset.webagentHl;
      if (id && !alive.has(id)) unwrapById(document.body, id);
    }
  });

  void restore();
  // Pages that build their body after load get one more chance; SPAs get a
  // poll, because a route change leaves no event this script can hear.
  setTimeout(() => void restore(), RESTORE_RETRY_MS);
  setInterval(() => {
    if (active && pageKey(location.href) !== restoredKey) void restore();
  }, URL_POLL_MS);
}
