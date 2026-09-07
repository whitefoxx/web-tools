import { cli } from '../../runtime/registry.js';
import { assertTabId, parseFrameRef } from './_helpers';

/**
 * drag_and_drop — drag one element onto another (reorder lists, kanban cards,
 * sliders, file drop zones, canvas). No CDP: synthesizes BOTH a pointer/mouse
 * press-move-release sequence AND the HTML5 DnD event chain (dragstart →
 * dragenter → dragover → drop → dragend) sharing one DataTransfer, so it covers
 * both mouse-move-based widgets (sortable/sliders) and HTML5 drop zones.
 *
 * Honest caveat: synthetic drag is inherently best-effort — libraries that
 * demand trusted events or drag with a specific step cadence may not respond.
 * Prefer it for HTML5 DnD and simple pointer-drag UIs; fall back to click/keyboard
 * if a widget ignores it.
 *
 * `dragInPage` is self-contained (serialized alone) + exported.
 */

/** Resolve a locator (data-web-ref value or CSS selector) to a selector string.
 * A `get_interactives` ref becomes `[data-web-ref="…"]`; anything else is used
 * verbatim as a selector. Pure; exported for tests. */
export function locatorToSelector(ref: string | null, selector: string | null): string | null {
  if (ref) return `[data-web-ref="${parseFrameRef(ref).localRef}"]`;
  return selector;
}

/** In-page. Dispatch a full pointer + HTML5 drag sequence from → to. */
export function dragInPage(
  fromSelector: string,
  toSelector: string,
): { ok?: boolean; error?: string; from?: { x: number; y: number }; to?: { x: number; y: number } } {
  const from = document.querySelector(fromSelector) as HTMLElement | null;
  const to = document.querySelector(toSelector) as HTMLElement | null;
  if (!from) return { error: `from not found: ${fromSelector}` };
  if (!to) return { error: `to not found: ${toSelector}` };
  if (typeof from.scrollIntoView === 'function') from.scrollIntoView({ block: 'center' });
  const rf = from.getBoundingClientRect();
  const rt = to.getBoundingClientRect();
  const fx = rf.left + rf.width / 2;
  const fy = rf.top + rf.height / 2;
  const tx = rt.left + rt.width / 2;
  const ty = rt.top + rt.height / 2;

  const dt = typeof DataTransfer === 'function' ? new DataTransfer() : null;
  const mouse = (el: Element, type: string, x: number, y: number): void => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  };
  const pointer = (el: Element, type: string, x: number, y: number): void => {
    if (typeof PointerEvent !== 'function') return;
    el.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'mouse' }),
    );
  };
  const drag = (el: Element, type: string, x: number, y: number): void => {
    // DragEvent may be missing in some engines — fall back to a MouseEvent with
    // the dataTransfer patched on so drop handlers reading e.dataTransfer work.
    let ev: Event;
    try {
      ev = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        ...(dt ? { dataTransfer: dt } : {}),
      });
    } catch {
      ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      if (dt) Object.defineProperty(ev, 'dataTransfer', { value: dt });
    }
    el.dispatchEvent(ev);
  };

  // Press on source.
  pointer(from, 'pointerdown', fx, fy);
  mouse(from, 'mousedown', fx, fy);
  // HTML5 DnD chain.
  drag(from, 'dragstart', fx, fy);
  drag(to, 'dragenter', tx, ty);
  drag(to, 'dragover', tx, ty);
  drag(to, 'drop', tx, ty);
  drag(from, 'dragend', tx, ty);
  // Pointer move + release on target (covers pointer-drag widgets).
  pointer(to, 'pointermove', tx, ty);
  mouse(to, 'mousemove', tx, ty);
  pointer(to, 'pointerup', tx, ty);
  mouse(to, 'mouseup', tx, ty);

  return { ok: true, from: { x: Math.round(fx), y: Math.round(fy) }, to: { x: Math.round(tx), y: Math.round(ty) } };
}

cli({
  site: 'generic',
  name: 'drag_and_drop',
  access: 'read',
  description:
    'Drag one element onto another (list/kanban reordering, sliders, file drop zones, canvas). Locate the source and target each via ref (get_interactives, the most stable) or selector. Synthesizes a full pointer/mouse press-move-release + HTML5 drag-and-drop event chain (dragstart→dragover→drop→dragend, sharing a DataTransfer), covering both kinds of controls as much as possible. ⚠️ Synthetic dragging is **best-effort**: libraries requiring trusted events or a specific step cadence may not respond; when it fails, switch to click/keyboard.',
  args: [
    { name: 'tab_id', type: 'int', required: true, help: 'Target tab id' },
    { name: 'from_ref', type: 'string', help: 'Source element ref (returned by get_interactives; one of from_ref / from_selector)' },
    { name: 'from_selector', type: 'string', help: 'Source element CSS selector (one of from_ref / from_selector)' },
    { name: 'to_ref', type: 'string', help: 'Target element ref (one of to_ref / to_selector)' },
    { name: 'to_selector', type: 'string', help: 'Target element CSS selector (one of to_ref / to_selector)' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const fromRef = typeof kwargs.from_ref === 'string' && kwargs.from_ref.trim() ? kwargs.from_ref.trim() : null;
    const fromSel =
      typeof kwargs.from_selector === 'string' && kwargs.from_selector.trim() ? kwargs.from_selector.trim() : null;
    const toRef = typeof kwargs.to_ref === 'string' && kwargs.to_ref.trim() ? kwargs.to_ref.trim() : null;
    const toSel =
      typeof kwargs.to_selector === 'string' && kwargs.to_selector.trim() ? kwargs.to_selector.trim() : null;
    const fromSelector = locatorToSelector(fromRef, fromSel);
    const toSelector = locatorToSelector(toRef, toSel);
    if (!fromSelector) throw new Error('need from_ref or from_selector');
    if (!toSelector) throw new Error('need to_ref or to_selector');
    // A frame-scoped ref targets that iframe; both endpoints must live in one frame.
    const frameId = fromRef ? parseFrameRef(fromRef).frameId : 0;
    const target: chrome.scripting.InjectionTarget = frameId ? { tabId, frameIds: [frameId] } : { tabId };

    const res = await chrome.scripting.executeScript({
      target,
      func: dragInPage,
      args: [fromSelector, toSelector],
    });
    const r = res[0]?.result;
    if (!r) throw new Error('executeScript returned no result (tab not scriptable?)');
    if (r.error) throw new Error(r.error);
    return { tabId, ...r };
  },
});
