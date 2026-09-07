// @vitest-environment jsdom
/**
 * extractPageMarkdown — in-page DOM→Markdown walker for get_page_text
 * format:"markdown" (browseract-comparison ⑭). Runs in-page (Turndown needs a
 * DOM the SW lacks); a pragmatic lite converter. Tested under jsdom.
 */

import { describe, it, expect } from 'vitest';
import { extractPageMarkdown } from '../src/tools/generic/get-page-text';

function render(html: string, max = 100_000): string {
  document.title = 'T';
  document.body.innerHTML = html;
  return extractPageMarkdown(max).markdown;
}

describe('extractPageMarkdown', () => {
  it('headings + paragraphs + emphasis', () => {
    const md = render(
      '<h1>Title</h1><h2>Sub</h2><p>Hello <strong>world</strong> and <em>you</em>.</p>',
    );
    expect(md).toContain('# Title');
    expect(md).toContain('## Sub');
    expect(md).toContain('Hello **world** and *you*.');
  });

  it('links inline with href', () => {
    expect(render('<p>see <a href="https://x.com/a">X</a></p>')).toContain('[X](https://x.com/a)');
  });

  it('drops javascript: links to plain text', () => {
    const md = render('<p><a href="javascript:void(0)">click</a></p>');
    expect(md).toContain('click');
    expect(md).not.toContain('javascript:');
  });

  it('unordered + ordered lists', () => {
    const md = render('<ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol>');
    expect(md).toContain('- a');
    expect(md).toContain('- b');
    expect(md).toContain('1. one');
    expect(md).toContain('2. two');
  });

  it('inline code and fenced pre', () => {
    expect(render('<p>use <code>x=1</code></p>')).toContain('`x=1`');
    expect(render('<pre>line1\nline2</pre>')).toContain('```');
  });

  it('blockquote', () => {
    expect(render('<blockquote>quoted</blockquote>')).toContain('> quoted');
  });

  it('keeps links and emphasis inside table cells (a table-laid-out page)', () => {
    // textContent flattening used to eat every link in a cell — on a
    // table-laid-out site (Hacker News) that meant a clip with zero URLs.
    const md = render(
      '<table><tr><td><a href="/story?id=1">Title</a></td><td><b>9</b> points</td></tr></table>',
    );
    expect(md).toContain(`[Title](${new URL('/story?id=1', location.href).href})`);
    expect(md).toContain('**9** points');
  });

  it('escapes a literal pipe so the row still parses', () => {
    expect(render('<table><tr><td>a|b</td><td>c</td></tr></table>')).toContain('| a\\|b | c |');
  });

  it('emits a nested table once, inside its parent cell', () => {
    const md = render(
      '<table><tr><td>outer<table><tr><td>INNER</td></tr></table></td></tr></table>',
    );
    expect((md.match(/INNER/g) ?? []).length).toBe(1);
  });

  it('basic table with header separator', () => {
    const md = render('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('images with alt, src made absolute against the page', () => {
    // jsdom's default location is http://localhost:3000/ — the point is that a
    // relative src never survives as-is (a note in a KB has no base).
    expect(render('<p><img src="/a.png" alt="cat"></p>')).toContain(
      `![cat](${new URL('/a.png', location.href).href})`,
    );
  });

  it('relative links come out absolute (the model can follow them)', () => {
    expect(render('<p><a href="/item?id=7">Details</a></p>')).toContain(
      `[Details](${new URL('/item?id=7', location.href).href})`,
    );
    expect(render('<p><a href="#top">Top</a></p>')).toContain('[Top](#top)');
  });

  describe('main-content pick (density scorer)', () => {
    const para = (n: number, w = 'lorem ipsum dolor sit amet consectetur ') =>
      `<p>${w.repeat(n)}</p>`;

    it('narrows a page with NO semantic root to the element holding the prose', () => {
      const md = render(
        '<div class="side"><ul><li>Related: <a href="/a">A</a></li><li>More: <a href="/b">B</a></li></ul></div>' +
          `<div class="article">${para(4)}${para(4)}${para(4)}</div>` +
          '<div class="comments"><p>nice post!</p></div>',
      );
      expect(md).toContain('lorem ipsum');
      expect(md).not.toContain('Related');
      expect(md).not.toContain('nice post');
    });

    it('trusts a declared <main> and does NOT narrow inside it', () => {
      // Corrected by a real-page corpus: narrowing inside <main> dropped MDN's
      // article intro. A page that declares its main content is taken at its
      // word — losing real prose is worse than keeping some chrome.
      const md = render(
        '<main>' +
          '<p>SHORT INTRO PARAGRAPH FOR THE ARTICLE.</p>' +
          `<div class="methods">${para(4)}${para(4)}${para(4)}</div>` +
          '</main>',
      );
      expect(md).toContain('SHORT INTRO');
      expect(md).toContain('lorem ipsum');
    });

    it('still drops chrome OUTSIDE a declared <main>', () => {
      const md = render(`<div class="side">SIDEBAR JUNK</div><main>${para(3)}</main>`);
      expect(md).toContain('lorem ipsum');
      expect(md).not.toContain('SIDEBAR JUNK');
    });

    it('keeps the whole scope when the prose is spread across many blocks (a thread)', () => {
      const md = render(
        `<div class="post">${para(2)}</div><div class="post">${para(2)}</div><div class="post">${para(2)}</div>`,
      );
      expect((md.match(/lorem ipsum/g) ?? []).length).toBe(6);
    });

    it('does not pick a link-dominated block', () => {
      const md = render(
        '<div class="nav">' +
          '<p><a href="/1">A long navigation link label number one here</a></p>'.repeat(4) +
          '</div>' +
          `<div class="body">${para(2)}</div>`,
      );
      expect(md).toContain('lorem ipsum');
      expect(md).toContain('navigation link');
    });

    it('an explicit selector bypasses the pick', () => {
      document.title = 'T';
      document.body.innerHTML = `<main>${para(5)}</main><div id="x"><p>tiny</p></div>`;
      expect(extractPageMarkdown(100_000, '#x').markdown).toBe('tiny');
    });

    it('drops [hidden] elements', () => {
      expect(render('<p hidden>secret</p><p>shown</p>')).not.toContain('secret');
    });
  });

  it('skips script / style / nav boilerplate', () => {
    const md = render(
      '<nav>MENU</nav><script>var junk=1</script><style>.x{}</style><p>content</p>',
    );
    expect(md).not.toContain('MENU');
    expect(md).not.toContain('junk');
    expect(md).toContain('content');
  });

  it('prefers <main>/<article> over surrounding chrome', () => {
    document.title = 'T';
    document.body.innerHTML = '<div>sidebar junk</div><main><p>real content</p></main>';
    const md = extractPageMarkdown(100_000).markdown;
    expect(md).toContain('real content');
    expect(md).not.toContain('sidebar junk');
  });

  it('truncates to maxBytes with a marker', () => {
    document.title = 'T';
    document.body.innerHTML = '<p>' + 'x'.repeat(500) + '</p>';
    const md = extractPageMarkdown(100).markdown;
    expect(md.endsWith('…[truncated]')).toBe(true);
  });

  it('returns title + url', () => {
    document.title = 'My Page';
    document.body.innerHTML = '<p>hi</p>';
    const out = extractPageMarkdown(100_000);
    expect(out.title).toBe('My Page');
    expect(typeof out.url).toBe('string');
  });

  it('selector scopes extraction to one element (get_page_text markdown)', () => {
    document.title = 'T';
    document.body.innerHTML =
      '<main><p>outside</p></main><div id="box"><h2>In</h2><p>inside</p></div>';
    const md = extractPageMarkdown(100_000, '#box').markdown;
    expect(md).toContain('## In');
    expect(md).toContain('inside');
    expect(md).not.toContain('outside');
  });

  it('selector matching nothing yields empty markdown (mirrors the text path)', () => {
    document.title = 'T';
    document.body.innerHTML = '<main><p>content</p></main>';
    expect(extractPageMarkdown(100_000, '#nope').markdown).toBe('');
  });
});
