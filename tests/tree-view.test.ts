/**
 * ⑨ tree-format perception (page-agent-comparison §4.2) — SW-side pure helpers.
 * The in-page serializer itself needs real layout (verify via bridge, per repo
 * convention); these cover the frame-merging and new-marker post-processing.
 */
import { describe, it, expect } from 'vitest';
import {
  namespaceTreeRefs,
  starNewRefsInTree,
  mergeFrameResults,
} from '../src/tools/generic/get-interactives';

describe('namespaceTreeRefs (⑨ iframe tree refs)', () => {
  it('prefixes line-start refs, including starred and indented lines', () => {
    const tree = '[r1]<button>OK />\n\t*[r2]<a>Docs />\nplain text';
    expect(namespaceTreeRefs(tree, 5)).toBe('[f5r1]<button>OK />\n\t*[f5r2]<a>Docs />\nplain text');
  });

  it('never rewrites a literal "[r3]" occurring mid-text', () => {
    const tree = 'see item [r3] in the manual\n[r3]<button>Go />';
    expect(namespaceTreeRefs(tree, 2)).toBe('see item [r3] in the manual\n[f2r3]<button>Go />');
  });

  it('frameId 0 (top frame) is a no-op', () => {
    const tree = '[r1]<button>OK />';
    expect(namespaceTreeRefs(tree, 0)).toBe(tree);
  });
});

describe('starNewRefsInTree (⑨ text twin of new:true)', () => {
  it('stars matching refs — bare and frame-prefixed — and leaves others', () => {
    const tree = '[r1]<button>OK />\n\t[f5r2]<a>Docs />\n\t[r3]<input type=text />';
    const out = starNewRefsInTree(tree, new Set(['f5r2', 'r3']));
    expect(out).toBe('[r1]<button>OK />\n\t*[f5r2]<a>Docs />\n\t*[r3]<input type=text />');
  });

  it('empty set is a no-op; plain text lines untouched', () => {
    const tree = 'section title\n[r1]<button>OK />';
    expect(starNewRefsInTree(tree, new Set())).toBe(tree);
    expect(starNewRefsInTree(tree, new Set(['r9']))).toBe(tree);
  });
});

describe('mergeFrameResults tree merging (⑨)', () => {
  const frame = (fid: number, tree?: string) => ({
    frameId: fid,
    result: {
      buttons: [{ ref: 'r1', text: `b${fid}`, tag: 'button' }],
      frameUrl: `https://f${fid}.example/`,
      ...(tree !== undefined ? { tree } : {}),
    },
  });

  it('appends sub-frame trees under a header with namespaced refs', () => {
    const merged = mergeFrameResults([
      frame(0, '[r1]<button>top />'),
      frame(4, '[r1]<button>inner />'),
    ]) as Record<string, unknown>;
    expect(merged.tree).toBe(
      '[r1]<button>top />\n--- iframe f4: https://f4.example/ ---\n[f4r1]<button>inner />',
    );
  });

  it('no tree fields → no tree key (flat mode unchanged)', () => {
    const merged = mergeFrameResults([frame(0), frame(4)]) as Record<string, unknown>;
    expect('tree' in merged).toBe(false);
  });

  it('sub-frame tree survives even when the top frame returned none', () => {
    const merged = mergeFrameResults([frame(0), frame(7, '[r1]<a>x />')]) as Record<
      string,
      unknown
    >;
    expect(merged.tree).toBe('--- iframe f7: https://f7.example/ ---\n[f7r1]<a>x />');
  });
});
