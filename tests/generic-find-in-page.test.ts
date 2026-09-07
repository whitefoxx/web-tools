/**
 * find_in_page pure matcher (src/tools/generic/find-in-page.ts findTextMatches):
 * the Ctrl+F-for-the-agent core — substring/regex matching on visible text with
 * count + context snippets. The in-page function inlines an identical copy; this
 * tests the shared spec. Pure; node.
 */
import { describe, it, expect } from 'vitest';
import { findTextMatches, HARD_MATCH_CAP } from '../src/tools/generic/find-in-page';

const TEXT = 'The quick brown Fox jumps over the lazy dog. The fox is quick.';

describe('findTextMatches — plain substring', () => {
  it('is case-insensitive by default and counts every hit', () => {
    const r = findTextMatches(TEXT, 'fox', {});
    expect(r.count).toBe(2); // "Fox" + "fox"
    expect(r.regex).toBe(false);
    expect(r.matches[0].context).toContain('【Fox】'); // hit preserves original case
  });

  it('case_sensitive narrows to exact case', () => {
    expect(findTextMatches(TEXT, 'fox', { caseSensitive: true }).count).toBe(1);
    expect(findTextMatches(TEXT, 'Fox', { caseSensitive: true }).count).toBe(1);
  });

  it('wraps the hit in 【】 with trimmed surrounding context', () => {
    const r = findTextMatches(TEXT, 'jumps', { contextChars: 10 });
    expect(r.matches[0].context).toMatch(/Fox 【jumps】 over/);
    // context is bounded → ellipses on both sides
    expect(r.matches[0].context.startsWith('…')).toBe(true);
    expect(r.matches[0].context.endsWith('…')).toBe(true);
  });

  it('no match → count 0, empty matches', () => {
    const r = findTextMatches(TEXT, 'cat', {});
    expect(r.count).toBe(0);
    expect(r.matches).toEqual([]);
  });

  it('empty query → error', () => {
    expect(findTextMatches(TEXT, '', {}).error).toBe('query must not be empty');
  });
});

describe('findTextMatches — limit / truncation', () => {
  it('count is total; matches capped at limit; truncated flagged', () => {
    const many = 'ab '.repeat(10); // 10 "ab"
    const r = findTextMatches(many, 'ab', { limit: 3 });
    expect(r.count).toBe(10);
    expect(r.matches).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it('limit is clamped to [1,30]', () => {
    const many = 'x '.repeat(50);
    expect(findTextMatches(many, 'x', { limit: 999 }).matches.length).toBe(30);
    expect(findTextMatches(many, 'x', { limit: 0 }).matches.length).toBe(1);
  });
});

describe('findTextMatches — regex', () => {
  it('treats the query as a RegExp when regex=true', () => {
    const r = findTextMatches('a1 b2 c3 d', 'regex ignored', { regex: false, limit: 1 });
    expect(r.regex).toBe(false);
    const re = findTextMatches('a1 b2 c3 d', '[a-z][0-9]', { regex: true });
    expect(re.count).toBe(3);
    expect(re.regex).toBe(true);
  });

  it('regex is case-insensitive by default, respects case_sensitive', () => {
    expect(findTextMatches('Foo foo FOO', 'foo', { regex: true }).count).toBe(3);
    expect(findTextMatches('Foo foo FOO', 'foo', { regex: true, caseSensitive: true }).count).toBe(
      1,
    );
  });

  it('an invalid regex returns a clear error, not a throw', () => {
    const r = findTextMatches('abc', '(unclosed', { regex: true });
    expect(r.error).toMatch(/Invalid regex/);
    expect(r.count).toBe(0);
  });

  it('a zero-width regex (a*) cannot infinite-loop and stays bounded', () => {
    const r = findTextMatches('aaa bbb', 'a*', { regex: true });
    expect(r.count).toBeGreaterThan(0);
    expect(r.count).toBeLessThanOrEqual(HARD_MATCH_CAP);
  });
});

describe('findTextMatches — bounds', () => {
  it('a match flood is capped at HARD_MATCH_CAP and flagged truncated', () => {
    const huge = 'a'.repeat(HARD_MATCH_CAP + 500);
    const r = findTextMatches(huge, 'a', {});
    expect(r.count).toBe(HARD_MATCH_CAP);
    expect(r.truncated).toBe(true);
  });

  it('context_chars is clamped to [0,400]', () => {
    const long = `${'x'.repeat(600)}HIT${'y'.repeat(600)}`;
    const r = findTextMatches(long, 'HIT', { contextChars: 9999 });
    // 400 before + 3 hit + 400 after ≈ 803, plus the two … markers
    expect(r.matches[0].context.length).toBeLessThan(820);
    expect(r.matches[0].context).toContain('【HIT】');
  });
});
