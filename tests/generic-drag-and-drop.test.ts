// @vitest-environment jsdom
/**
 * drag_and_drop — locatorToSelector maps a get_interactives ref or a raw CSS
 * selector to a query selector (pure). dragInPage's full synthetic pointer+DnD
 * chain is real-browser territory (jsdom has no DragEvent), but jsdom DOES let us
 * assert the not-found error paths and that events fire on found elements.
 */

import { describe, it, expect } from 'vitest';
import { locatorToSelector, dragInPage } from '../src/tools/generic/drag-and-drop';

describe('locatorToSelector', () => {
  it('a ref becomes a data-web-ref attribute selector', () => {
    expect(locatorToSelector('r5', null)).toBe('[data-web-ref="r5"]');
  });
  it('a frame-scoped ref uses the local ref', () => {
    expect(locatorToSelector('f3r5', null)).toBe('[data-web-ref="r5"]');
  });
  it('falls back to the raw selector when no ref', () => {
    expect(locatorToSelector(null, '.card')).toBe('.card');
    expect(locatorToSelector(null, null)).toBeNull();
  });
});

describe('dragInPage', () => {
  it('errors when the source is missing', () => {
    document.body.innerHTML = '<div id="to"></div>';
    expect(dragInPage('#from', '#to').error).toContain('from');
  });
  it('errors when the target is missing', () => {
    document.body.innerHTML = '<div id="from"></div>';
    expect(dragInPage('#from', '#to').error).toContain('to');
  });
  it('dispatches drop on the target when both exist', () => {
    document.body.innerHTML = '<div id="from"></div><div id="to"></div>';
    let dropped = false;
    let dragstarted = false;
    document.getElementById('from')!.addEventListener('dragstart', () => {
      dragstarted = true;
    });
    document.getElementById('to')!.addEventListener('drop', () => {
      dropped = true;
    });
    const r = dragInPage('#from', '#to');
    expect(r.ok).toBe(true);
    expect(dragstarted).toBe(true);
    expect(dropped).toBe(true);
    expect(r.from).toBeDefined();
    expect(r.to).toBeDefined();
  });
});
