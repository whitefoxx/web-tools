import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep, parseFrameRef } from './_helpers';
import { flashAgentCursor } from './_agent-cursor';
import { captureSig, actionReceipt } from './_receipt';

cli({
  site: 'generic',
  name: 'type_into',
  access: 'read',
  description:
    'Type text into an input / textarea / rich-text editor. Prefer ref (from get_interactives, most stable), CSS selector also supported. Replaces the existing content by default; append=true to append. submit=true presses Enter after typing (good for a search box / single-line input; use with care on a multi-line textarea — may just insert a newline). Returns an **action receipt**: `popup_appeared:true` means the input triggered a suggestion / autocomplete list — **don\'t ignore it**, many sites require you to pick an item from the list for it to take effect; the receipt\'s `new_interactives` already carries these new elements\' ref+text, **click one directly** (suggestion lists are often fleeting, prefer these, don\'t re-scan first); `url_changed` means it navigated and all old refs are invalid',
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
      help: 'ref of the input/textarea/editable element returned by get_interactives. One of ref / selector',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'CSS selector (e.g. `input[name="q"]`). One of ref / selector',
    },
    {
      name: 'text',
      type: 'string',
      required: true,
      help: 'The text to type',
    },
    {
      name: 'append',
      type: 'bool',
      help: 'Whether to append instead of replacing the existing content. Default false (replace)',
    },
    {
      name: 'submit',
      type: 'bool',
      help: 'Whether to press Enter to submit after typing. Default false. On a single-line input usually = trigger form submit; on a textarea / contenteditable usually = newline (unless the site binds Enter to send, e.g. a chat box)',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: 'Milliseconds to wait after typing. When submit=true, give a wait_ms to let the request fly. Default 0',
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
    const text = String(kwargs.text ?? '');
    const append = !!kwargs.append;
    const submit = !!kwargs.submit;
    const waitMs = Math.max(0, Math.min(30_000, Number(kwargs.wait_ms ?? 0)));
    // A frame-scoped ref (`f<id>…`) targets that iframe; inside the frame the
    // DOM attribute is the un-prefixed localRef.
    const parsed = ref ? parseFrameRef(ref) : null;
    const selector = parsed ? `[data-web-ref="${parsed.localRef}"]` : selectorArg!;
    const target: chrome.scripting.InjectionTarget =
      parsed && parsed.frameId ? { tabId, frameIds: [parsed.frameId] } : { tabId };

    const before = await captureSig(target); // ⑩ pre-action probe (best-effort)
    const results = await chrome.scripting.executeScript({
      target,
      func: typeIntoInPage,
      args: [selector, text, append, submit],
    });
    const r = results[0]?.result;
    if (!r) throw new Error('executeScript returned no result');
    if (!r.found) {
      throw new Error(
        `Element not found for ${ref ? `ref=${ref}` : `selector="${selectorArg}"`}. ` +
          `Re-run get_interactives if the page has changed.`,
      );
    }
    if (!r.typed) {
      throw new Error(
        `Element found but not typeable (kind="${r.kind}"). type_into supports input / textarea / contenteditable.`,
      );
    }
    // Skip the cursor for iframe elements — coords are frame-relative.
    if (!parsed?.frameId && typeof r.x === 'number' && typeof r.y === 'number') {
      void flashAgentCursor(tabId, r.x, r.y, undefined, r.w, r.h); // ⑧+B: cursor + target pulse
    }
    if (waitMs > 0) await sleep(waitMs);
    // ⑩ receipt: navigation / popup (autocomplete!) / DOM growth since the probe.
    const receipt = await actionReceipt(tabId, target, tab.url ?? '', before);
    return { tabId, ...r, ...receipt };
  },
});

function typeIntoInPage(
  selector: string,
  text: string,
  append: boolean,
  submit: boolean,
): {
  found: boolean;
  typed?: boolean;
  kind?: string;
  final_value?: string;
  submit_attempted?: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
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
  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  (el as HTMLElement).focus?.();
  // Element centre for the ⑧ agent cursor (after scroll so it's in-viewport).
  const _rect = el.getBoundingClientRect();
  const cx = _rect.left + _rect.width / 2;
  const cy = _rect.top + _rect.height / 2;

  const tag = el.tagName.toLowerCase();
  let typed = false;
  let kind = tag;

  if (tag === 'input' || tag === 'textarea') {
    const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
    kind =
      tag === 'textarea'
        ? 'textarea'
        : `input[type=${(inputEl as HTMLInputElement).type || 'text'}]`;
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const newValue = append ? (inputEl.value ?? '') + text : text;
    if (setter) setter.call(inputEl, newValue);
    else inputEl.value = newValue;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    typed = true;
  } else if (el.isContentEditable) {
    kind = 'contenteditable';
    const expected = append ? (el.innerText ?? '') + text : text;

    // Plan A (page-agent borrow): drive the editor with a synthetic
    // beforeinput/InputEvent carrying inputType + data — controlled rich-text
    // editors (React / Lexical / Slate / ProseMirror) read these to update their
    // own model, which execCommand-at-browser-selection can miss. Put the selection
    // where the edit goes first (whole contents for replace, caret-end for append).
    // If the editor CANCELS beforeinput it applies the edit itself, so we skip the
    // manual mutation; otherwise we set innerText + emit `input` to match.
    {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (append) range.collapse(false); // caret to end; else select whole content
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    if (
      el.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        }),
      )
    ) {
      el.innerText = expected;
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
      );
    }

    // Plan B: if Plan A didn't land (editor ignored the synthetic events — e.g.
    // requires isTrusted), fall back to the previous execCommand path. This IS the
    // pre-existing behavior, so ②b only adds coverage and never regresses.
    if ((el.innerText ?? '').trim() !== expected.trim()) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      if (append) range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      if (!append) {
        try {
          document.execCommand('delete');
        } catch {
          el.textContent = '';
        }
      }
      try {
        document.execCommand('insertText', false, text);
      } catch {
        el.textContent = (el.textContent ?? '') + text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    typed = true;
  }

  let submitAttempted = false;
  if (typed && submit) {
    const keydown = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    const keypress = new KeyboardEvent('keypress', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    const keyup = new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(keydown);
    el.dispatchEvent(keypress);
    el.dispatchEvent(keyup);
    // Also try requestSubmit on parent form (some sites listen there, not on Enter key).
    const form = (el as HTMLInputElement).form;
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit();
      } catch {}
    }
    submitAttempted = true;
  }

  let finalValue = '';
  if (tag === 'input' || tag === 'textarea') {
    finalValue = ((el as HTMLInputElement).value ?? '').slice(0, 200);
  } else if (el.isContentEditable) {
    finalValue = (el.innerText ?? '').slice(0, 200);
  }

  return {
    found: true,
    typed,
    kind,
    final_value: finalValue,
    submit_attempted: submitAttempted,
    x: cx,
    y: cy,
    w: Math.round(_rect.width),
    h: Math.round(_rect.height),
  };
}
