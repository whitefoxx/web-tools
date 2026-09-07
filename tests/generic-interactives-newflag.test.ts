/**
 * applyNewFlags — D2-lite change-observation for get_interactives (browseract ⑰).
 * Marks elements that appeared since the last scan on the same page. Pure
 * (aside from the intended `new` mutation); node.
 */

import { describe, it, expect } from 'vitest';
import { applyNewFlags } from '../src/tools/generic/get-interactives';

type Rec = Record<string, unknown>;

const scan = (): Rec => ({
  buttons: [{ ref: 'r1', text: 'Submit', tag: 'button' }],
  links: [{ ref: 'r2', text: 'Home', href: '/' }],
  clickables: [{ ref: 'r3', text: 'Menu', why: 'role' }],
});

describe('applyNewFlags (⑰ D2-lite)', () => {
  it('baseline (prevSigs=null) marks nothing new but records all signatures', () => {
    const r = scan();
    const { newCount, sigs } = applyNewFlags(r, null);
    expect(newCount).toBe(0);
    expect((r.buttons as Rec[])[0]).not.toHaveProperty('new');
    expect(sigs.size).toBe(3);
  });

  it('marks only records whose signature is new vs the previous scan', () => {
    const { sigs } = applyNewFlags(scan(), null);
    const r2: Rec = {
      buttons: [{ ref: 'x1', text: 'Submit', tag: 'button' }], // same content, different ref
      links: [{ ref: 'x2', text: 'Home', href: '/' }],
      clickables: [
        { ref: 'x3', text: 'Menu', why: 'role' },
        { ref: 'x4', text: 'Delete', why: 'role' }, // NEW — surfaced by an action
      ],
    };
    const { newCount } = applyNewFlags(r2, sigs);
    expect(newCount).toBe(1);
    expect((r2.clickables as Rec[])[1].new).toBe(true);
    expect((r2.clickables as Rec[])[0].new).toBeUndefined();
    expect((r2.buttons as Rec[])[0].new).toBeUndefined(); // unchanged despite new ref
  });

  it('ref churn alone does not count as new (ref excluded from signature)', () => {
    const first = applyNewFlags({ buttons: [{ ref: 'a', text: 'X' }] }, null);
    const { newCount } = applyNewFlags({ buttons: [{ ref: 'zzz-diff', text: 'X' }] }, first.sigs);
    expect(newCount).toBe(0);
  });

  it('handles missing / empty categories', () => {
    const { newCount, sigs } = applyNewFlags({}, null);
    expect(newCount).toBe(0);
    expect(sigs.size).toBe(0);
  });

  it('a disappeared element is simply absent (no crash); reappearance is not new if still baseline-matched', () => {
    const { sigs } = applyNewFlags(scan(), null);
    const fewer: Rec = { buttons: [{ ref: 'y1', text: 'Submit', tag: 'button' }] };
    const { newCount } = applyNewFlags(fewer, sigs);
    expect(newCount).toBe(0);
  });
});
