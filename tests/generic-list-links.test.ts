// @vitest-environment jsdom
/**
 * extractLinks — in-page <a href> collector for the generic list_links tool (the
 * frontier-extraction primitive for agent-orchestrated crawling). Runs in-page
 * via executeScript (self-contained, like extractSerp / extractPageMarkdown), so
 * it's tested here under jsdom. Covers: absolute-URL resolution, http(s)-only
 * filtering, dedup, same-origin / regex / selector-scope filters, limit +
 * total/truncated, text fallbacks, and open-shadow-DOM piercing.
 *
 * jsdom's default document origin is http://localhost/, so relative hrefs
 * resolve to that origin (used for the same-origin cases).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { extractLinks } from '../src/tools/generic/list-links';

// jsdom's document origin (this repo's vitest config uses http://localhost:3000).
const ORIGIN = location.origin;

beforeEach(() => {
  document.title = 'page';
  document.body.innerHTML = '';
});

describe('extractLinks — basics', () => {
  it('collects a[href], resolves to absolute, keeps text', () => {
    document.body.innerHTML = `
      <a href="https://a.com/1">First</a>
      <a href="/rel">Relative</a>`;
    const r = extractLinks(null, false, null, 200);
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.links[0]).toEqual({ url: 'https://a.com/1', text: 'First' });
    expect(r.links[1].url).toBe(`${ORIGIN}/rel`);
  });

  it('drops non-http(s) schemes and fragment-only links', () => {
    document.body.innerHTML = `
      <a href="javascript:void(0)">js</a>
      <a href="mailto:x@y.com">mail</a>
      <a href="tel:123">tel</a>
      <a href="#top">frag</a>
      <a href="https://ok.com/p">ok</a>`;
    const r = extractLinks(null, false, null, 200);
    // "#top" resolves to <origin>/#top (an http url) — kept; the js/mail/tel are dropped.
    expect(r.links.map((l) => l.url).sort()).toEqual([`${ORIGIN}/#top`, 'https://ok.com/p']);
  });

  it('dedupes repeated urls (keeps first text)', () => {
    document.body.innerHTML = `
      <a href="https://d.com/x">one</a>
      <a href="https://d.com/x">two</a>`;
    const r = extractLinks(null, false, null, 200);
    expect(r.total).toBe(1);
    expect(r.links).toEqual([{ url: 'https://d.com/x', text: 'one' }]);
  });

  it('text falls back to aria-label then title when empty', () => {
    document.body.innerHTML = `
      <a href="https://i.com/1" aria-label="icon link"><svg></svg></a>
      <a href="https://i.com/2" title="tip"></a>`;
    const r = extractLinks(null, false, null, 200);
    expect(r.links[0].text).toBe('icon link');
    expect(r.links[1].text).toBe('tip');
  });
});

describe('extractLinks — filters', () => {
  it('same_origin keeps only same protocol+host+port (port-sensitive)', () => {
    document.body.innerHTML = `
      <a href="/local">L</a>
      <a href="https://external.com/x">X</a>
      <a href="http://localhost/other">O</a>`;
    const r = extractLinks(null, true, null, 200);
    // "/local" → same origin (kept). external.com → dropped. http://localhost/other
    // is port 80 ≠ the test origin's port → different origin → dropped.
    expect(r.links.map((l) => l.url)).toEqual([`${ORIGIN}/local`]);
  });

  it('pattern keeps only urls matching the regex', () => {
    document.body.innerHTML = `
      <a href="https://s.com/blog/1">a</a>
      <a href="https://s.com/blog/2">b</a>
      <a href="https://s.com/about">c</a>`;
    const r = extractLinks(null, false, '/blog/', 200);
    expect(r.links.map((l) => l.url)).toEqual(['https://s.com/blog/1', 'https://s.com/blog/2']);
  });

  it('bad regex → error result', () => {
    document.body.innerHTML = '<a href="https://x.com">x</a>';
    const r = extractLinks(null, false, '(', 200);
    expect(r.error).toContain('bad pattern');
    expect(r.links).toHaveLength(0);
  });

  it('selector scopes to a container; matching nothing → empty', () => {
    document.body.innerHTML = `
      <nav><a href="https://n.com/1">nav</a></nav>
      <main><a href="https://m.com/1">main</a></main>`;
    expect(extractLinks('main', false, null, 200).links).toEqual([
      { url: 'https://m.com/1', text: 'main' },
    ]);
    expect(extractLinks('#nope', false, null, 200).links).toHaveLength(0);
  });
});

describe('extractLinks — limit + shadow DOM', () => {
  it('limit caps links but total reflects all matches (truncated)', () => {
    document.body.innerHTML = Array.from(
      { length: 5 },
      (_, i) => `<a href="https://c.com/${i}">L${i}</a>`,
    ).join('');
    const r = extractLinks(null, false, null, 3);
    expect(r.links).toHaveLength(3);
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it('pierces open shadow roots (web-component links)', () => {
    document.body.innerHTML = '<a href="https://light.com/1">light</a><div id="host"></div>';
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<a href="https://shadow.com/1">shadow</a>';
    const r = extractLinks(null, false, null, 200);
    expect(r.links.map((l) => l.url).sort()).toEqual(['https://light.com/1', 'https://shadow.com/1']);
  });
});
