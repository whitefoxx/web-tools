// @vitest-environment jsdom
/**
 * Text-quote anchoring (划词助手 高亮持久化) — build index / find (context
 * disambiguation, whitespace-collapse fallback) / wrap across nodes / unwrap /
 * describeRange roundtrip. Pure DOM under jsdom.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTextIndex,
  findQuote,
  segmentsFromSpan,
  wrapSegments,
  unwrapById,
  describeRange,
  collapseWs,
  HL_ATTR,
} from '../src/selection/anchor';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('buildTextIndex', () => {
  it('concatenates text nodes and skips script/style', () => {
    setBody('<p>Hello <b>world</b></p><script>junk()</script><style>.x{}</style>');
    const idx = buildTextIndex(document.body);
    expect(idx.text).toContain('Hello world');
    expect(idx.text).not.toContain('junk');
    expect(idx.nodes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('findQuote', () => {
  it('unique occurrence found directly', () => {
    setBody('<p>alpha beta gamma</p>');
    const idx = buildTextIndex(document.body);
    const span = findQuote(idx, 'beta', '', '')!;
    expect(idx.text.slice(span.start, span.end)).toBe('beta');
  });

  it('disambiguates duplicates by prefix/suffix context', () => {
    setBody('<p>the cat sat</p><p>the cat ran</p>');
    const idx = buildTextIndex(document.body);
    const span = findQuote(idx, 'the cat', '', ' ran')!;
    // Must pick the SECOND occurrence (suffix " ran").
    expect(idx.text.slice(span.end, span.end + 4)).toBe(' ran');
  });

  it('whitespace-collapse fallback survives re-rendered spacing', () => {
    setBody('<p>quick\n   brown\tfox</p>');
    const idx = buildTextIndex(document.body);
    // Stored from a render with single spaces:
    const span = findQuote(idx, 'quick brown fox', '', '')!;
    expect(span).toBeTruthy();
    expect(idx.text.slice(span.start, span.end).replace(/\s+/g, ' ')).toBe('quick brown fox');
  });

  it('misses return null', () => {
    setBody('<p>nothing here</p>');
    const idx = buildTextIndex(document.body);
    expect(findQuote(idx, 'absent quote', '', '')).toBeNull();
  });
});

describe('wrap / unwrap', () => {
  it('wraps a span crossing element boundaries and unwraps losslessly', () => {
    setBody('<p>one <b>two</b> three</p>');
    const before = document.body.textContent;
    const idx = buildTextIndex(document.body);
    const span = findQuote(idx, 'ne two th', '', '')!;
    const marks = wrapSegments(segmentsFromSpan(idx, span.start, span.end), 'h1');
    expect(marks.length).toBeGreaterThanOrEqual(3); // split across 3 text nodes
    const marked = [...document.querySelectorAll(`mark[${HL_ATTR}="h1"]`)]
      .map((m) => m.textContent)
      .join('');
    expect(marked).toBe('ne two th');
    expect(document.body.textContent).toBe(before); // no text lost/duplicated
    expect(unwrapById(document.body, 'h1')).toBe(marks.length);
    expect(document.querySelectorAll(`mark[${HL_ATTR}]`).length).toBe(0);
    expect(document.body.textContent).toBe(before);
  });

  it('restore is idempotent — segments inside an existing mark are skipped', () => {
    setBody('<p>alpha beta gamma</p>');
    let idx = buildTextIndex(document.body);
    const span = findQuote(idx, 'beta', '', '')!;
    wrapSegments(segmentsFromSpan(idx, span.start, span.end), 'h2');
    // Re-anchor the same quote against the NEW dom (as a second restore would).
    idx = buildTextIndex(document.body);
    const again = findQuote(idx, 'beta', '', '')!;
    const marks2 = wrapSegments(segmentsFromSpan(idx, again.start, again.end), 'h2');
    expect(marks2.length).toBe(0);
    expect(document.querySelectorAll(`mark[${HL_ATTR}="h2"]`).length).toBe(1);
  });
});

describe('describeRange roundtrip', () => {
  it('selection → descriptor → fresh page → find + wrap the same text', () => {
    setBody('<p>the cat sat</p><p>the cat ran fast today</p>');
    // Select "cat ran" in the SECOND paragraph.
    const p2 = document.querySelectorAll('p')[1].firstChild as Text;
    const range = document.createRange();
    range.setStart(p2, 4);
    range.setEnd(p2, 11);
    expect(range.toString()).toBe('cat ran');
    const idx = buildTextIndex(document.body);
    const desc = describeRange(idx, range)!;
    expect(desc.exact).toBe('cat ran');
    expect(desc.suffix.startsWith(' fast')).toBe(true);
    // "Reload": rebuild DOM identically, re-anchor from the descriptor alone.
    setBody('<p>the cat sat</p><p>the cat ran fast today</p>');
    const idx2 = buildTextIndex(document.body);
    const span = findQuote(idx2, desc.exact, desc.prefix, desc.suffix)!;
    wrapSegments(segmentsFromSpan(idx2, span.start, span.end), 'h3');
    const marked = [...document.querySelectorAll(`mark[${HL_ATTR}="h3"]`)]
      .map((m) => m.textContent)
      .join('');
    expect(marked).toBe('cat ran');
    // And it's the second paragraph's occurrence.
    expect(document.querySelectorAll('p')[1].querySelector('mark')).toBeTruthy();
  });
});

describe('collapseWs', () => {
  it('maps collapsed indices back to raw ones', () => {
    const { text, map } = collapseWs('a  b\n\tc');
    expect(text).toBe('a b c');
    expect(map.length).toBe(text.length);
    expect('a  b\n\tc'[map[2]]).toBe('b');
    expect('a  b\n\tc'[map[4]]).toBe('c');
  });
});
