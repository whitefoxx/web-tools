// @vitest-environment jsdom
/**
 * MiniDocument (`_mini-dom.ts`) ↔ real DOM parity.
 *
 * `fetch_url {format:"markdown"}` has no page: the MV3 service worker has no DOM
 * and no DOMParser. Instead of writing a second HTML→Markdown converter, it
 * parses the fetched bytes into a MiniDocument and runs `extractPageMarkdown` —
 * the SAME walker `get_page_text` runs inside a tab.
 *
 * That only holds if the mini DOM is faithful, so the core assertion here is
 * DIFFERENTIAL: feed identical HTML to jsdom and to parseHtml, run the same
 * walker over both, demand byte-identical Markdown. A missing DOM API or a
 * parser quirk shows up as a diff instead of as quietly worse output on the
 * fetch path only.
 *
 * (jsdom stands in for Chrome's DOM here; the walker's own semantics are covered
 * by tests/generic-extract-markdown.test.ts.)
 */

import { describe, it, expect } from 'vitest';
import { parseHtml, decodeEntities, MiniDocument } from '../src/tools/generic/_mini-dom';
import { extractPageMarkdown } from '../src/tools/generic/get-page-text';

const MAX = 100_000;

/** Run the walker over jsdom's real DOM. */
function viaRealDom(html: string, selector?: string | null): string {
  document.documentElement.innerHTML = html;
  document.title = 'T';
  return extractPageMarkdown(MAX, selector ?? null).markdown;
}

/** Run the SAME walker over the mini DOM. */
function viaMiniDom(html: string, selector?: string | null): string {
  // Same base as jsdom's document, so absolutized hrefs/srcs compare equal.
  const doc = parseHtml(html, location.href);
  return extractPageMarkdown(
    MAX,
    selector ?? null,
    doc as unknown as Parameters<typeof extractPageMarkdown>[2],
  ).markdown;
}

function bothAgree(html: string, selector?: string | null): string {
  const real = viaRealDom(html, selector);
  const mini = viaMiniDom(html, selector);
  expect(mini).toBe(real);
  return mini;
}

describe('parity: mini DOM vs real DOM through the same walker', () => {
  it('headings, paragraphs, emphasis', () => {
    const md = bothAgree(
      '<body><h1>Title</h1><p>Hello <strong>bold</strong> and <em>it</em>.</p><h2>Sub</h2><p>Second.</p></body>',
    );
    expect(md).toContain('# Title');
    expect(md).toContain('**bold**');
  });

  it('links and images', () => {
    const md = bothAgree(
      '<body><p><a href="/rel">rel</a> <a href="https://a.test/x">abs</a></p><p><img src="/i.png" alt="pic"></p></body>',
    );
    expect(md).toContain('[abs](https://a.test/x)');
    expect(md).toContain(`![pic](${new URL('/i.png', location.href).href})`);
  });

  it('lists, nested lists, ordered lists', () => {
    bothAgree(
      '<body><ul><li>one</li><li>two<ul><li>inner</li></ul></li></ul><ol><li>first</li><li>second</li></ol></body>',
    );
  });

  it('unclosed <li> and <p> (implied end tags)', () => {
    bothAgree('<body><ul><li>one<li>two<li>three</ul><p>a<p>b</body>');
  });

  it('tables, including a header row', () => {
    const md = bothAgree(
      '<body><table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr></table></body>',
    );
    expect(md).toContain('| H1 | H2 |');
    expect(md).toContain('| --- | --- |');
  });

  it('code, pre blocks, blockquote, hr, br', () => {
    bothAgree(
      '<body><p>use <code>x()</code></p><pre><code>line1\nline2</code></pre><blockquote>quoted</blockquote><hr><p>a<br>b</p></body>',
    );
  });

  it('drops script / style / nav / footer / form content', () => {
    const md = bothAgree(
      '<body><nav>NAVLINK</nav><script>var x = "<p>NOPE</p>";</script><style>.a{color:red}</style><p>keep</p><footer>FOOT</footer></body>',
    );
    expect(md).toContain('keep');
    expect(md).not.toContain('NAVLINK');
    expect(md).not.toContain('NOPE');
    expect(md).not.toContain('FOOT');
  });

  it('honors aria-hidden', () => {
    const md = bothAgree('<body><p aria-hidden="true">gone</p><p>kept</p></body>');
    expect(md).not.toContain('gone');
  });

  it('prefers <main> over the rest of the body', () => {
    const md = bothAgree('<body><p>outside</p><main><p>inside</p></main></body>');
    expect(md).toContain('inside');
    expect(md).not.toContain('outside');
  });

  it('prefers <article>, and [role=main]', () => {
    bothAgree('<body><p>out</p><article><p>in</p></article></body>');
    bothAgree('<body><p>out</p><div role="main"><p>in</p></div></body>');
  });

  it('scopes to a selector: tag, #id, .class, [attr]', () => {
    const html =
      '<body><div id="a"><p>A</p></div><div class="b c"><p>B</p></div><section data-x="1"><p>C</p></section></body>';
    expect(bothAgree(html, '#a')).toContain('A');
    expect(bothAgree(html, '.b')).toContain('B');
    expect(bothAgree(html, '[data-x="1"]')).toContain('C');
    expect(bothAgree(html, 'section')).toContain('C');
  });

  it('scopes to a descendant selector', () => {
    expect(
      bothAgree('<body><div id="w"><span class="t"><p>deep</p></span></div></body>', '#w .t'),
    ).toContain('deep');
  });

  it('a selector matching nothing yields empty markdown on both', () => {
    expect(bothAgree('<body><p>x</p></body>', '#nope')).toBe('');
  });

  it('decodes entities the same way', () => {
    bothAgree('<body><p>a &amp; b &lt;tag&gt; &quot;q&quot; &#65; &#x42; &nbsp;end</p></body>');
  });

  it('survives a realistic messy document', () => {
    bothAgree(`
      <!DOCTYPE html>
      <html lang="en">
      <head><title>Doc</title><meta charset="utf-8"><link rel="icon" href="/f.ico"></head>
      <body class="x">
        <!-- a comment with <p>markup</p> inside -->
        <header><h1>Site</h1></header>
        <main>
          <h1>Real Title</h1>
          <p>Intro with <a href="/l">a link</a> &amp; an entity.</p>
          <ul><li>alpha<li>beta</ul>
          <table><tr><th>k</th><th>v</th></tr><tr><td>1</td><td>2</td></tr></table>
          <img src=/bare.png alt=Bare>
          <p>Trailing</p>
        </main>
        <footer>©</footer>
      </body></html>`);
  });
});

describe('parseHtml — parser specifics', () => {
  it('extracts <title> and the url into the document facade', () => {
    const doc = parseHtml(
      '<html><head><title>My &amp; Page</title></head><body><p>x</p></body></html>',
      'https://a.test/',
    );
    expect(doc).toBeInstanceOf(MiniDocument);
    expect(doc.title).toBe('My & Page');
    expect(doc.location.href).toBe('https://a.test/');
  });

  it('never throws on malformed input', () => {
    for (const bad of [
      '<div><p>unclosed',
      '</div></p>stray closes',
      '<a href="x">text', // eslint-disable-line
      '<<>><p>weird</p>',
      '<script>if (a<b) { }</script><p>after</p>',
      '',
    ]) {
      expect(() => parseHtml(bad, 'u')).not.toThrow();
    }
    // The script body must not have eaten the paragraph after it.
    const doc = parseHtml('<body><script>if (a<b) { x("</p>") }</script><p>after</p></body>', 'u');
    expect(extractPageMarkdown(MAX, null, doc as never).markdown).toContain('after');
  });

  it('treats void + self-closing elements as childless', () => {
    const doc = parseHtml('<body><p>a<br>b<img src="i"/>c</p><p>next</p></body>', 'u');
    const md = extractPageMarkdown(MAX, null, doc as never).markdown;
    expect(md).toContain('next'); // <br>/<img> did not swallow the rest of the tree
  });

  it('decodeEntities leaves unknown entities untouched', () => {
    expect(decodeEntities('a &amp; b &notareal; c')).toBe('a & b &notareal; c');
    expect(decodeEntities('no entities')).toBe('no entities');
  });
});
