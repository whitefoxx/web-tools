// @vitest-environment jsdom
/**
 * The answer renderer (docs/localmd-connect.md §14.4p). Just enough Markdown to
 * read an answer in a popover — and, more importantly, a renderer that builds
 * NODES: this text comes from a model and lands in a shadow root inside
 * somebody's page, so an `<img onerror=…>` in an answer would run there.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderMarkdown } from '../src/localmd-connect/mini-markdown';

let el: HTMLElement;
const render = (md: string): string => {
  renderMarkdown(el, md);
  return el.innerHTML;
};
beforeEach(() => {
  el = document.createElement('div');
});

describe('renderMarkdown', () => {
  it('never lets markup through, whatever the model wrote', () => {
    const html = render('<img src=x onerror=alert(1)> and <b>bold</b>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(html).toContain('&lt;img');
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('makes paragraphs, joining the lines inside one', () => {
    renderMarkdown(el, 'one\ntwo\n\nthree');
    const ps = [...el.querySelectorAll('p')];
    expect(ps).toHaveLength(2);
    // A hard wrap in a model's output is not a line break.
    expect(ps[0].textContent).toBe('one two');
    expect(ps[1].textContent).toBe('three');
  });

  it('makes lists, and knows the two kinds apart', () => {
    renderMarkdown(el, '- a\n- b\n\n1. x\n2. y');
    expect([...el.querySelectorAll('ul li')].map((n) => n.textContent)).toEqual(['a', 'b']);
    expect([...el.querySelectorAll('ol li')].map((n) => n.textContent)).toEqual(['x', 'y']);
  });

  it('renders the inline marks a model actually uses', () => {
    renderMarkdown(el, 'a **bold** and *thin* and `code`');
    expect(el.querySelector('strong')!.textContent).toBe('bold');
    expect(el.querySelector('em')!.textContent).toBe('thin');
    expect(el.querySelector('code')!.textContent).toBe('code');
    expect(el.textContent).toBe('a bold and thin and code');
  });

  it('leaves punctuation that is not markup alone', () => {
    // Both of these turn up in an explanation about code, which is exactly
    // where a renderer that guessed would be most annoying.
    renderMarkdown(el, '2 * 3 = 6, and a_variable_name');
    expect(el.querySelector('em')).toBeNull();
    expect(el.textContent).toBe('2 * 3 = 6, and a_variable_name');
    renderMarkdown(el, 'a * b * c');
    expect(el.querySelector('em')).toBeNull();
    renderMarkdown(el, 'snake_case_here and MAX_SIZE');
    expect(el.querySelector('em')).toBeNull();
  });

  it('keeps a fenced block verbatim', () => {
    renderMarkdown(el, 'see:\n```\nline **one**\n  line two\n```\ndone');
    expect(el.querySelector('pre code')!.textContent).toBe('line **one**\n  line two');
    expect(el.querySelector('pre strong')).toBeNull();
  });

  it('links only where a link can go', () => {
    renderMarkdown(el, '[docs](https://a.test/x) and [bad](javascript:alert(1))');
    const a = [...el.querySelectorAll('a')];
    expect(a).toHaveLength(1);
    expect(a[0].getAttribute('href')).toBe('https://a.test/x');
    expect(a[0].getAttribute('rel')).toBe('noreferrer noopener');
    // The unsafe one keeps its words and loses its link.
    expect(el.textContent).toContain('bad');
    expect(el.innerHTML).not.toContain('javascript:');
  });

  it('does headings and quotes, and replaces what was there before', () => {
    renderMarkdown(el, '## Title\n> quoted');
    expect(el.querySelector('.md-h')!.textContent).toBe('Title');
    expect(el.querySelector('blockquote')!.textContent).toBe('quoted');
    renderMarkdown(el, 'plain');
    expect(el.querySelector('.md-h')).toBeNull();
    expect(el.textContent).toBe('plain');
  });
});
