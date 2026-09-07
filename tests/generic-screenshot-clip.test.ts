// @vitest-environment jsdom
/**
 * Element-scoped screenshots (`screenshot { ref | selector }`): the pure target
 * resolution, and the in-page measurer that turns an element into the clip
 * rect a CDP capture wants. The capture itself is a real-browser test
 * (docs/tests/platform.md).
 */
import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('chrome', {
  tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
  windows: { onRemoved: { addListener: () => {} } },
  runtime: { getManifest: () => ({ name: 't' }) },
});

const { resolveClipTarget, measureElementInPage } = await import('../src/tools/generic/screenshot');

describe('resolveClipTarget', () => {
  it('turns a get_interactives ref into its data-web-ref selector', () => {
    expect(resolveClipTarget({ ref: 'r7' })).toEqual({
      selector: '[data-web-ref="r7"]',
      label: 'r7',
    });
  });

  it('passes a CSS selector through', () => {
    expect(resolveClipTarget({ selector: '#chart' })).toEqual({
      selector: '#chart',
      label: '#chart',
    });
  });

  it('is null when neither is given — the ordinary viewport shot', () => {
    expect(resolveClipTarget({})).toBeNull();
    expect(resolveClipTarget({ ref: '  ', selector: '' })).toBeNull();
  });

  it('refuses both at once', () => {
    expect(() => resolveClipTarget({ ref: 'r1', selector: 'p' })).toThrow(/only one/);
  });

  it('refuses an iframe-scoped ref instead of clipping the wrong place', () => {
    // A sub-frame's rect is in that frame's coordinates; clipping the top
    // document by it would capture something else and call it the element.
    expect(() => resolveClipTarget({ ref: 'f5r3' })).toThrow(/inside an iframe/);
  });
});

describe('measureElementInPage', () => {
  it('reports the box in page coordinates, scroll included', () => {
    document.body.innerHTML = '<div id="t">x</div>';
    const el = document.getElementById('t')!;
    el.getBoundingClientRect = () =>
      ({ left: 10.4, top: 20.6, width: 100.2, height: 50.5 }) as DOMRect;
    Object.defineProperty(window, 'scrollX', { value: 5, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 300, configurable: true });
    expect(measureElementInPage('#t')).toEqual({ x: 15, y: 321, width: 100, height: 51 });
  });

  it('is null for nothing, and for an element with no box', () => {
    document.body.innerHTML = '<div id="hidden"></div>';
    expect(measureElementInPage('#nope')).toBeNull();
    // jsdom gives every element a 0×0 box — exactly what display:none looks like.
    expect(measureElementInPage('#hidden')).toBeNull();
  });
});
