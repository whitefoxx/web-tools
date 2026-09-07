// @vitest-environment jsdom
/**
 * The receipt a capture leaves on the page (docs/localmd-connect.md §14.4j).
 * Wording is pure and lives in one place; the injected half is checked for the
 * two things that are easy to get wrong — replacing rather than stacking, and
 * treating empty text as "take it away".
 */
import { describe, it, expect, vi } from 'vitest';

const { showToast, toastCopy } = await import('../src/localmd-connect/page-toast');

/** showToast hands the injected function to executeScript; capture it there
 *  and run it against jsdom, which is what the page would do. */
let injected: ((text: string, kind: string) => void) | null = null;
vi.stubGlobal('chrome', {
  runtime: { getManifest: () => ({ name: 't' }) },
  scripting: {
    executeScript: async ({
      func,
      args,
    }: {
      func: (t: string, k: string) => void;
      args: [string, string];
    }) => {
      injected = func;
      func(...args);
      return [];
    },
  },
});

describe('toastCopy', () => {
  it('says what is happening while it happens, then how it went', () => {
    const clip = toastCopy('clip_page');
    expect(clip.working).toMatch(/Clipping/);
    expect(clip.done()).toMatch(/Clipped/);
  });

  it('says the whole-page capture is running, since it takes a while', () => {
    const page = toastCopy('screenshot_page');
    expect(page.working).toMatch(/whole page/);
    expect(page.done()).toMatch(/Full-page/);
  });

  it('gives the region capture no working toast — its overlay is one', () => {
    expect(toastCopy('screenshot_region').working).toBeNull();
    expect(toastCopy('screenshot_region').done()).toMatch(/Screenshot/);
  });

  it('has an answer for a gesture it does not know', () => {
    expect(toastCopy('nonsense').done()).toBe('Sent to localmd');
  });
});

describe('the toast on the page', () => {
  const el = (): HTMLElement | null => document.getElementById('__localmd_toast__');

  it('appears with the text it was given', async () => {
    document.documentElement.innerHTML = '<body></body>';
    await showToast(1, 'Clipping this page…', 'working');
    expect(el()?.textContent).toContain('Clipping this page…');
    expect(injected).toBeTypeOf('function');
  });

  it('REPLACES the working toast rather than stacking a second one', async () => {
    await showToast(1, 'Clipping this page…', 'working');
    await showToast(1, 'Clipped to localmd', 'ok');
    expect(document.querySelectorAll('#__localmd_toast__')).toHaveLength(1);
    expect(el()?.textContent).toContain('Clipped to localmd');
  });

  it('empty text takes it away and says nothing — a cancelled capture', async () => {
    await showToast(1, 'Clipping this page…', 'working');
    await showToast(1, '', 'ok');
    expect(el()).toBeNull();
  });

  it('draws a breathing frame while working and takes it away when done', async () => {
    document.documentElement.innerHTML = '<body></body>';
    await showToast(1, 'Clipping…', 'working');
    const frame = () => document.getElementById('__localmd_frame__');
    expect(frame(), 'a working capture should be visible on the whole window').toBeTruthy();
    await showToast(1, 'Clipped', 'ok');
    expect(frame(), 'the frame must not outlive the work').toBeNull();
  });

  it('takes the frame away on a cancel too, even with nothing to say', async () => {
    await showToast(1, 'Clipping…', 'working');
    await showToast(1, '', 'ok');
    expect(document.getElementById('__localmd_frame__')).toBeNull();
  });

  it('sits at the bottom CENTRE, not in a corner other pages already use', async () => {
    await showToast(1, 'Clipped', 'ok');
    const css = document.getElementById('__localmd_toast__')!.style.cssText;
    expect(css).toContain('left: 50%');
    expect(css).not.toContain('right:');
  });

  it('is silent on a page it cannot inject into', async () => {
    const boom = { ...(globalThis as { chrome: unknown }).chrome } as {
      scripting: { executeScript: () => Promise<unknown> };
    };
    boom.scripting = {
      executeScript: () => Promise.reject(new Error('Cannot access contents of the page')),
    };
    vi.stubGlobal('chrome', boom);
    await expect(showToast(1, 'x', 'ok')).resolves.toBeUndefined();
  });
});
