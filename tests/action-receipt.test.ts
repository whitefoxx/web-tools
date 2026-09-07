/**
 * ⑩ action receipt (page-agent-comparison §4.2) — the pure diff. The probes
 * themselves need a real page (bridge verification, per repo convention).
 */
import { describe, it, expect } from 'vitest';
import { diffSig } from '../src/tools/generic/_receipt';

describe('diffSig (⑩ action receipt)', () => {
  it('navigation wins: reports url_changed + hint, skips popup/DOM fields', () => {
    const r = diffSig(
      { pop: 0, el: 100 },
      { pop: 2, el: 300 },
      { from: 'https://a/', to: 'https://b/' },
    );
    expect(r.url_changed).toEqual({ from: 'https://a/', to: 'https://b/' });
    expect(String(r.hint)).toContain('stale');
    expect('popup_appeared' in r).toBe(false);
  });

  it('popup count increase → popup_appeared + actionable hint', () => {
    const r = diffSig({ pop: 0, el: 100 }, { pop: 1, el: 104 }, null);
    expect(r.popup_appeared).toBe(true);
    expect(String(r.hint)).toContain('get_interactives');
  });

  it('DOM growth above the noise floor → new_elements; small jitter ignored', () => {
    expect(diffSig({ pop: 0, el: 100 }, { pop: 0, el: 130 }, null).new_elements).toBe(30);
    expect('new_elements' in diffSig({ pop: 0, el: 100 }, { pop: 0, el: 102 }, null)).toBe(false);
  });

  it('⑩b new_interactives passthrough: list + act-directly hint beats the rescan hint', () => {
    const items = [{ ref: 'nab0', text: '上海 SHA' }];
    const r = diffSig({ pop: 0, el: 100 }, { pop: 1, el: 120, new_interactives: items }, null);
    expect(r.new_interactives).toEqual(items);
    expect(r.popup_appeared).toBe(true);
    expect(String(r.hint)).toContain('fleeting');
    // empty list → falls back to the plain popup hint, no key emitted
    const r2 = diffSig({ pop: 0, el: 100 }, { pop: 1, el: 120, new_interactives: [] }, null);
    expect('new_interactives' in r2).toBe(false);
    expect(String(r2.hint)).toContain('get_interactives');
  });

  it('popup closing (pop decrease) or missing probes → empty receipt', () => {
    expect(diffSig({ pop: 2, el: 100 }, { pop: 0, el: 90 }, null)).toEqual({});
    expect(diffSig(null, { pop: 1, el: 100 }, null)).toEqual({});
    expect(diffSig({ pop: 0, el: 100 }, null, null)).toEqual({});
  });
});
