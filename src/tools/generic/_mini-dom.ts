/**
 * A minimal, dependency-free HTML → tree parser for the SERVICE WORKER.
 *
 * Why this exists: MV3 service workers have no DOM and no `DOMParser`, which is
 * why the Markdown walker (`extractPageMarkdown`) normally runs inside the page
 * via `executeScript`. `fetch_url` has no page — it holds bytes. Rather than
 * write a second HTML→Markdown converter (two dialects that drift apart, two
 * sets of bugs), this parses the bytes into the SMALLEST tree that satisfies the
 * DOM surface that walker actually touches, and the SAME walker runs over it.
 *
 * The implemented surface is therefore deliberately closed. Nodes expose:
 *   nodeType (1 element / 3 text), tagName (UPPERCASE), childNodes, children,
 *   textContent, getAttribute(), closest(tag), querySelector(), querySelectorAll()
 * and the document exposes: title, body, location.href, querySelector().
 * Anything outside that is out of scope on purpose — if the walker grows a new
 * DOM call, the parity test goes red rather than the fetch path silently
 * degrading. See tests/mini-dom-parity.test.ts.
 *
 * Selector support is a documented SUBSET, sized to what the walker needs
 * ('main, article, [role="main"]', 'tr', 'th,td', 'pre') plus the simple
 * selectors a caller realistically passes: comma groups of
 * `tag#id.class[attr][attr="v"]` compounds with descendant combinators. No
 * child/sibling combinators, no pseudo-classes, no :nth-child. An unsupported
 * selector matches nothing (documented in the tool's arg help) — it never throws.
 */

/** Elements that never have children / a closing tag. */
const VOID = new Set([
  'AREA',
  'BASE',
  'BR',
  'COL',
  'EMBED',
  'HR',
  'IMG',
  'INPUT',
  'LINK',
  'META',
  'PARAM',
  'SOURCE',
  'TRACK',
  'WBR',
]);

/** Elements whose content is raw text, not markup (must not be tokenized). */
const RAW_TEXT = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'TITLE']);

/**
 * Implied end tags: opening `key` auto-closes a still-open `targets` element —
 * but only within `stopAt` SCOPE. The scope half is not optional: without it,
 * `<li>two<ul><li>inner</li></ul></li>` closes the OUTER li when the inner one
 * opens, so the nested list becomes a sibling instead of a child (caught by
 * tests/mini-dom-parity.test.ts as a Markdown diff against the real DOM).
 *
 * `stopAt: null` means "stop at anything that isn't inline" — the rule for <p>,
 * which may not contain block content at all.
 *
 * Enough to survive real-world unclosed markup without a full HTML5
 * tree-construction state machine.
 */
const CLOSES: Record<string, { targets: readonly string[]; stopAt: readonly string[] | null }> = {
  P: { targets: ['P'], stopAt: null },
  LI: { targets: ['LI'], stopAt: ['UL', 'OL', 'MENU'] },
  DT: { targets: ['DT', 'DD'], stopAt: ['DL'] },
  DD: { targets: ['DT', 'DD'], stopAt: ['DL'] },
  TR: { targets: ['TD', 'TH', 'TR'], stopAt: ['TABLE'] },
  TD: { targets: ['TD', 'TH'], stopAt: ['TABLE'] },
  TH: { targets: ['TD', 'TH'], stopAt: ['TABLE'] },
  THEAD: { targets: ['TD', 'TH', 'TR'], stopAt: ['TABLE'] },
  TBODY: { targets: ['TD', 'TH', 'TR', 'THEAD'], stopAt: ['TABLE'] },
  TFOOT: { targets: ['TD', 'TH', 'TR', 'TBODY'], stopAt: ['TABLE'] },
  OPTION: { targets: ['OPTION'], stopAt: ['SELECT', 'DATALIST'] },
};

/** Phrasing content a `<p>` can legally sit inside of — the scan for an implied
 * `</p>` passes through these and stops at anything else. */
const INLINE = new Set([
  'A',
  'ABBR',
  'B',
  'BDI',
  'BDO',
  'CITE',
  'CODE',
  'DEL',
  'DFN',
  'EM',
  'I',
  'INS',
  'KBD',
  'LABEL',
  'MARK',
  'Q',
  'S',
  'SAMP',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TIME',
  'U',
  'VAR',
]);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  laquo: '«',
  raquo: '»',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);?/gi, (m, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // Reject non-characters / out-of-range rather than emitting U+FFFD garbage.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const hit = ENTITIES[ref.toLowerCase()];
    return hit ?? m;
  });
}

export class MiniNode {
  /** 1 = element, 3 = text (mirrors Node.ELEMENT_NODE / Node.TEXT_NODE). */
  readonly nodeType: 1 | 3;
  readonly tagName: string;
  readonly attrs: Record<string, string>;
  readonly childNodes: MiniNode[] = [];
  parentNode: MiniNode | null = null;
  private readonly text: string;

  constructor(nodeType: 1 | 3, tagName = '', attrs: Record<string, string> = {}, text = '') {
    this.nodeType = nodeType;
    this.tagName = tagName;
    this.attrs = attrs;
    this.text = text;
  }

  /** Element children only (the walker uses this for LI collection). */
  get children(): MiniNode[] {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.text;
    let out = '';
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name.toLowerCase()] ?? null;
  }

  closest(sel: string): MiniNode | null {
    const groups = parseSelector(sel);
    for (let n: MiniNode | null = this; n; n = n.parentNode) {
      if (n.nodeType === 1 && groups.some((g) => matchesCompound(n as MiniNode, g[g.length - 1])))
        return n;
    }
    return null;
  }

  querySelector(sel: string): MiniNode | null {
    return this.querySelectorAll(sel, true)[0] ?? null;
  }

  querySelectorAll(sel: string, firstOnly = false): MiniNode[] {
    const groups = parseSelector(sel);
    if (!groups.length) return [];
    const out: MiniNode[] = [];
    const visit = (n: MiniNode): boolean => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (groups.some((g) => matchesDescendantChain(c, g))) {
          out.push(c);
          if (firstOnly) return true;
        }
        if (visit(c)) return true;
      }
      return false;
    };
    visit(this);
    return out;
  }
}

/** The document facade `extractPageMarkdown` is handed. */
export class MiniDocument {
  readonly title: string;
  readonly body: MiniNode;
  readonly location: { href: string };
  private readonly root: MiniNode;

  constructor(root: MiniNode, title: string, href: string) {
    this.root = root;
    this.body = (root.querySelector('body') ?? root) as MiniNode;
    this.title = title;
    this.location = { href };
  }

  querySelector(sel: string): MiniNode | null {
    return this.root.querySelector(sel);
  }

  /** Whole-document match (extractPageMeta's JSON-LD pass). */
  querySelectorAll(sel: string): MiniNode[] {
    return this.root.querySelectorAll(sel);
  }
}

/* ── selectors: comma groups of descendant-separated compounds ───────────── */

interface Compound {
  tag: string | null; // UPPERCASE, null = *
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
  valid: boolean;
}

const selectorCache = new Map<string, Compound[][]>();

function parseSelector(sel: string): Compound[][] {
  const cached = selectorCache.get(sel);
  if (cached) return cached;
  const groups: Compound[][] = [];
  for (const part of sel.split(',')) {
    const chain = part.trim().split(/\s+/).filter(Boolean).map(parseCompound);
    // A group containing anything we can't express matches nothing at all —
    // better a visibly empty result than a silently wrong one.
    if (chain.length && chain.every((c) => c.valid)) groups.push(chain);
  }
  if (selectorCache.size < 200) selectorCache.set(sel, groups);
  return groups;
}

function parseCompound(src: string): Compound {
  const c: Compound = { tag: null, id: null, classes: [], attrs: [], valid: true };
  let rest = src;
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tagMatch) {
    c.tag = tagMatch[0].toUpperCase();
    rest = rest.slice(tagMatch[0].length);
  } else if (rest.startsWith('*')) {
    rest = rest.slice(1);
  }
  while (rest) {
    if (rest[0] === '#') {
      const m = /^#([\w-]+)/.exec(rest);
      if (!m) return { ...c, valid: false };
      c.id = m[1];
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '.') {
      const m = /^\.([\w-]+)/.exec(rest);
      if (!m) return { ...c, valid: false };
      c.classes.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '[') {
      const m = /^\[([\w:-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|\s*=\s*([^\]]*))?\]/.exec(rest);
      if (!m) return { ...c, valid: false };
      c.attrs.push({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? null });
      rest = rest.slice(m[0].length);
    } else {
      return { ...c, valid: false }; // combinator / pseudo-class / unsupported
    }
  }
  return c;
}

function matchesCompound(el: MiniNode, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  if (c.classes.length) {
    const cls = (el.getAttribute('class') ?? '').split(/\s+/);
    if (!c.classes.every((k) => cls.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== null && v !== a.value) return false;
  }
  return true;
}

/** `a b c` — every compound must match somewhere up the ancestor chain, in order. */
function matchesDescendantChain(el: MiniNode, chain: Compound[]): boolean {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let n = el.parentNode; n && i >= 0; n = n.parentNode) {
    if (n.nodeType === 1 && matchesCompound(n, chain[i])) i--;
  }
  return i < 0;
}

/* ── the parser ─────────────────────────────────────────────────────────── */

const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR_RE = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!src.trim()) return out;
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src))) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/**
 * Parse an HTML document into a MiniDocument. Tolerant by design: unknown tags
 * nest normally, stray close tags are dropped, unclosed elements are closed by
 * the implied-end-tag table or at EOF. Never throws — malformed bytes yield a
 * partial tree, which is what a "read the page" tool wants.
 */
export function parseHtml(html: string, url = ''): MiniDocument {
  const root = new MiniNode(1, 'ROOT');
  const stack: MiniNode[] = [root];
  const top = (): MiniNode => stack[stack.length - 1];
  let title = '';
  let pos = 0;

  const addText = (raw: string): void => {
    if (!raw) return;
    const node = new MiniNode(3, '', {}, decodeEntities(raw));
    node.parentNode = top();
    top().childNodes.push(node);
  };

  // Comments / doctype / CDATA are skipped wholesale before tag scanning.
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(stripped))) {
    const [full, closing, rawName, rawAttrs, selfClose] = m;
    if (m.index > pos) addText(stripped.slice(pos, m.index));
    pos = m.index + full.length;
    const tag = rawName.toUpperCase();

    if (closing) {
      // Pop to the nearest matching open element; ignore if never opened.
      const at = stack.map((n) => n.tagName).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }

    if (tag === 'HTML' || tag === 'HEAD') {
      // Structural wrappers we don't need — their children flow into root/body.
      continue;
    }

    // Implied end tags, scope-aware: scan DOWN from the top of the stack and pop
    // at the first target — but give up the moment a scope boundary is crossed,
    // so a nested list/table closes nothing in its parent (see CLOSES).
    const implied = CLOSES[tag];
    if (implied) {
      for (let i = stack.length - 1; i > 0; i--) {
        const t = stack[i].tagName;
        if (implied.targets.includes(t)) {
          stack.length = i;
          break;
        }
        if (implied.stopAt ? implied.stopAt.includes(t) : !INLINE.has(t)) break;
      }
    }

    const el = new MiniNode(1, tag, parseAttrs(rawAttrs));
    el.parentNode = top();
    top().childNodes.push(el);

    if (RAW_TEXT.has(tag)) {
      // Consume to the matching close tag verbatim — script/style bodies must
      // never be tokenized as markup (a `<` inside JS would wreck the tree).
      const close = new RegExp(`</${rawName}\\s*>`, 'i');
      const rest = stripped.slice(pos);
      const hit = close.exec(rest);
      const body = hit ? rest.slice(0, hit.index) : rest;
      if (tag === 'TITLE') title = decodeEntities(body).trim();
      else {
        const t = new MiniNode(3, '', {}, body);
        t.parentNode = el;
        el.childNodes.push(t);
      }
      pos += hit ? hit.index + hit[0].length : rest.length;
      TAG_RE.lastIndex = pos;
      continue;
    }

    if (!VOID.has(tag) && !selfClose) stack.push(el);
  }
  if (pos < stripped.length) addText(stripped.slice(pos));

  return new MiniDocument(root, title, url);
}
