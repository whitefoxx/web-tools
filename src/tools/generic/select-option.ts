import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep } from './_helpers';
import { flashAgentCursor } from './_agent-cursor';
import { captureSig, actionReceipt } from './_receipt';

/**
 * Set the value of a native <select>. get_interactives can SEE selects (it
 * lists their options) but nothing could CHOOSE one — click opens the dropdown
 * without picking, type_into reports "not typeable" (audit 2026-07-02 ④).
 * Value-setting goes through the native prototype setter + input/change events
 * so React/Vue controlled selects observe the change (same pattern as
 * type-into.ts). Custom div-based dropdowns are NOT selects — use click there.
 */
cli({
  site: 'generic',
  name: 'select_option',
  access: 'read',
  description:
    'Select an item in a native <select> dropdown (for a custom div dropdown, click to expand then click the option). Locate the option via value (exact) / label (visible text, exact first then contains) / index (0-based). Sets the value through a React-compatible native setter and dispatches input/change events. When nothing matches, returns selected:false and the list of options so you can retry with a different form',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help: 'Target tab id',
    },
    {
      name: 'ref',
      type: 'string',
      help: 'ref of the select element returned by get_interactives. One of ref / selector',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'CSS selector (e.g. `select[name="sort"]`). One of ref / selector',
    },
    {
      name: 'value',
      type: 'string',
      help: 'Match the option value exactly. One of value / label / index',
    },
    {
      name: 'label',
      type: 'string',
      help: 'Match by the option visible text (exact first, then contains)',
    },
    {
      name: 'index',
      type: 'int',
      help: 'Select by position (0-based)',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: 'Milliseconds to wait after selecting (many sites refresh the list on change). Default 0',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const ref = typeof kwargs.ref === 'string' ? kwargs.ref : null;
    const selectorArg = typeof kwargs.selector === 'string' ? kwargs.selector : null;
    if (!ref && !selectorArg) {
      throw new Error('Must provide either ref (from get_interactives) or selector (CSS).');
    }
    const value = typeof kwargs.value === 'string' ? kwargs.value : null;
    const label = typeof kwargs.label === 'string' ? kwargs.label : null;
    const indexRaw = Number(kwargs.index);
    const index = Number.isInteger(indexRaw) && indexRaw >= 0 ? indexRaw : null;
    if (value == null && label == null && index == null) {
      throw new Error('Must provide one of value / label / index to pick an option.');
    }
    const waitMs = Math.max(0, Math.min(30_000, Number(kwargs.wait_ms ?? 0)));
    const selector = ref ? `[data-web-ref="${ref}"]` : selectorArg!;

    const before = await captureSig({ tabId }); // ⑩ pre-action probe (best-effort)
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: selectInPage,
      args: [selector, value, label, index],
    });
    const r = results[0]?.result;
    if (!r) throw new Error('executeScript returned no result');
    if (!r.found) {
      throw new Error(
        `Element not found for ${ref ? `ref=${ref}` : `selector="${selectorArg}"`}. ` +
          `If the ref is stale, call get_interactives again.`,
      );
    }
    if (!r.is_select) {
      throw new Error(
        `Element is <${r.tag}>, not a native <select>. For custom dropdowns: click to open, then click the option.`,
      );
    }
    if (r.selected && typeof r.x === 'number' && typeof r.y === 'number') {
      void flashAgentCursor(tabId, r.x, r.y);
    }
    if (waitMs > 0) await sleep(waitMs);
    // ⑩ receipt: a controlled select often re-renders dependent fields/dialogs.
    const receipt = await actionReceipt(tabId, { tabId }, tab.url ?? '', before);
    const { x: _x, y: _y, ...rest } = r;
    return { tabId, ...rest, ...receipt };
  },
});

function selectInPage(
  selector: string,
  value: string | null,
  label: string | null,
  index: number | null,
): {
  found: boolean;
  is_select?: boolean;
  tag?: string;
  selected?: boolean;
  value?: string;
  text?: string;
  index?: number;
  options?: { index: number; value: string; text: string }[];
  hint?: string;
  x?: number;
  y?: number;
} {
  // Deep query incl. open shadow roots — self-contained (see click.ts). Bounded.
  function deepQuery(sel: string): Element | null {
    let visited = 0;
    const walk = (root: Document | ShadowRoot): Element | null => {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        if (++visited > 12000) return null;
        const sr = (all[i] as HTMLElement).shadowRoot;
        if (sr) {
          const hit = walk(sr);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(document);
  }
  const el = deepQuery(selector) as HTMLElement | null;
  if (!el) return { found: false };
  const tag = el.tagName.toLowerCase();
  if (tag !== 'select') return { found: true, is_select: false, tag };
  const sel = el as HTMLSelectElement;
  sel.scrollIntoView({ behavior: 'auto', block: 'center' });
  const opts = Array.from(sel.options);

  let target: HTMLOptionElement | null = null;
  if (index != null) target = opts[index] ?? null;
  else if (value != null) target = opts.find((o) => o.value === value) ?? null;
  else if (label != null) {
    const t = label.trim();
    target =
      opts.find((o) => (o.textContent ?? '').trim() === t) ??
      opts.find((o) => (o.textContent ?? '').trim().includes(t)) ??
      null;
  }
  if (!target) {
    return {
      found: true,
      is_select: true,
      selected: false,
      hint: 'No matching option; retry with a value/label/index from the options below',
      options: opts.slice(0, 50).map((o, i) => ({
        index: i,
        value: o.value,
        text: (o.textContent ?? '').trim().slice(0, 60),
      })),
    };
  }

  // Native prototype setter + input/change so controlled (React/Vue) selects
  // pick up the change — same pattern as type-into.ts.
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter) setter.call(sel, target.value);
  else sel.value = target.value;
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));

  const rect = sel.getBoundingClientRect();
  return {
    found: true,
    is_select: true,
    selected: true,
    value: target.value,
    text: (target.textContent ?? '').trim().slice(0, 80),
    index: opts.indexOf(target),
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}
