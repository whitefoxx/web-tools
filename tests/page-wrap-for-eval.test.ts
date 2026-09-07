/**
 * wrapForEval — IIFE wrapping + the conditional __loc preamble injection (B1).
 * Pure, node. Critical invariant: code that does NOT reference __loc is returned
 * byte-for-byte unchanged (the 284 marketplace adapters must be untouched).
 */

import { describe, it, expect } from 'vitest';
import { wrapForEval } from '../src/runtime/page';

describe('wrapForEval', () => {
  it('wraps an arrow function as an IIFE', () => {
    expect(wrapForEval('async () => 1')).toBe('(async () => 1)()');
  });

  it('leaves an existing IIFE as-is', () => {
    expect(wrapForEval('(() => 1)()')).toBe('(() => 1)()');
  });

  it('leaves a bare expression as-is', () => {
    expect(wrapForEval('document.title')).toBe('document.title');
  });

  it('does NOT inject the __loc preamble when code never references it', () => {
    for (const c of ['document.title', 'async () => fetch("/x")', '(() => 1)()']) {
      expect(wrapForEval(c)).not.toContain('window.__loc');
    }
  });

  it('injects the __loc preamble ONLY when code references __loc, keeping the expr last', () => {
    const expr = '(() => __loc.byRole("heading"))()';
    const out = wrapForEval(expr);
    expect(out).toContain('window.__loc'); // preamble installed
    expect(out.trimEnd().endsWith(expr)).toBe(true); // adapter expression is the completion value
  });

  it('wraps a statement body that uses a top-level return (Illegal-return fix)', () => {
    expect(wrapForEval('const x = 1; return x;')).toBe(
      '(async () => {\nconst x = 1; return x;\n})()',
    );
  });

  it('wraps a comment-led statement body with return', () => {
    const out = wrapForEval('// find it\nreturn document.title;');
    expect(out.startsWith('(async () => {')).toBe(true);
    expect(out).toContain('return document.title;');
  });
});
