/**
 * A region screenshot from the service worker: run the in-page selector, grab
 * the visible tab, crop to the rectangle and composite the annotation — with an
 * OffscreenCanvas, since a worker has no DOM. Same decode-draw-encode pattern
 * `composeChunks` in tools/generic/screenshot.ts uses for stitched pages.
 *
 * The product is a data URL for the capture inbox (kind `screenshot`), which
 * localmd writes into the folder like any other picture the user hands it.
 * The in-page toolbar's ⬇ means "download instead": honoured here through
 * chrome.downloads, which this shell already holds.
 */
import { selectAndAnnotateInPage, type CaptureResult } from '../capture/region-select';
import { lookupAdapter } from '../tools/manifest';
import { setCaptureUiHidden } from './page-toast';

export interface RegionShot {
  dataUrl: string;
  width: number;
  height: number;
  format: 'png' | 'webp';
}

/**
 * How a whole page is encoded. WebP, not PNG: a stitched page is the one
 * capture that is big by construction, and PNG made an ordinary article 8.8MB
 * — three of those in the inbox exceeded what one relay frame can carry and
 * stalled every capture behind them (findings F-59). The screenshot tool
 * measured webp at ~0.4x of png on flat UI and photo pages alike; at this
 * quality small text stays legible. Region captures stay PNG: they are small
 * and the user may be cropping fine print.
 */
export const FULL_PAGE_FORMAT = 'webp' as const;
export const FULL_PAGE_QUALITY = 85;

async function bitmapFromDataUrl(dataUrl: string): Promise<ImageBitmap> {
  const comma = dataUrl.indexOf(',');
  const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

function base64Of(buf: Uint8Array): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(bin);
}

/** Crop the full-tab PNG to the rect and draw the annotation over it. */
export async function compositeRegionInWorker(
  fullPng: string,
  r: CaptureResult,
): Promise<RegionShot> {
  const cw = Math.max(1, Math.round(r.w * r.dpr));
  const ch = Math.max(1, Math.round(r.h * r.dpr));
  const page = await bitmapFromDataUrl(fullPng);
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(page, r.x * r.dpr, r.y * r.dpr, cw, ch, 0, 0, cw, ch);
  page.close();
  if (r.annotation) {
    try {
      const ann = await bitmapFromDataUrl(r.annotation);
      ctx.drawImage(ann, 0, 0, cw, ch);
      ann.close();
    } catch {
      /* an undecodable annotation layer loses the drawing, not the shot */
    }
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const data = base64Of(new Uint8Array(await blob.arrayBuffer()));
  return { dataUrl: `data:image/png;base64,${data}`, width: cw, height: ch, format: 'png' };
}

/**
 * The whole page, scrolled and stitched — the `screenshot { full_page: true }`
 * tool, called directly.
 *
 * Directly, rather than through the tool executor, for two reasons: the
 * executor paces every non-`local` call by a couple of seconds to look human to
 * a SITE, and there is no site being fooled when the user pressed a button; and
 * the capture path (CDP, viewport normalisation, 12000px chunks, OffscreenCanvas
 * stitching, the F-36 tiling fix) is worth reusing rather than reimplementing.
 */
export async function captureFullPageOnTab(tabId: number): Promise<RegionShot> {
  const adapter = lookupAdapter('generic__screenshot');
  if (!adapter) throw new Error('the screenshot tool is not registered');
  // Our own progress overlay is drawn INTO the page, so the capture would
  // photograph it. Hidden for the duration and restored afterwards, whatever
  // happens.
  await setCaptureUiHidden(tabId, true);
  let out: { dataUrl?: string; image_size?: { width: number; height: number } };
  try {
    out = (await adapter.func(null, {
      tab_id: tabId,
      full_page: true,
      format: FULL_PAGE_FORMAT,
      quality: FULL_PAGE_QUALITY,
    })) as { dataUrl?: string; image_size?: { width: number; height: number } };
  } finally {
    await setCaptureUiHidden(tabId, false);
  }
  if (!out?.dataUrl) throw new Error('the capture returned no image');
  return {
    dataUrl: out.dataUrl,
    width: out.image_size?.width ?? 0,
    height: out.image_size?.height ?? 0,
    format: FULL_PAGE_FORMAT,
  };
}

/**
 * Run the whole thing on a tab. Resolves null when the user cancelled, or
 * chose ⬇ (then the file was downloaded and there is nothing to hand on).
 */
export async function captureRegionOnTab(tab: chrome.tabs.Tab): Promise<RegionShot | null> {
  if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') return null;
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: selectAndAnnotateInPage,
  });
  const r = res?.result as CaptureResult | null | undefined;
  if (!r) return null;
  // Same reason as the full-page path: a toast left over from an earlier
  // gesture would end up inside the crop.
  await setCaptureUiHidden(tab.id, true);
  let full: string;
  try {
    full = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    await setCaptureUiHidden(tab.id, false);
  }
  const shot = await compositeRegionInWorker(full, r);
  if (r.download) {
    await chrome.downloads.download({
      url: shot.dataUrl,
      filename: `screenshot-${Date.now()}.png`,
    });
    return null;
  }
  return shot;
}
