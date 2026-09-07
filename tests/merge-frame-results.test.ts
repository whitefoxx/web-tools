/**
 * mergeFrameResults — merges the top frame + every iframe's interactives into one
 * flat result. max_per_category is enforced PER FRAME, so the merge must re-cap
 * globally or a page with many iframes yields cap×N items → prompt blowup (Tier4).
 */
import { describe, it, expect } from 'vitest';
import { mergeFrameResults } from '../src/tools/generic/get-interactives';

const frame = (fid: number, nButtons: number) => ({
  frameId: fid,
  result: {
    buttons: Array.from({ length: nButtons }, (_, n) => ({
      ref: `r${n}`,
      text: `b${fid}-${n}`,
      tag: 'button',
    })),
  },
});

describe('mergeFrameResults global cap (Tier4-#a)', () => {
  it('re-slices each category to cap after merging frames', () => {
    // two frames × 4 buttons = 8 merged; cap 5 → 5, and counts reflect it.
    const merged = mergeFrameResults([frame(0, 4), frame(2, 4)], 5) as Record<string, unknown>;
    expect((merged.buttons as unknown[]).length).toBe(5);
    expect((merged.counts as Record<string, number>).buttons).toBe(5);
  });

  it('no cap → keeps all (backward compatible)', () => {
    const merged = mergeFrameResults([frame(0, 1), frame(2, 1)]) as Record<string, unknown>;
    expect((merged.buttons as unknown[]).length).toBe(2);
  });

  it('namespaces iframe refs but not top-frame refs', () => {
    const merged = mergeFrameResults([frame(0, 1), frame(3, 1)]) as Record<string, unknown>;
    const btns = merged.buttons as Array<{ ref: string }>;
    expect(btns[0].ref).toBe('r0'); // top frame — bare
    expect(btns[1].ref).toMatch(/^f3/); // iframe — namespaced
  });
});
