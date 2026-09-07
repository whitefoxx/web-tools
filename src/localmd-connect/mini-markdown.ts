/**
 * Just enough Markdown to read an answer in a popover.
 *
 * Not a CommonMark implementation and not trying to be. A model asked to
 * explain a passage answers in paragraphs, the occasional bullet list, some
 * bold, and now and then a fenced code block — so those are what this renders,
 * and everything it does not know stays exactly as the model typed it. Showing
 * `**like this**` was the alternative, and telling the model not to use
 * Markdown would throw away structure it produces for free.
 *
 * It builds NODES, never HTML. Nothing here concatenates a string and assigns
 * it to innerHTML, because the text comes from a model and lands in a shadow
 * root inside somebody's page: an `<img onerror=…>` in an answer would run
 * there. Building elements makes that unrepresentable rather than filtered.
 */

/** Where a link may point. A model writing `[x](javascript:…)` is not a threat
 *  anyone has met, and it is one line to make it impossible. */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

/**
 * The spans worth marking up, in the order they must be tried.
 *
 * Two guards earned by real text rather than by the spec:
 *   • the character after an opening delimiter may not be a space, so `2 * 3`
 *     and `a * b * c` are arithmetic, not emphasis;
 *   • `_` may not be flanked by alphanumerics, so `a_variable_name` survives an
 *     explanation about code — which is exactly where one turns up.
 */
const INLINE = new RegExp(
  [
    '(`[^`\n]+`)',
    '(\\*\\*[^\\s*][^*\n]*\\*\\*)',
    '((?<![A-Za-z0-9])__[^\\s_][^_\n]*__(?![A-Za-z0-9]))',
    '(\\*[^\\s*][^*\n]*\\*)',
    '((?<![A-Za-z0-9])_[^\\s_][^_\n]*_(?![A-Za-z0-9]))',
    '(\\[[^\\]\n]+\\]\\([^)\\s]+\\))',
  ].join('|'),
);

/** One line of text → nodes, with the spans Markdown marks up. Unmatched
 *  punctuation is text: a lone asterisk is a lone asterisk. */
function inline(target: Node, text: string): void {
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) break;
    if (m.index > 0) target.appendChild(document.createTextNode(rest.slice(0, m.index)));
    const tok = m[0];
    if (tok.startsWith('`')) {
      const el = document.createElement('code');
      el.textContent = tok.slice(1, -1);
      target.appendChild(el);
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      const el = document.createElement('strong');
      el.textContent = tok.slice(2, -2);
      target.appendChild(el);
    } else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](');
      const label = tok.slice(1, cut);
      const href = safeHref(tok.slice(cut + 2, -1));
      if (href) {
        const el = document.createElement('a');
        el.href = href;
        el.target = '_blank';
        el.rel = 'noreferrer noopener';
        el.textContent = label;
        target.appendChild(el);
      } else {
        target.appendChild(document.createTextNode(label));
      }
    } else {
      const el = document.createElement('em');
      el.textContent = tok.slice(1, -1);
      target.appendChild(el);
    }
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) target.appendChild(document.createTextNode(rest));
}

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBER = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** Render `text` into `target`, replacing whatever was there. */
export function renderMarkdown(target: HTMLElement, text: string): void {
  target.textContent = '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let list: HTMLElement | null = null;

  const flushPara = (): void => {
    if (!para.length) return;
    const p = document.createElement('p');
    // Lines inside one paragraph are joined, the way a reader expects prose to
    // reflow — a hard wrap in the model's output is not a line break.
    inline(p, para.join(' '));
    target.appendChild(p);
    para = [];
  };
  const flushAll = (): void => {
    flushPara();
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushAll();
      const buf: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) buf.push(lines[i]);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = buf.join('\n');
      pre.appendChild(code);
      target.appendChild(pre);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushAll();
      const el = document.createElement('div');
      el.className = 'md-h';
      inline(el, h[2]);
      target.appendChild(el);
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      flushAll();
      const el = document.createElement('blockquote');
      inline(el, q[1]);
      target.appendChild(el);
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBER.exec(line);
    if (b || n) {
      flushPara();
      const want = b ? 'UL' : 'OL';
      if (!list || list.tagName !== want) {
        list = document.createElement(want === 'UL' ? 'ul' : 'ol');
        target.appendChild(list);
      }
      const li = document.createElement('li');
      inline(li, (b ? b[1] : n![2]).trim());
      list.appendChild(li);
      continue;
    }
    list = null;
    para.push(line.trim());
  }
  flushAll();
}
