/**
 * The web clipper — one page (or one selection) → a ClipPayload localmd turns
 * into a note.
 *
 * Division of labour, deliberately lopsided: the extension does everything
 * that needs the browser (render the page, read the DOM, resolve lazy images,
 * fetch them with the user's cookies) and NOTHING that needs the knowledge
 * base. Where the note goes, what its frontmatter says, whether two clips of
 * one URL merge — localmd owns all of that, because the KB layout is the
 * user's and this extension cannot see it. So the payload is descriptive:
 * metadata as the page declared it, Markdown in the dialect `get_page_text`
 * already emits, images listed by absolute URL (inlined on request), and for
 * a selection the TextQuote triple that lets a citation find its way back.
 *
 * Three modes, one walker: `article` runs the main-content pick
 * (extractPageMarkdown's density scorer), `full` scopes to `body` (keeps the
 * boilerplate filter, drops the pick), `selection` reads the live Selection,
 * serializes it and runs the SAME walker over a mini-DOM parse of that HTML —
 * so a clipped paragraph and a clipped page never disagree on dialect.
 */
import {
  extractPageMarkdown,
  extractPageMeta,
  type PageMeta,
} from '../tools/generic/get-page-text';
import { parseHtml } from '../tools/generic/_mini-dom';
import { loadHighlights, pageKey } from '../selection/highlights-store';
import { lookupInKb, type KbEntry } from './kb-index';

export type ClipMode = 'article' | 'full' | 'selection';
export type ClipImages = 'list' | 'inline' | 'skip';

export interface ClipImage {
  /** Absolute URL as resolved against the page. */
  src: string;
  /** Present in `inline` mode when the fetch succeeded. */
  dataUrl?: string;
  bytes?: number;
  mime?: string;
  error?: string;
}

export interface ClipSelection {
  /** W3C TextQuoteSelector — exact + up to 30 chars of context each side. */
  exact: string;
  prefix: string;
  suffix: string;
}

/** One of the user's own highlights on the clipped page. */
export interface ClipHighlight {
  id: string;
  text: string;
  color?: string;
  note?: string;
  date: string;
  anchor: ClipSelection;
}

/**
 * A PDF the user had open, as bytes. Chrome's PDF viewer is a plugin with no
 * DOM to walk, and a paper is worth more to a knowledge base as the file it is
 * than as any text this side could scrape out of it — localmd indexes PDFs and
 * cites into them by block. Fetched with the user's cookies, so a paper behind
 * an institutional login comes through too.
 */
export interface PdfClipPayload {
  kind: 'pdf';
  url: string;
  title: string;
  mime: 'application/pdf';
  size: number;
  /** base64 of the file. The outbound frame ceiling (16MB) bounds this at
   *  roughly a 12MB PDF; larger ones fail with a message rather than
   *  arriving truncated. */
  data: string;
  clipped_at: string;
}

export interface ClipPayload extends PageMeta {
  mode: ClipMode;
  markdown: string;
  /** Character count of the Markdown before truncation. */
  markdown_length: number;
  truncated: boolean;
  images: ClipImage[];
  selection?: ClipSelection;
  /** What the user had already marked on this page, if anything. Carried with
   *  the clip so the note and the annotations arrive together — asking for them
   *  separately means a note that is written before its own highlights. */
  highlights?: ClipHighlight[];
  /** localmd already wrote this page down (as far as the browser knows —
   *  learned from an earlier ack). The caller decides whether a second note is
   *  wanted; usually it is not. */
  already_in_kb?: KbEntry;
  clipped_at: string;
}

export interface ClipOptions {
  mode?: ClipMode;
  images?: ClipImages;
  /** article mode only: scope to one element instead of the density pick. */
  selector?: string;
  maxBytes?: number;
}

export const CLIP_MAX_BYTES = 400_000;
/** Largest PDF handed over as base64: the 16MB outbound frame less headroom. */
export const PDF_MAX_BYTES = 12_000_000;
const PDF_PROBE_TIMEOUT_MS = 4_000;

/** Does this URL look like it serves a PDF? Path heuristics first (`.pdf`,
 *  arXiv's `/pdf/` segment), else a HEAD for the content type. Exported pure
 *  half for tests. */
export function looksLikePdfUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /\.pdf$/i.test(u.pathname) || /\/pdf\//i.test(u.pathname);
  } catch {
    return false;
  }
}

async function isPdfByContentType(url: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PDF_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'include', signal: ctl.signal });
    return /application\/pdf/i.test(res.headers.get('content-type') || '');
  } catch {
    return false; // a server that refuses HEAD is not thereby a PDF
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the PDF bytes with the user's session. */
export async function clipPdf(url: string, title: string): Promise<PdfClipPayload> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`fetching the PDF failed: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > PDF_MAX_BYTES) {
    throw new Error(
      `this PDF is ${buf.length} bytes; the largest that fits a clip is ${PDF_MAX_BYTES}. Save it from the browser instead.`,
    );
  }
  // %PDF- is the file's own signature; a login page served as 200 is not a PDF.
  if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) {
    throw new Error('the URL did not return a PDF (a login or error page, most likely)');
  }
  return {
    kind: 'pdf',
    url,
    title: title || url.slice(url.lastIndexOf('/') + 1),
    mime: 'application/pdf',
    size: buf.length,
    data: bytesToBase64(buf),
    clipped_at: new Date().toISOString(),
  };
}
const IMAGE_LIST_CAP = 40;
const IMAGE_INLINE_CAP = 20;
const IMAGE_BYTES_CAP = 3_000_000;
const IMAGE_TOTAL_CAP = 12_000_000;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

/** In-page: the live selection as HTML + a TextQuote descriptor. Self-contained
 * (executeScript serializes it). Links and images are absolutized on the clone
 * so the fragment survives leaving its document; lazy-loaded images fall back
 * to the usual data-src spellings. Context comes from Range.toString() over the
 * body, which is textContent-shaped — close enough to the anchor index the
 * highlighter builds (both concatenate text nodes), and re-anchoring scores
 * context fuzzily anyway. */
export function readSelectionInPage(): {
  html: string;
  exact: string;
  prefix: string;
  suffix: string;
} | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const exact = sel.toString();
  if (!exact.trim()) return null;
  const CONTEXT = 30;
  const body = document.body;
  const before = document.createRange();
  before.setStart(body, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(body, body.childNodes.length);
  const prefix = before.toString().slice(-CONTEXT);
  const suffix = after.toString().slice(0, CONTEXT);

  const box = document.createElement('div');
  box.appendChild(range.cloneContents());
  for (const a of Array.from(box.querySelectorAll('a[href]'))) {
    try {
      a.setAttribute('href', new URL(a.getAttribute('href') || '', location.href).href);
    } catch {
      /* leave as is */
    }
  }
  for (const img of Array.from(box.querySelectorAll('img'))) {
    const lazy =
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src');
    const src = img.getAttribute('src');
    const pick = src && !/^data:/.test(src) ? src : lazy || src || '';
    try {
      if (pick) img.setAttribute('src', new URL(pick, location.href).href);
    } catch {
      /* leave as is */
    }
  }
  return { html: box.innerHTML, exact, prefix, suffix };
}

/** In-page: swap lazy-image placeholders for their real source BEFORE the
 * Markdown walker reads `src` — a clip full of 1×1 gifs is the classic clipper
 * failure. Mutates the live page's attributes only where the real source is
 * evidently elsewhere; a page that lazy-loads via IntersectionObserver keeps
 * working (the browser re-requests the same URL). */
export function resolveLazyImagesInPage(): number {
  let n = 0;
  for (const img of Array.from(document.images)) {
    const src = img.getAttribute('src') || '';
    const lazy =
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-actualsrc');
    if (lazy && (!src || /^data:/.test(src) || /\b(blank|placeholder|loading|1x1)\b/i.test(src))) {
      img.setAttribute('src', lazy);
      n++;
    }
  }
  return n;
}

const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Absolute image URLs referenced by the Markdown (+ the page's og:image), in
 * order of appearance, deduplicated, http(s) only. Pure. */
export function collectImageUrls(markdown: string, pageUrl: string, ogImage?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    let abs: string;
    try {
      abs = new URL(raw, pageUrl).href;
    } catch {
      return;
    }
    if (!/^https?:/.test(abs) || seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };
  if (ogImage) push(ogImage);
  for (const m of markdown.matchAll(MD_IMAGE_RE)) push(m[1]);
  return out.slice(0, IMAGE_LIST_CAP);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** SW-side image fetch with the user's cookies (host_permissions <all_urls>
 * makes it CORS-free). Bounded per image and in total; a failure is recorded
 * on the row, never thrown — one dead CDN link must not sink the clip. */
async function inlineImages(urls: string[]): Promise<ClipImage[]> {
  const rows: ClipImage[] = urls.map((src) => ({ src }));
  let total = 0;
  for (const row of rows.slice(0, IMAGE_INLINE_CAP)) {
    if (total >= IMAGE_TOTAL_CAP) {
      row.error = 'total image budget exhausted';
      continue;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(row.src, { credentials: 'include', signal: ctl.signal });
      if (!res.ok) {
        row.error = `HTTP ${res.status}`;
        continue;
      }
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!mime.startsWith('image/')) {
        row.error = `not an image (${mime || 'no content-type'})`;
        continue;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > IMAGE_BYTES_CAP) {
        row.error = `too large (${buf.length} bytes)`;
        continue;
      }
      row.mime = mime;
      row.bytes = buf.length;
      row.dataUrl = `data:${mime};base64,${bytesToBase64(buf)}`;
      total += buf.length;
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
  }
  return rows;
}

/**
 * Clip an open tab. The tab must be loaded (callers wait with
 * waitForPageReady when they opened it themselves). Never closes the tab.
 */
export async function clipTab(
  tabId: number,
  opts: ClipOptions = {},
): Promise<ClipPayload | PdfClipPayload> {
  // A PDF tab has nothing to walk: Chrome's viewer is a plugin. Take the file.
  const tab = await chrome.tabs.get(tabId);
  const tabUrl = tab.url ?? '';
  if (/^https?:/.test(tabUrl) && (looksLikePdfUrl(tabUrl) || (await isPdfByContentType(tabUrl)))) {
    return clipPdf(tabUrl, tab.title ?? '');
  }
  const mode: ClipMode = opts.mode ?? 'article';
  const images: ClipImages = opts.images ?? 'list';
  const maxBytes = Math.max(1000, Math.min(CLIP_MAX_BYTES, opts.maxBytes ?? CLIP_MAX_BYTES));

  const [metaRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageMeta,
  });
  const meta = metaRes?.result;
  if (!meta) throw new Error('could not read the page (executeScript returned nothing)');

  let markdown: string;
  let selection: ClipSelection | undefined;
  if (mode === 'selection') {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readSelectionInPage,
    });
    const sel = r?.result;
    if (!sel) throw new Error('nothing is selected on the page');
    const doc = parseHtml(`<body>${sel.html}</body>`, meta.url);
    markdown = extractPageMarkdown(
      maxBytes,
      'body',
      doc as unknown as Parameters<typeof extractPageMarkdown>[2],
    ).markdown;
    // A selection inside a single text node has no block structure: the
    // walker yields nothing, but the text is still the clip.
    if (!markdown.trim()) markdown = sel.exact.trim();
    selection = { exact: sel.exact, prefix: sel.prefix, suffix: sel.suffix };
  } else {
    if (images !== 'skip') {
      await chrome.scripting.executeScript({ target: { tabId }, func: resolveLazyImagesInPage });
    }
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageMarkdown,
      args: [maxBytes, mode === 'full' ? 'body' : (opts.selector ?? null)],
    });
    if (!r?.result) throw new Error('could not read the page (executeScript returned nothing)');
    markdown = r.result.markdown;
  }

  const truncated = markdown.endsWith('…[truncated]');
  const pageUrl = meta.url;
  const urls = images === 'skip' ? [] : collectImageUrls(markdown, pageUrl, meta.image);
  const imageRows: ClipImage[] =
    images === 'inline' ? await inlineImages(urls) : urls.map((src) => ({ src }));

  const highlights = (await loadHighlights(pageKey(pageUrl))).map((h) => ({
    id: h.id,
    text: h.exact,
    ...(h.color ? { color: h.color } : {}),
    ...(h.note ? { note: h.note } : {}),
    date: new Date(h.ts).toISOString(),
    anchor: { exact: h.exact, prefix: h.prefix, suffix: h.suffix },
  }));

  const known = await lookupInKb(meta.url, meta.canonical);

  return {
    ...meta,
    mode,
    markdown,
    markdown_length: markdown.length,
    truncated,
    images: imageRows,
    ...(selection ? { selection } : {}),
    ...(highlights.length ? { highlights } : {}),
    ...(known ? { already_in_kb: known } : {}),
    clipped_at: new Date().toISOString(),
  };
}
