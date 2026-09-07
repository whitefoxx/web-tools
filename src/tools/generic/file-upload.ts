import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';

/**
 * file_upload — set a file into an `<input type=file>` from AGENT-PROVIDED
 * content (text or base64 bytes), no CDP. Content scripts can't forge a native
 * file picker, but in the MAIN world you CAN build a `File`, stuff it into a
 * `DataTransfer`, assign `input.files`, and fire input/change — the same trick
 * Playwright/userscripts use as the non-CDP path. So this works for content the
 * agent HAS (a generated CSV, a base64 image, fetched bytes) — not an arbitrary
 * path on the user's disk (the extension has no disk access).
 *
 * `setInputFiles` is self-contained (serialized alone) + exported; `b64ToBytes`
 * is a pure exported helper (unit-tested — the DOM assignment path is
 * real-browser-only).
 */

/** Decode a base64 string to a byte array. Pure; exported for tests. Throws on
 * invalid base64 (atob does). */
export function b64ToBytes(b64: string): number[] {
  const bin = atob(b64);
  const out = new Array<number>(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** In-page (MAIN world). Build a File from text|base64 and assign it to the
 * matched (or first) file input, firing input+change. Returns ok / error. */
export function setInputFiles(
  selector: string | null,
  filename: string,
  mime: string,
  b64: string | null,
  text: string | null,
): { ok?: boolean; error?: string; filename?: string; size?: number; files?: number } {
  const el = selector
    ? document.querySelector(selector)
    : document.querySelector('input[type="file"]');
  if (!el || !(el instanceof HTMLInputElement) || el.type !== 'file') {
    return { error: selector ? `selector matched no <input type=file>: ${selector}` : 'page has no <input type=file> (pass selector to specify one)' };
  }
  let bytes: Uint8Array;
  if (b64 != null) {
    try {
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (e) {
      return { error: `content_base64 decode failed: ${String(e)}` };
    }
  } else {
    bytes = new TextEncoder().encode(text ?? '');
  }
  try {
    const file = new File([bytes as BlobPart], filename, mime ? { type: mime } : undefined);
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, filename, size: bytes.length, files: el.files.length };
  } catch (e) {
    return { error: `Failed to set file: ${String(e)} (the browser may restrict this input)` };
  }
}

cli({
  site: 'generic',
  name: 'file_upload',
  access: 'read',
  description:
    'Push a file into the page\'s `<input type=file>`, with content **you provide** (not a user disk path — the extension has no disk access): either content (text, e.g. a generated CSV/JSON) or content_base64 (binary, e.g. an image), filename required, mime_type optional. selector picks which file input (omit to take the first on the page). Builds a File → DataTransfer → assigns to input.files and fires input/change. Returns {ok,filename,size}. After uploading you usually still need to click the submit button.',
  args: [
    { name: 'tab_id', type: 'int', required: true, help: 'Target tab id' },
    { name: 'filename', type: 'string', required: true, help: 'File name (with extension, e.g. data.csv / avatar.png)' },
    { name: 'content', type: 'string', help: 'Text content (one of content / content_base64)' },
    { name: 'content_base64', type: 'string', help: 'base64 of binary content (one of content / content_base64)' },
    { name: 'mime_type', type: 'string', help: 'Optional MIME type (e.g. text/csv, image/png)' },
    { name: 'selector', type: 'string', help: 'Optional CSS selector for the <input type=file>; omit to take the first' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const filename = String(kwargs.filename ?? '').trim();
    if (!filename) throw new Error('filename is required');
    const hasB64 = typeof kwargs.content_base64 === 'string' && kwargs.content_base64.length > 0;
    const hasText = typeof kwargs.content === 'string';
    if (!hasB64 && !hasText) throw new Error('need either content (text) or content_base64 (binary)');
    const mime = typeof kwargs.mime_type === 'string' ? kwargs.mime_type.trim() : '';
    const selector =
      typeof kwargs.selector === 'string' && kwargs.selector.trim() ? kwargs.selector.trim() : null;

    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: setInputFiles,
      args: [selector, filename, mime, hasB64 ? String(kwargs.content_base64) : null, hasText ? String(kwargs.content) : null],
    });
    const r = res[0]?.result;
    if (!r) throw new Error('executeScript returned no result (tab not scriptable?)');
    if (r.error) throw new Error(r.error);
    return { tabId, ...r };
  },
});
