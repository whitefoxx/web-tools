/**
 * `fill_form` — set N form fields in ONE call.
 *
 * Borrowed from chrome-devtools-mcp's tool of the same name
 * (docs/devtools-mcp-comparison.md §2②). `type_into` handles one field per
 * round-trip, so a login is 2 LLM turns and a checkout is 6; each of those turns
 * costs a full model call for what is mechanically one DOM pass. This is a
 * low-level DOM batch, NOT orchestration, so it passes the "add primitives, not
 * upper-layer tools" rule (docs/webcli.md §2).
 *
 * It deliberately covers more element kinds than `type_into` does, because a
 * real form is not all text boxes: <select> (by value or by visible label) and
 * checkbox/radio (by truthiness) are part of "fill this form" and would
 * otherwise send the agent back out to `select_option` mid-batch.
 */
import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep, parseFrameRef } from './_helpers';
import { captureSig, actionReceipt } from './_receipt';

export interface FormField {
  ref?: string;
  selector?: string;
  value: string;
  append?: boolean;
}

/**
 * Parse the `fields` argument. Accepts a JSON array (the documented form) or an
 * already-decoded array, mirroring `manage_tabs`' `tab_ids` convention — the
 * registry's arg types are scalar-only (string/int/bool, see tools/manifest.ts
 * TYPE_MAP), and every transport renders that schema, so a list arg travels as a
 * JSON string rather than forcing an array type through three catalogs.
 *
 * Throws with an actionable message: a half-understood form spec must not
 * silently fill the wrong boxes.
 */
export function parseFields(raw: unknown): FormField[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) throw new Error('fields must not be empty');
    try {
      arr = JSON.parse(s);
    } catch {
      throw new Error(
        'fields must be a JSON array, e.g. [{"ref":"r3","value":"alice"},{"selector":"#pw","value":"secret"}]',
      );
    }
  }
  if (!Array.isArray(arr)) throw new Error('fields must be a JSON array of field objects');
  if (arr.length === 0) throw new Error('fields must not be empty');
  return arr.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`fields[${i}] must be an object with ref|selector and value`);
    }
    const f = item as Record<string, unknown>;
    const ref = typeof f.ref === 'string' && f.ref.trim() ? f.ref.trim() : undefined;
    const selector =
      typeof f.selector === 'string' && f.selector.trim() ? f.selector.trim() : undefined;
    if (!ref && !selector) {
      throw new Error(`fields[${i}] needs either "ref" (from get_interactives) or "selector" (CSS)`);
    }
    if (f.value === undefined || f.value === null) {
      throw new Error(`fields[${i}] needs a "value" (use "" to clear, "true"/"false" for a checkbox)`);
    }
    return {
      ...(ref ? { ref } : {}),
      ...(selector ? { selector } : {}),
      value: String(f.value),
      ...(f.append ? { append: true } : {}),
    };
  });
}

/** Group fields by the frame their ref points into, so each frame takes exactly
 * one injection. Selector fields and plain refs land in the main frame (0). */
export function groupByFrame(fields: FormField[]): Map<number, FormField[]> {
  const out = new Map<number, FormField[]>();
  for (const f of fields) {
    const frameId = f.ref ? parseFrameRef(f.ref).frameId : 0;
    const list = out.get(frameId);
    if (list) list.push(f);
    else out.set(frameId, [f]);
  }
  return out;
}

cli({
  site: 'generic',
  name: 'fill_form',
  access: 'read',
  description:
    'Fill MULTIPLE form fields in one call — prefer this over repeated type_into whenever you are filling more than one box (a login, a search filter panel, a checkout form): one call instead of N round-trips, and the fields are set in a single DOM pass so a form that reacts to input only reflows once. Handles text inputs / textareas / rich-text editors, <select> (match by option value OR by the visible label), and checkbox / radio (value "true"/"false"). Pass fields as a JSON array of {ref|selector, value}. Returns per-field results (so a single bad selector does not hide the ones that worked) plus the same action receipt as type_into: `popup_appeared` means a suggestion list opened — its `new_interactives` carry ref+text, click one directly. submit=true presses Enter on the last filled field and asks its form to submit',
  args: [
    { name: 'tab_id', type: 'int', required: true, help: 'Target tab id' },
    {
      name: 'fields',
      type: 'string',
      required: true,
      help: 'JSON array of fields, e.g. [{"ref":"r3","value":"alice@example.com"},{"selector":"#password","value":"hunter2"},{"ref":"r9","value":"true"}]. Each item needs ref (from get_interactives, most stable) or selector (CSS), plus value; optional append:true adds to the existing content instead of replacing it',
    },
    {
      name: 'submit',
      type: 'bool',
      help: 'Whether to submit after filling: presses Enter on the LAST filled field and calls requestSubmit() on its form. Default false',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: 'Milliseconds to wait after filling (give the page time when submit=true). Default 0',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const fields = parseFields(kwargs.fields);
    const submit = !!kwargs.submit;
    const waitMs = Math.max(0, Math.min(30_000, Number(kwargs.wait_ms ?? 0)));

    const byFrame = groupByFrame(fields);
    const mainTarget: chrome.scripting.InjectionTarget = { tabId };
    const before = await captureSig(mainTarget); // ⑩ pre-action probe (best-effort)

    const results: FillResult[] = [];
    for (const [frameId, group] of byFrame) {
      const target: chrome.scripting.InjectionTarget =
        frameId > 0 ? { tabId, frameIds: [frameId] } : { tabId };
      // Inside a frame the DOM attribute is the un-prefixed localRef.
      const specs = group.map((f) => ({
        selector: f.ref ? `[data-web-ref="${parseFrameRef(f.ref).localRef}"]` : f.selector!,
        label: f.ref ?? f.selector!,
        value: f.value,
        append: !!f.append,
      }));
      // Submit only from the frame that owns the LAST field overall.
      const submitHere = submit && group[group.length - 1] === fields[fields.length - 1];
      const injected = await chrome.scripting.executeScript({
        target,
        func: fillFormInPage,
        args: [specs, submitHere],
      });
      const r = injected[0]?.result;
      if (!r) {
        for (const s of specs) results.push({ field: s.label, ok: false, error: 'executeScript returned no result' });
        continue;
      }
      results.push(...r);
    }

    if (waitMs > 0) await sleep(waitMs);
    const receipt = await actionReceipt(tabId, mainTarget, tab.url ?? '', before);
    const filled = results.filter((r) => r.ok).length;
    return {
      tabId,
      filled,
      total: results.length,
      ...(filled < results.length
        ? {
            hint: 'Some fields did not take. Check their ref/selector — refs go stale after a navigation or a re-render, so re-run get_interactives before retrying just the failures.',
          }
        : {}),
      results,
      ...receipt,
    };
  },
});

interface FillResult {
  field: string;
  ok: boolean;
  kind?: string;
  final_value?: string;
  error?: string;
}

/** Runs IN the page. Self-contained by necessity (executeScript serializes it),
 * which is also this codebase's convention for in-page helpers — see click.ts. */
function fillFormInPage(
  specs: Array<{ selector: string; label: string; value: string; append: boolean }>,
  submitLast: boolean,
): FillResult[] {
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

  const truthy = (v: string): boolean => !/^(false|0|off|no|unchecked|)$/i.test(v.trim());

  /** React (and friends) install a value setter on the instance to detect dirty
   * writes; assigning `el.value` directly is swallowed. Go through the prototype
   * setter — same trick type_into uses, and the reason a naive fill "works" in
   * the DOM but the app never sees it. */
  function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, v: string): void {
    const proto =
      el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT'
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v);
    else (el as { value: string }).value = v;
  }

  const fire = (el: Element, ...types: string[]): void => {
    for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true }));
  };

  const out: FillResult[] = [];
  let lastEl: HTMLElement | null = null;

  for (const spec of specs) {
    const el = deepQuery(spec.selector) as HTMLElement | null;
    if (!el) {
      out.push({ field: spec.label, ok: false, error: 'element not found' });
      continue;
    }
    el.scrollIntoView({ behavior: 'auto', block: 'center' });
    el.focus?.();
    const tag = el.tagName.toLowerCase();

    try {
      if (tag === 'select') {
        const sel = el as HTMLSelectElement;
        const want = spec.value.trim();
        const opts = Array.from(sel.options);
        const hit =
          opts.find((o) => o.value === want) ??
          opts.find((o) => (o.textContent ?? '').trim() === want) ??
          opts.find((o) => (o.textContent ?? '').trim().toLowerCase() === want.toLowerCase()) ??
          opts.find((o) => (o.textContent ?? '').toLowerCase().includes(want.toLowerCase()));
        if (!hit) {
          out.push({
            field: spec.label,
            ok: false,
            kind: 'select',
            error: `no option matching "${want}" (options: ${opts
              .slice(0, 12)
              .map((o) => (o.textContent ?? '').trim())
              .join(' | ')})`,
          });
          continue;
        }
        setNativeValue(sel, hit.value);
        fire(sel, 'input', 'change');
        out.push({ field: spec.label, ok: true, kind: 'select', final_value: hit.value });
        lastEl = el;
        continue;
      }

      if (tag === 'input') {
        const input = el as HTMLInputElement;
        const type = (input.type || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          const want = type === 'radio' ? true : truthy(spec.value);
          if (input.checked !== want) input.click(); // click, so bound handlers run
          if (input.checked !== want) {
            input.checked = want;
            fire(input, 'input', 'change');
          }
          out.push({ field: spec.label, ok: true, kind: type, final_value: String(input.checked) });
          lastEl = el;
          continue;
        }
        setNativeValue(input, spec.append ? (input.value ?? '') + spec.value : spec.value);
        fire(input, 'input', 'change');
        out.push({
          field: spec.label,
          ok: true,
          kind: `input[type=${type}]`,
          final_value: (input.value ?? '').slice(0, 200),
        });
        lastEl = el;
        continue;
      }

      if (tag === 'textarea') {
        const ta = el as HTMLTextAreaElement;
        setNativeValue(ta, spec.append ? (ta.value ?? '') + spec.value : spec.value);
        fire(ta, 'input', 'change');
        out.push({
          field: spec.label,
          ok: true,
          kind: 'textarea',
          final_value: (ta.value ?? '').slice(0, 200),
        });
        lastEl = el;
        continue;
      }

      if (el.isContentEditable) {
        // Same two-plan approach as type_into: let a controlled editor apply the
        // edit itself if it cancels beforeinput, otherwise write it ourselves.
        const expected = spec.append ? (el.innerText ?? '') + spec.value : spec.value;
        const range = document.createRange();
        range.selectNodeContents(el);
        if (spec.append) range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        if (
          el.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: spec.value,
            }),
          )
        ) {
          el.innerText = expected;
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, inputType: 'insertText', data: spec.value }),
          );
        }
        out.push({
          field: spec.label,
          ok: true,
          kind: 'contenteditable',
          final_value: (el.innerText ?? '').slice(0, 200),
        });
        lastEl = el;
        continue;
      }

      out.push({
        field: spec.label,
        ok: false,
        kind: tag,
        error: `not a fillable element (kind="${tag}") — fill_form supports input / textarea / select / contenteditable`,
      });
    } catch (e) {
      out.push({
        field: spec.label,
        ok: false,
        kind: tag,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (submitLast && lastEl) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      lastEl.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    // `.form` exists only on form CONTROLS. A batch that ends on a
    // contenteditable (a rich-text box is very often the last field) has none,
    // and submit silently did nothing — observed on the first real-machine run,
    // findings F-43. `closest('form')` covers both.
    const form =
      (lastEl as HTMLInputElement).form ?? (lastEl.closest('form') as HTMLFormElement | null);
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit();
      } catch {}
    }
  }

  return out;
}
