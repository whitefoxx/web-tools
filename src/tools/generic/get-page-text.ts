import { cli } from '../../runtime/registry.js';
import { assertHttpUrl, assertTabId, waitForPageReady } from './_helpers';
import { createAgentTab } from '../../background/agent-window';
import { adoptTab } from '../../background/controlled-tabs';

const MAX_TEXT_BYTES = 100_000;

cli({
  site: 'generic',
  name: 'get_page_text',
  access: 'read',
  description:
    '**Read a page in ONE call — do NOT open_url first.** Pass `url` and this opens the page itself, waits for it to settle, grabs the text and closes the tab (use it like WebFetch). This RENDERS the page in a real tab, so it is the right tool for SPAs / JS-built content — but a **server-rendered** page (article, docs, blog, README, news) is cheaper still via `fetch_url {url, format:"markdown"}`, which needs no tab at all; come back here when that returns empty or is missing the JS-built parts. Three modes: ① url — one-shot fetch (the tab is gone afterwards, so the result carries NO tab id); ② url + keep_open:true — same, but the tab stays open and its `tabId` comes back, so you can go on to scroll_page / get_interactives / click on the very page you just read (this is the one-call replacement for open_url → get_page_text); ③ tab_id — grab in place from an already-open tab (not closed, preserving its SPA route / scroll / popup state; use after scroll_page has loaded more of a feed). format: "text" (default, plain innerText) or "markdown" (preserves heading/link/list/table structure, better for a model to read). Optional selector grabs only one element. Truncated to 100KB. **Prefer this for reading pages (it is cheap); don\'t reach for screenshot casually — images are token-heavy, only screenshot for visual/layout/non-text tasks or when you need visual confirmation.**',
  args: [
    {
      name: 'url',
      type: 'string',
      help: 'URL of the page to grab (http/https). One of url / tab_id. Reading a page needs nothing more than this — no open_url first',
    },
    {
      name: 'tab_id',
      type: 'int',
      help: 'id of an already-open tab (from open_url, or from a previous keep_open:true call). One of url / tab_id (grabs in place, not closed)',
    },
    {
      name: 'keep_open',
      type: 'bool',
      help: 'url mode only: keep the freshly-opened tab open and return its `tabId` (default false = close it right after grabbing). Pass true when you may want to scroll / click / re-read that same page afterwards — it saves the separate open_url call',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'Optional CSS selector; grabs only the content inside that element. Omit to grab the body / whole page',
    },
    {
      name: 'format',
      type: 'string',
      default: 'text',
      help: '"text" = plain body text (default); "markdown" = body Markdown (preserves heading/link/list/table structure)',
    },
    {
      name: 'max_wait_ms',
      type: 'int',
      help: 'Max total load-wait time (ms). Default 15000 in url mode; 3000 in tab_id mode (the page is usually already ready)',
    },
    {
      name: 'quiet_ms',
      type: 'int',
      help: 'How long the innerText length must stay unchanged to count as stable (ms). Default 800 in url mode; 600 in tab_id mode',
    },
    {
      name: 'wait_for_selector',
      type: 'string',
      help: 'Optional: grab as soon as this CSS selector matches an element (short-circuits the stability check)',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const urlArg = typeof kwargs.url === 'string' && kwargs.url.trim() ? kwargs.url.trim() : null;
    const hasTabId = kwargs.tab_id != null && kwargs.tab_id !== '';
    if (!urlArg && !hasTabId) {
      throw new Error('need either url (grab a new page) or tab_id (grab an already-open tab)');
    }
    if (urlArg && hasTabId) throw new Error('pass only one of url and tab_id');

    const format = kwargs.format === 'markdown' ? 'markdown' : 'text';
    const selector = typeof kwargs.selector === 'string' ? kwargs.selector : undefined;
    const waitForSelector =
      typeof kwargs.wait_for_selector === 'string' ? kwargs.wait_for_selector : undefined;

    // url mode opens its own tab — throwaway (closed in finally) unless keep_open,
    // which hands the live tab back for follow-up actions; tab_id mode operates in
    // place on the caller's tab and leaves it open. Defaults differ: a fresh load
    // needs a longer settle than an already-open tab.
    const keepOpen = !!kwargs.keep_open;
    let tabId: number;
    let ownTab = false;
    let createdTab = false;
    let maxWaitMs: number;
    let quietMs: number;
    if (urlArg) {
      const url = assertHttpUrl(urlArg);
      maxWaitMs = Number(kwargs.max_wait_ms ?? 15_000);
      quietMs = Number(kwargs.quiet_ms ?? 800);
      // Open in the dedicated agent window, not the user's focused window.
      const tab = await createAgentTab(url, { active: false });
      if (typeof tab.id !== 'number') throw new Error('failed to open tab');
      tabId = tab.id;
      // Only a THROWAWAY tab is closed in `finally`. A kept tab is a real agent
      // tab from here on: adopt it into the Web Agent group (same as open_url) so
      // the user can tell it apart and the run-tab janitor can reap it.
      ownTab = !keepOpen;
      createdTab = keepOpen;
      if (keepOpen) {
        try {
          await adoptTab(tabId);
        } catch {
          /* grouping is best-effort */
        }
      }
    } else {
      const tab = await assertTabId(kwargs.tab_id);
      tabId = tab.id!;
      maxWaitMs = Math.max(500, Math.min(30_000, Number(kwargs.max_wait_ms ?? 3000)));
      quietMs = Math.max(100, Math.min(5000, Number(kwargs.quiet_ms ?? 600)));
    }

    // Tab-lifecycle half of the result. NEVER hand back a tabId for a tab we are
    // about to close in `finally`: the model reads `tabId` as "the page is still
    // there" and calls scroll_page / click on it → "tab N no longer exists
    // (closed?)". A closed grab says so instead (§10.x); a kept one carries the
    // live id + `created_tab` so the janitor knows it owns it.
    const tabInfo = ownTab
      ? { tab_closed: true as const }
      : { tabId, ...(createdTab ? { created_tab: true as const } : {}) };
    try {
      const wait = await waitForPageReady(tabId, { maxWaitMs, quietMs, waitForSelector });
      // Markdown conversion runs IN THE PAGE (Turndown needs a DOM; the MV3
      // service worker has none), via a self-contained walker. Two separate
      // executeScript calls so each keeps its own precise return type.
      if (format === 'markdown') {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractPageMarkdown,
          args: [MAX_TEXT_BYTES, selector ?? null],
        });
        const r = results[0]?.result;
        if (!r) throw new Error('executeScript returned no result');
        return { format, ...r, ...tabInfo, wait };
      }
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string | null, maxBytes: number) => {
          const text = sel
            ? ((document.querySelector(sel) as HTMLElement | null)?.innerText ?? '')
            : (document.body?.innerText ?? '');
          return {
            title: document.title,
            url: location.href,
            text: text.slice(0, maxBytes),
            truncated: text.length > maxBytes,
            full_length: text.length,
          };
        },
        args: [selector ?? null, MAX_TEXT_BYTES],
      });
      const r = results[0]?.result;
      if (!r) throw new Error('executeScript returned no result');
      return { format, ...r, ...tabInfo, wait };
    } finally {
      if (ownTab) {
        try {
          await chrome.tabs.remove(tabId);
        } catch {}
      }
    }
  },
});

/**
 * DOM → Markdown. Self-contained (executeScript serializes only this function —
 * no imports / module refs) so it can't reuse the runtime's Turndown
 * `htmlToMarkdown` (that needs a DOM the service worker lacks). A pragmatic
 * "lite" converter: headings / paragraphs / links / lists / emphasis / code /
 * blockquote / images / basic tables — enough for readable extraction; for
 * precise structured data the agent still uses eval_js / adapters. Exported so
 * it's unit-testable under jsdom.
 *
 * `selector` scopes extraction to one element (mirrors the text path: a
 * selector that matches nothing yields empty markdown, NOT a body fallback).
 *
 * `doc` is the ONE seam that lets this run outside a page. In a tab it defaults
 * to the live `document` (the default is evaluated in the page, after
 * serialization — never in the service worker). `fetch_url {format:"markdown"}`
 * instead hands it a MiniDocument parsed from fetched bytes (`_mini-dom.ts`), so
 * the tab-rendered and the raw-fetch paths emit the SAME Markdown dialect from
 * the SAME walker instead of drifting into two. Keep every DOM API used below
 * inside the surface `_mini-dom.ts` implements — adding one silently breaks the
 * fetch path only (tests/mini-dom-parity.test.ts is the tripwire).
 */
export function extractPageMarkdown(
  maxBytes: number,
  selector?: string | null,
  doc: {
    title: string;
    body: unknown;
    location?: { href: string } | null;
    querySelector(sel: string): unknown;
  } = document,
): {
  title: string;
  url: string;
  markdown: string;
} {
  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'SVG',
    'CANVAS',
    'IFRAME',
    'TEMPLATE',
    'NAV',
    'FOOTER',
    'HEADER',
    'ASIDE',
    'FORM',
    'BUTTON',
    'SELECT',
    'INPUT',
    'TEXTAREA',
  ]);
  /* Main-content pick (no selector): a page that DECLARES its main content —
   * `<main>` / `<article>` / `[role=main]` — is taken at its word. Only a page
   * with no such root gets the density scorer below, which finds the element
   * holding the prose so body-scoped extraction stops returning nav, sidebar
   * and footer chrome (Hacker News is the standard example: table layout, no
   * semantic markup).
   *
   * Readability-lite: every paragraph-like element (P / PRE / LI / BLOCKQUOTE /
   * TD) with ≥25 chars credits its parent in full and its grandparent by half;
   * the top scorer wins when it carries most of the scope's paragraph text AND
   * is not link-dominated. Otherwise the scope is kept whole — a forum thread
   * or a feed is many small blocks and narrowing to one would lose the page.
   *
   * NOT applied inside a semantic root, though the first version was, because a
   * real-page corpus said so: on MDN it narrowed `<main>` to the method list and
   * dropped the article's intro (docs/localmd-connect.md §14.3). Losing real
   * prose is worse than keeping some chrome, and this walker is shared by all
   * three shells' get_page_text. Pure over the mini-DOM surface
   * (querySelectorAll / textContent / parentNode / closest). */
  type El = {
    nodeType: number;
    tagName: string;
    textContent: string | null;
    parentNode: El | null;
    getAttribute(n: string): string | null;
    querySelectorAll(sel: string): ArrayLike<El> & Iterable<El>;
  };
  const PARA = 'p, pre, li, blockquote, td';
  const MIN_PARA_CHARS = 25;
  function paraText(el: El): number {
    let n = 0;
    for (const p of Array.from(el.querySelectorAll(PARA))) {
      const t = (p.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t.length >= MIN_PARA_CHARS) n += t.length;
    }
    return n;
  }
  function linkDensity(el: El): number {
    const total = (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
    if (!total) return 0;
    let links = 0;
    for (const a of Array.from(el.querySelectorAll('a'))) {
      links += (a.textContent ?? '').replace(/\s+/g, ' ').trim().length;
    }
    return links / total;
  }
  function pickMainRoot(scope: El): El {
    const score = new Map<El, number>();
    for (const p of Array.from(scope.querySelectorAll(PARA))) {
      const t = (p.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t.length < MIN_PARA_CHARS) continue;
      const pts = Math.min(t.length, 1000);
      const parent = p.parentNode;
      if (parent && parent.nodeType === 1 && parent !== scope) {
        score.set(parent, (score.get(parent) ?? 0) + pts);
        const gp = parent.parentNode;
        if (gp && gp.nodeType === 1 && gp !== scope) score.set(gp, (score.get(gp) ?? 0) + pts / 2);
      }
    }
    let best: El | null = null;
    let bestScore = 0;
    for (const [el, sc] of score) {
      if (sc > bestScore) {
        best = el;
        bestScore = sc;
      }
    }
    if (!best) return scope;
    const scopeText = paraText(scope);
    const bestText = paraText(best);
    // The winner must hold the bulk of the prose (else the page is many small
    // blocks — keep them all) and must read as prose, not as a link list.
    if (!scopeText || bestText < scopeText * 0.6 || linkDensity(best) > 0.5) return scope;
    return best;
  }
  const semantic = doc.querySelector('main, article, [role="main"]') as El | null;
  const root = (
    selector ? doc.querySelector(selector) : (semantic ?? pickMainRoot(doc.body as El))
  ) as HTMLElement | null;

  // Links and images come out ABSOLUTE. A model reading `[Details](/item?id=7)`
  // cannot follow it without the base, and a clip saved into a knowledge base
  // has no base at all — so every href/src is resolved against the page here,
  // on both the tab and the raw-fetch path (both hand over `location.href`).
  const base = doc.location?.href ?? '';
  function absolute(target: string): string {
    if (!target || !base || /^(javascript:|data:|mailto:|tel:|#)/i.test(target)) return target;
    try {
      return new URL(target, base).href;
    } catch {
      return target;
    }
  }

  /** One table cell, through the SAME walker as everything else — cells used
   * to be flattened with `textContent`, which silently ate every link inside
   * them. On a table-LAID-OUT page (Hacker News is the standard example) that
   * meant a clip with zero URLs. Block markup inside a cell is collapsed onto
   * one line, and a literal pipe is escaped, so the row still parses. */
  function cellToMd(c: Element): string {
    return Array.from(c.childNodes)
      .map((n) => toMd(n, 0))
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/\|/g, '\\|')
      .trim();
  }

  function tableToMd(table: Element): string {
    // Only THIS table's own rows/cells: querySelectorAll descends into nested
    // tables, and a layout table full of them would otherwise emit every inner
    // row twice — once inside its parent cell, once as a row of its own.
    const rows = Array.from(table.querySelectorAll('tr')).filter(
      (tr) => tr.closest('table') === table,
    );
    const out: string[] = [];
    rows.forEach((tr, i) => {
      const cs = Array.from(tr.querySelectorAll('th,td'))
        .filter((c) => c.closest('tr') === tr)
        .map(cellToMd);
      if (!cs.length) return;
      out.push('| ' + cs.join(' | ') + ' |');
      if (i === 0) out.push('| ' + cs.map(() => '---').join(' | ') + ' |');
    });
    return out.join('\n');
  }

  function toMd(node: Node, depth: number): string {
    if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const el = node as HTMLElement;
    if (
      SKIP.has(el.tagName) ||
      el.getAttribute('aria-hidden') === 'true' ||
      el.getAttribute('hidden') !== null
    )
      return '';
    const kids = (): string =>
      Array.from(el.childNodes)
        .map((n) => toMd(n, depth))
        .join('');
    switch (el.tagName) {
      case 'H1':
        return `\n\n# ${kids().trim()}\n\n`;
      case 'H2':
        return `\n\n## ${kids().trim()}\n\n`;
      case 'H3':
        return `\n\n### ${kids().trim()}\n\n`;
      case 'H4':
      case 'H5':
      case 'H6':
        return `\n\n#### ${kids().trim()}\n\n`;
      case 'P':
        return `\n\n${kids().trim()}\n\n`;
      case 'BR':
        return '  \n';
      case 'HR':
        return '\n\n---\n\n';
      case 'STRONG':
      case 'B': {
        const s = kids().trim();
        return s ? `**${s}**` : '';
      }
      case 'EM':
      case 'I': {
        const s = kids().trim();
        return s ? `*${s}*` : '';
      }
      case 'CODE': {
        if (el.closest('pre')) return el.textContent ?? '';
        const s = (el.textContent ?? '').trim();
        return s ? '`' + s + '`' : '';
      }
      case 'PRE':
        return `\n\n\`\`\`\n${(el.textContent ?? '').replace(/\n+$/, '')}\n\`\`\`\n\n`;
      case 'BLOCKQUOTE':
        return `\n\n${kids()
          .trim()
          .split('\n')
          .map((l) => '> ' + l)
          .join('\n')}\n\n`;
      case 'A': {
        const s = kids().trim();
        if (!s) return '';
        const href = absolute(el.getAttribute('href') || '');
        return href && !href.startsWith('javascript:') ? `[${s}](${href})` : s;
      }
      case 'IMG': {
        const alt = el.getAttribute('alt') || '';
        const src = absolute(el.getAttribute('src') || '');
        return alt || src ? `![${alt}](${src})` : '';
      }
      case 'UL':
      case 'OL': {
        const ordered = el.tagName === 'OL';
        const items = Array.from(el.children).filter((c) => c.tagName === 'LI');
        return (
          '\n' +
          items
            .map((li, i) => {
              const bullet = '  '.repeat(depth) + (ordered ? `${i + 1}. ` : '- ');
              const inner = Array.from(li.childNodes)
                .map((n) => toMd(n, depth + 1))
                .join('')
                .trim()
                .replace(/\n+/g, ' ');
              return bullet + inner;
            })
            .join('\n') +
          '\n'
        );
      }
      case 'TABLE':
        return `\n\n${tableToMd(el)}\n\n`;
      default:
        return kids();
    }
  }

  const md = (root ? toMd(root, 0) : '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title: doc.title,
    url: doc.location?.href ?? '',
    markdown: md.length > maxBytes ? md.slice(0, maxBytes) + '\n…[truncated]' : md,
  };
}

/**
 * Page metadata for a clip's frontmatter: canonical URL, Open Graph / Twitter
 * cards, article dates and author, description, language, site name — plus a
 * JSON-LD pass for `datePublished` / `author` when the meta tags are silent.
 * Self-contained for the same reason as extractPageMarkdown (it runs in the
 * page via executeScript), and over the same mini-DOM surface so
 * `fetch_url`-style raw HTML gets the same answers. Every field is optional:
 * absent means the page did not say, never a guess. Exported for jsdom tests.
 */
export interface PageMeta {
  title: string;
  url: string;
  canonical?: string;
  site?: string;
  description?: string;
  author?: string;
  published?: string;
  modified?: string;
  image?: string;
  lang?: string;
  type?: string;
}

export function extractPageMeta(
  doc: {
    title: string;
    location?: { href: string } | null;
    querySelector(sel: string): unknown;
    querySelectorAll?(sel: string): unknown;
  } = document,
): PageMeta {
  type El = { textContent: string | null; getAttribute(n: string): string | null };
  const attr = (sel: string, name: string): string | undefined => {
    const el = doc.querySelector(sel) as El | null;
    const v = el?.getAttribute(name)?.trim();
    return v || undefined;
  };
  const meta = (...names: string[]): string | undefined => {
    for (const n of names) {
      const v = attr(`meta[property="${n}"]`, 'content') ?? attr(`meta[name="${n}"]`, 'content');
      if (v) return v;
    }
    return undefined;
  };
  const out: PageMeta = {
    title: meta('og:title', 'twitter:title') ?? doc.title,
    url: doc.location?.href ?? '',
  };
  const canonical = attr('link[rel="canonical"]', 'href') ?? meta('og:url');
  if (canonical) out.canonical = canonical;
  const site = meta('og:site_name', 'application-name');
  if (site) out.site = site;
  const description = meta('description', 'og:description', 'twitter:description');
  if (description) out.description = description;
  const author = meta('author', 'article:author', 'og:article:author', 'twitter:creator');
  if (author) out.author = author;
  const published = meta(
    'article:published_time',
    'og:article:published_time',
    'datePublished',
    'date',
    'pubdate',
  );
  if (published) out.published = published;
  const modified = meta('article:modified_time', 'og:updated_time', 'dateModified');
  if (modified) out.modified = modified;
  const image = meta('og:image', 'twitter:image');
  if (image) out.image = image;
  const lang = attr('html', 'lang');
  if (lang) out.lang = lang;
  const type = meta('og:type');
  if (type) out.type = type;

  // JSON-LD fills what the meta tags left empty. Best-effort: one bad block
  // must not cost the rest of the metadata.
  const ld = doc.querySelectorAll
    ? (Array.from(
        doc.querySelectorAll('script[type="application/ld+json"]') as ArrayLike<El>,
      ) as El[])
    : [];
  for (const s of ld) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? '');
    } catch {
      continue;
    }
    const nodes: unknown[] = Array.isArray(data)
      ? data
      : data &&
          typeof data === 'object' &&
          Array.isArray((data as { '@graph'?: unknown[] })['@graph'])
        ? (data as { '@graph': unknown[] })['@graph']
        : [data];
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const o = n as Record<string, unknown>;
      const str = (v: unknown): string | undefined => {
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string')
          return ((v as { name: string }).name || '').trim() || undefined;
        if (Array.isArray(v)) return str(v[0]);
        return undefined;
      };
      if (!out.published && str(o.datePublished)) out.published = str(o.datePublished);
      if (!out.modified && str(o.dateModified)) out.modified = str(o.dateModified);
      if (!out.author && str(o.author)) out.author = str(o.author);
      if (!out.description && str(o.description)) out.description = str(o.description);
      if (!out.title && str(o.headline)) out.title = str(o.headline)!;
    }
  }
  return out;
}
