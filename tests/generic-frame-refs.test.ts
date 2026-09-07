/**
 * Frame-scoped element refs + allFrames scan merge (iframe blind-spot fix,
 * browseract-comparison "iframe ref 语义"). The CDP/allFrames injection needs a
 * real browser, but the ref namespacing (frameRef / parseFrameRef) and the
 * per-frame merge (mergeFrameResults) are pure and unit-tested here. Node.
 */

import { describe, it, expect } from 'vitest';
import { frameRef, parseFrameRef } from '../src/tools/generic/_helpers';
import { mergeFrameResults } from '../src/tools/generic/get-interactives';

describe('frameRef / parseFrameRef', () => {
  it('top frame (0) is un-prefixed; sub-frames get f<id>', () => {
    expect(frameRef(0, 'r3')).toBe('r3');
    expect(frameRef(5, 'r3')).toBe('f5r3');
    expect(frameRef(12, 'ra')).toBe('f12ra');
  });

  it('parses a frame-scoped ref back into frameId + localRef', () => {
    expect(parseFrameRef('f5r3')).toEqual({ frameId: 5, localRef: 'r3' });
    expect(parseFrameRef('f12ra')).toEqual({ frameId: 12, localRef: 'ra' });
  });

  it('a plain ref → top frame (frameId 0)', () => {
    expect(parseFrameRef('r3')).toEqual({ frameId: 0, localRef: 'r3' });
    expect(parseFrameRef('rz')).toEqual({ frameId: 0, localRef: 'rz' });
  });

  it('does not false-match non-frame strings (selectors / arbitrary)', () => {
    // `f5button` — the local part must look like a real ref (`r<base36>`).
    expect(parseFrameRef('f5button')).toEqual({ frameId: 0, localRef: 'f5button' });
    expect(parseFrameRef('button[data-x]')).toEqual({ frameId: 0, localRef: 'button[data-x]' });
  });

  it('round-trips', () => {
    expect(parseFrameRef(frameRef(7, 'rz'))).toEqual({ frameId: 7, localRef: 'rz' });
    expect(parseFrameRef(frameRef(0, 'r1'))).toEqual({ frameId: 0, localRef: 'r1' });
  });
});

describe('mergeFrameResults', () => {
  const topOnly = [
    {
      frameId: 0,
      result: {
        frameUrl: 'http://x/',
        scroll: { percent_scrolled: 0 },
        highlighted: false,
        buttons: [{ ref: 'r1', text: 'Top' }],
        links: [],
      },
    },
  ];

  it('top-only: refs unchanged, no frames summary', () => {
    const m = mergeFrameResults(topOnly);
    expect((m.buttons as Array<Record<string, unknown>>)[0].ref).toBe('r1');
    expect((m.buttons as unknown[])[0]).not.toHaveProperty('frame');
    expect(m).not.toHaveProperty('frames');
    expect((m.counts as Record<string, number>).buttons).toBe(1);
    expect(m.scroll).toEqual({ percent_scrolled: 0 });
  });

  it('merges an iframe: prefixes its refs, tags frame, lists it in frames', () => {
    const m = mergeFrameResults([
      ...topOnly,
      {
        frameId: 5,
        result: {
          frameUrl: 'http://x/child',
          buttons: [{ ref: 'r1', text: 'Child' }],
          inputs: [{ ref: 'r2', label: 'q' }],
        },
      },
    ]);
    const btns = m.buttons as Array<Record<string, unknown>>;
    expect(btns).toHaveLength(2);
    expect(btns[0]).toEqual({ ref: 'r1', text: 'Top' }); // top untouched
    expect(btns[1].ref).toBe('f5r1');
    expect(btns[1].frame).toBe(5);
    expect((m.inputs as Array<Record<string, unknown>>)[0].ref).toBe('f5r2');
    expect(m.frames).toEqual([{ frameId: 5, url: 'http://x/child' }]);
    expect((m.counts as Record<string, number>).buttons).toBe(2);
  });

  it('skips frames with no / non-object result', () => {
    const m = mergeFrameResults([...topOnly, { frameId: 9, result: undefined }, { frameId: 10 }]);
    expect((m.counts as Record<string, number>).buttons).toBe(1);
    expect(m).not.toHaveProperty('frames');
  });
});
