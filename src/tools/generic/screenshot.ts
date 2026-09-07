import { cli } from '../../runtime/registry.js';
import { assertHttpUrl, assertTabId, waitForPageReady, sleep } from './_helpers';
import { createAgentTab } from '../../background/agent-window';

export type ShotFormat = 'png' | 'jpeg' | 'webp';

/** Normalize + validate the three cost knobs (① of the chrome-devtools-mcp
 * borrows, docs/devtools-mcp-comparison.md §2①). Pure, so it is unit-testable
 * without a browser. Throws on an unsupported format rather than silently
 * substituting one — same rule as web_search's `engine` (docs/webcli.md §2). */
export function resolveShotEncoding(kwargs: Record<string, unknown>): {
  format: ShotFormat;
  /** undefined for png — CDP/canvas ignore quality for a lossless codec. */
  quality?: number;
  maxWidth?: number;
} {
  const raw =
    kwargs.format == null || kwargs.format === '' ? 'png' : String(kwargs.format).toLowerCase();
  if (raw !== 'png' && raw !== 'jpeg' && raw !== 'webp') {
    throw new Error(`unsupported format "${raw}" — use one of: png, jpeg, webp`);
  }
  const format = raw as ShotFormat;
  let quality: number | undefined;
  if (format !== 'png') {
    // Only reachable when the caller explicitly opted into a lossy codec, so a
    // default here is not a silent change to anyone's bytes.
    const q = Number(kwargs.quality ?? 80);
    quality = Math.max(1, Math.min(100, Number.isFinite(q) ? Math.round(q) : 80));
  }
  let maxWidth: number | undefined;
  if (kwargs.max_width != null && kwargs.max_width !== '') {
    const w = Number(kwargs.max_width);
    if (!Number.isFinite(w) || w < 64) throw new Error('max_width must be a number >= 64');
    maxWidth = Math.min(Math.round(w), 20000);
  }
  return {
    format,
    ...(quality !== undefined ? { quality } : {}),
    ...(maxWidth ? { maxWidth } : {}),
  };
}

/** Compose vertically-offset PNG chunks into ONE image (base64, no `data:`
 * prefix), optionally downscaled and re-encoded. Runs in the SW via
 * OffscreenCanvas — used both for full-page screenshots of pages taller than a
 * single GPU capture (F-36) and for the `max_width` downscale. Each chunk was
 * captured with a clip at its `y`, so drawing it at (0, y) reconstructs the page
 * seamlessly (position:fixed elements render once at the top, not per chunk).
 *
 * Chunks are always PNG on the way in: a lossless intermediate means the lossy
 * encode happens exactly once, at the end, instead of once per chunk. */
async function composeChunks(
  width: number,
  height: number,
  chunks: Array<{ y: number; data: string }>,
  enc: { format: ShotFormat; quality?: number; maxWidth?: number },
): Promise<{ data: string; width: number; height: number }> {
  const scale = enc.maxWidth && width > enc.maxWidth ? enc.maxWidth / width : 1;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context for compose');
  for (const c of chunks) {
    const bytes = Uint8Array.from(atob(c.data), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    if (scale === 1) ctx.drawImage(bmp, 0, c.y);
    else
      ctx.drawImage(
        bmp,
        0,
        Math.round(c.y * scale),
        Math.round(bmp.width * scale),
        Math.round(bmp.height * scale),
      );
    bmp.close();
  }
  const blob = await canvas.convertToBlob({
    type: `image/${enc.format}`,
    ...(enc.quality !== undefined ? { quality: enc.quality / 100 } : {}),
  });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CH = 0x8000; // encode in 32KB slices (spread-arg limit)
  for (let i = 0; i < buf.length; i += CH) {
    bin += String.fromCharCode(...buf.subarray(i, i + CH));
  }
  return { data: btoa(bin), width: outW, height: outH };
}

/**
 * What an element-scoped screenshot points at, resolved from the two ways a
 * caller can name one. A `ref` is what get_interactives handed out (stamped on
 * the element as `data-web-ref`); a `selector` is any CSS selector. Refs inside
 * an iframe (`f5r3`) are refused rather than mis-clipped: the clip is in the top
 * document's coordinates, and a sub-frame's rect would need that frame's own
 * offset added — a real feature, not a v1 one. Pure.
 */
export function resolveClipTarget(
  kwargs: Record<string, unknown>,
): { selector: string; label: string } | null {
  const ref = typeof kwargs.ref === 'string' ? kwargs.ref.trim() : '';
  const selector = typeof kwargs.selector === 'string' ? kwargs.selector.trim() : '';
  if (ref && selector) throw new Error('pass only one of ref and selector');
  if (!ref && !selector) return null;
  if (ref) {
    if (/^f\d+r/.test(ref)) {
      throw new Error(
        `ref ${ref} is inside an iframe; element screenshots clip in the top document only. Screenshot the tab and crop, or pass a selector for the iframe element itself.`,
      );
    }
    return { selector: `[data-web-ref="${ref.replace(/"/g, '\\"')}"]`, label: ref };
  }
  return { selector, label: selector };
}

/**
 * In-page: the element's box in PAGE coordinates (CSS px, scroll included),
 * which is what a CDP clip with captureBeyondViewport wants. Self-contained —
 * executeScript serializes it. Returns null when nothing matches or the match
 * has no box (display:none, detached).
 */
export function measureElementInPage(
  selector: string,
): { x: number; y: number; width: number; height: number } | null {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return {
    x: Math.max(0, Math.round(r.left + window.scrollX)),
    y: Math.max(0, Math.round(r.top + window.scrollY)),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

cli({
  site: 'generic',
  name: 'screenshot',
  access: 'read',
  description:
    'Take a screenshot (PNG base64, very token-heavy). **First decide whether you even need one: if you can read the text, don\'t — get_page_text for the body/Markdown is usually enough, cheaper and more precise. Screenshot only when: ① the visuals/layout are themselves the point of the task (design, layout, comparing appearance); ② the content is mostly non-text (charts, images, maps, captchas); ③ you need to visually confirm the result of an action.** Two modes: ① url — open the page, wait for it to settle, screenshot, then close the tab; ② tab_id — screenshot an already-open tab directly (preserving its current state: SPA route, popups, scroll position; not closed). Pair with get_interactives highlight:true to number the elements before screenshotting a tab (Set-of-Mark). full_page:true captures the whole page (more token-heavy, use with care). **When you do need one, size it — `max_width` first, then `format:"webp"`.** Measured on real pages: `max_width:1024` alone cut a page shot ~4x, and webp is ~0.4x of png on both photo-heavy and flat UI pages. Do NOT reach for jpeg by reflex — on a typical flat-colour app UI it comes out LARGER than png (real measurement: 157KB jpeg vs 141KB png); it only beats png on photo-heavy pages, where webp still beats it. Keep the png default when you must read fine print (captcha, chart labels, dense tables). Note: captured via chrome.debugger, so a yellow "debugging" banner shows during capture',
  args: [
    {
      name: 'url',
      type: 'string',
      help: 'URL of the page to screenshot (http/https). One of url / tab_id',
    },
    {
      name: 'tab_id',
      type: 'int',
      help: 'id of an already-open tab to screenshot (preserves the page current state, not closed). One of url / tab_id',
    },
    {
      name: 'max_wait_ms',
      type: 'int',
      help: 'Max total load-wait time (ms). Default 15000 in url mode; 3000 in tab_id mode (the page is usually already ready)',
    },
    {
      name: 'quiet_ms',
      type: 'int',
      help: 'innerText-stable threshold (ms). Default 1000 in url mode; 500 in tab_id mode',
    },
    {
      name: 'wait_for_selector',
      type: 'string',
      help: 'Optional: screenshot as soon as this CSS selector matches (short-circuits the stability check)',
    },
    {
      name: 'full_page',
      type: 'bool',
      help: 'Whether to capture the whole page (not just the viewport). Default false. Not combinable with ref / selector',
    },
    {
      name: 'ref',
      type: 'string',
      help: "Screenshot ONE element: a ref from get_interactives (e.g. r7). The image is clipped to that element's box, wherever it is on the page — far cheaper than a whole-page shot when one chart, table or card is the point. Top-document refs only (an iframe ref like f5r3 is refused)",
    },
    {
      name: 'selector',
      type: 'string',
      help: 'Screenshot ONE element by CSS selector (first match). Same clipping as ref',
    },
    {
      name: 'format',
      type: 'string',
      help: 'Image codec: "png" (default, lossless — best when you must READ small text, a captcha or a chart label), "jpeg" or "webp" (lossy, typically several times smaller — use when you only need to see layout / appearance / whether an action worked). An unsupported value is an error, not a silent fallback',
    },
    {
      name: 'quality',
      type: 'int',
      help: 'Encoder quality 1-100 for jpeg/webp only (default 80). Ignored for png',
    },
    {
      name: 'max_width',
      type: 'int',
      help: 'Downscale to at most this many CSS px wide, preserving aspect ratio (min 64). The cheapest single lever there is: halving the width quarters the pixels. A wide desktop capture at max_width 1024 stays perfectly readable for layout questions',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const urlArg = typeof kwargs.url === 'string' && kwargs.url.trim() ? kwargs.url.trim() : null;
    const hasTabId = kwargs.tab_id != null && kwargs.tab_id !== '';
    if (!urlArg && !hasTabId) {
      throw new Error(
        'need either url (screenshot a new page) or tab_id (screenshot an already-open tab)',
      );
    }
    if (urlArg && hasTabId) throw new Error('pass only one of url and tab_id');
    const waitForSelector =
      typeof kwargs.wait_for_selector === 'string' ? kwargs.wait_for_selector : undefined;
    const fullPage = !!kwargs.full_page;
    const clipTarget = resolveClipTarget(kwargs);
    if (fullPage && clipTarget) throw new Error('full_page cannot be combined with ref / selector');
    const enc = resolveShotEncoding(kwargs);
    // A resize is the ONLY thing that forces a canvas round-trip; a plain format
    // change is done by the encoder inside CDP, which is strictly cheaper.
    const canvasPass = !!enc.maxWidth;

    let tabId: number;
    let ownTab = false;
    let pageUrl: string;
    let maxWaitMs: number;
    let quietMs: number;
    if (urlArg) {
      const url = assertHttpUrl(urlArg);
      // Open in the dedicated agent window (not the user's focused window) — same
      // seam open_url uses. A bare chrome.tabs.create omits windowId → Chrome puts
      // the tab in the user's current window (flashes there before we remove it).
      const tab = await createAgentTab(url, { active: false });
      if (typeof tab.id !== 'number') throw new Error('failed to open tab');
      tabId = tab.id;
      ownTab = true;
      pageUrl = url;
      maxWaitMs = Number(kwargs.max_wait_ms ?? 15_000);
      quietMs = Number(kwargs.quiet_ms ?? 1000);
    } else {
      const tab = await assertTabId(kwargs.tab_id);
      tabId = tab.id!;
      pageUrl = tab.url ?? '';
      maxWaitMs = Number(kwargs.max_wait_ms ?? 3000);
      quietMs = Number(kwargs.quiet_ms ?? 500);
    }

    const target: chrome.debugger.Debuggee = { tabId };
    let attached = false;
    // Whether WE attached (vs. reusing an attachment another client holds — the
    // tab_id mode is routinely used on the explore tab, where the session's
    // network recorder owns the debugger). Only the owner detaches (page.ts
    // convention), so screenshotting the explore tab can't kill its capture.
    let ownsAttachment = false;
    try {
      const ready = await waitForPageReady(tabId, { maxWaitMs, quietMs, waitForSelector });
      try {
        await chrome.debugger.attach(target, '1.3');
        ownsAttachment = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/already attached|Another debugger/i.test(msg)) throw e;
      }
      attached = true;
      // Full-page capture. Plain `captureBeyondViewport:true` with NO clip TILES
      // the viewport — CDP repeats the current view to fill an ill-defined height
      // (F-36: a background/agent-window tab returned the same screen over and
      // over). Fix: normalize to a desktop viewport, read the REAL content size
      // (Page.getLayoutMetrics), and clip to it. Tall pages exceed the GPU
      // single-shot limit, so capture in vertical CHUNKS and STITCH into one
      // continuous PNG (OffscreenCanvas). Normal pages take one shot.
      let contentSize: { width: number; height: number } | undefined;
      let capNote: string | undefined;
      const captureClip = async (
        clip?: { x: number; y: number; width: number; height: number },
        /** Force a lossless capture because a canvas pass will re-encode later —
         * encoding lossily twice would stack artefacts for no size win. */
        forcePng = false,
      ): Promise<string> => {
        const fmt = forcePng ? 'png' : enc.format;
        const p: Record<string, unknown> = clip
          ? { format: fmt, captureBeyondViewport: true, clip: { ...clip, scale: 1 } }
          : { format: fmt };
        if (!forcePng && enc.quality !== undefined) p.quality = enc.quality;
        const r = (await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', p)) as
          | { data?: string }
          | undefined;
        const d = r?.data ?? '';
        if (!d) throw new Error('Page.captureScreenshot returned no data');
        return d;
      };

      /** Decode → (optionally) downscale → encode once, for the paths where CDP
       * cannot do it for us. Reuses the stitcher with a single chunk. */
      const recodeOne = async (
        pngB64: string,
      ): Promise<{ data: string; width: number; height: number }> => {
        const bytes = Uint8Array.from(atob(pngB64), (ch) => ch.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const w = bmp.width;
        const h = bmp.height;
        bmp.close();
        return composeChunks(w, h, [{ y: 0, data: pngB64 }], enc);
      };

      let data: string;
      let outSize: { width: number; height: number } | undefined;
      let elementClip: { x: number; y: number; width: number; height: number } | undefined;
      if (clipTarget) {
        const [m] = await chrome.scripting.executeScript({
          target: { tabId },
          func: measureElementInPage,
          args: [clipTarget.selector],
        });
        const box = m?.result;
        if (!box) {
          throw new Error(
            `${clipTarget.label} matched nothing visible on the page (no element, or it has no box — hidden / display:none). Run get_interactives again for a fresh ref.`,
          );
        }
        elementClip = box;
        if (!canvasPass) {
          data = await captureClip(box);
        } else {
          const out = await recodeOne(await captureClip(box, true));
          data = out.data;
          outSize = { width: out.width, height: out.height };
        }
      } else if (!fullPage) {
        if (!canvasPass) {
          data = await captureClip();
        } else {
          const out = await recodeOne(await captureClip(undefined, true));
          data = out.data;
          outSize = { width: out.width, height: out.height };
        }
      } else {
        // Normalize width so a small/background agent window doesn't reflow the
        // page absurdly tall (which also starves the clip). Only when WE own the
        // attachment — never reshape a page another client's debugger is driving.
        // Detach in `finally` auto-clears the override.
        if (ownsAttachment) {
          try {
            await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
              mobile: false,
              width: 1280,
              height: 900,
              deviceScaleFactor: 1,
            });
            await sleep(300); // reflow + lazy content settle
          } catch {
            /* best-effort; the clip below still fixes the tiling */
          }
        }
        const m = (await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics')) as {
          cssContentSize?: { width: number; height: number };
          contentSize?: { width: number; height: number };
        } | null;
        const cs = m?.cssContentSize ?? m?.contentSize;
        if (!cs?.width || !cs?.height) {
          // metrics unavailable → best-effort viewport
          if (!canvasPass) {
            data = await captureClip();
          } else {
            const out = await recodeOne(await captureClip(undefined, true));
            data = out.data;
            outSize = { width: out.width, height: out.height };
          }
        } else {
          const CHUNK = 12000; // per-CDP-capture height (safely < GPU limit)
          const HARD_MAX = 50000; // canvas / SW-memory guard for absurd pages
          const width = Math.max(1, Math.ceil(cs.width));
          const fullH = Math.max(1, Math.ceil(cs.height));
          contentSize = { width, height: fullH };
          const targetH = Math.min(fullH, HARD_MAX);
          if (fullH > HARD_MAX) {
            capNote = `Page height ${fullH}px exceeds the ${HARD_MAX}px cap; captured the first ${HARD_MAX}px`;
          }
          if (targetH <= CHUNK) {
            if (!canvasPass) {
              data = await captureClip({ x: 0, y: 0, width, height: targetH });
            } else {
              const out = await composeChunks(
                width,
                targetH,
                [{ y: 0, data: await captureClip({ x: 0, y: 0, width, height: targetH }, true) }],
                enc,
              );
              data = out.data;
              outSize = { width: out.width, height: out.height };
            }
          } else {
            const chunks: Array<{ y: number; data: string }> = [];
            for (let y = 0; y < targetH; y += CHUNK) {
              const h = Math.min(CHUNK, targetH - y);
              // Always lossless per chunk — the stitch below encodes once.
              chunks.push({ y, data: await captureClip({ x: 0, y, width, height: h }, true) });
            }
            try {
              const out = await composeChunks(width, targetH, chunks, enc);
              data = out.data;
              outSize = { width: out.width, height: out.height };
            } catch (e) {
              // Canvas too big / OOM → degrade to the largest single shot (not
              // just the first chunk) so we never do worse than un-stitched. Cap
              // at CHUNK, not 16000: CHUNK is the safe single-capture height; a
              // taller clip can itself exceed the GPU limit and return no data,
              // failing the degrade path on exactly the oversized pages it rescues.
              const safeH = Math.min(targetH, CHUNK);
              data = await captureClip({ x: 0, y: 0, width, height: safeH });
              capNote = `Page ${fullH}px too tall, stitching failed, captured only the first ${safeH}px: ${
                e instanceof Error ? e.message : String(e)
              }`;
            }
          }
        }
      }
      return {
        dataUrl: `data:image/${enc.format};base64,${data}`,
        bytes: data.length,
        format: enc.format,
        ...(enc.quality !== undefined ? { quality: enc.quality } : {}),
        ...(outSize ? { image_size: outSize } : {}),
        url: pageUrl,
        // url mode closes its throwaway tab in `finally` — reporting its id would
        // invite a follow-up click/scroll on a dead tab ("tab N no longer exists").
        // Same rule as get_page_text: closed ⇒ say closed, don't hand back an id.
        ...(ownTab ? { tab_closed: true } : { tab_id: tabId }),
        full_page: fullPage,
        ...(elementClip && clipTarget ? { element: clipTarget.label, clip: elementClip } : {}),
        ...(contentSize ? { content_size: contentSize } : {}),
        ...(capNote ? { cap_note: capNote } : {}),
        wait: ready,
      };
    } finally {
      if (attached && ownsAttachment) {
        try {
          await chrome.debugger.detach(target);
        } catch {}
      }
      if (ownTab) {
        try {
          await chrome.tabs.remove(tabId);
        } catch {}
      }
    }
  },
});
