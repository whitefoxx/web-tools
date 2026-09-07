/**
 * A line of feedback on the page the user is looking at.
 *
 * The context menu and the keyboard shortcuts had none: you pressed "Clip page
 * to localmd" and the page did not move, which is the intended behaviour —
 * capturing should not yank you away from what you are reading — but with no
 * receipt it is indistinguishable from nothing having happened. (It was
 * reported exactly that way, twice, for captures that had in fact succeeded.)
 *
 * Injected per call with `chrome.scripting.executeScript` rather than sent to
 * the highlighter's content script: that script can be switched off or
 * blacklisted for the site, and a receipt that is missing on some pages is
 * worse than none — it teaches the user to distrust it everywhere.
 *
 * Two calls per gesture: one to say it started, one to say how it went. The
 * second replaces the first, because they are the same statement at two points
 * in time and two stacked toasts would read as two captures. A working call
 * also draws a breathing gradient border around the viewport: a line of text at
 * the bottom is easy to miss on a busy page, a window that changes state is not.
 */

export type ToastKind = 'working' | 'ok' | 'error';

/** Self-contained (executeScript serializes it): no imports, no outer refs. */
function showToastInPage(text: string, kind: string): void {
  const ID = '__localmd_toast__';
  const FRAME = '__localmd_frame__';
  document.getElementById(ID)?.remove();

  // A breathing gradient border around the viewport while work is in flight.
  // A line of text at the bottom is easy to miss on a busy page; the whole
  // window changing state is not, and it stops the moment the work does.
  const frame = document.getElementById(FRAME);
  if (kind === 'working') {
    if (!frame) {
      const f = document.createElement('div');
      f.id = FRAME;
      f.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483646',
        'pointer-events:none',
        'border-radius:10px',
        'padding:3px',
        'background:linear-gradient(120deg,#2563eb,#22d3ee,#a855f7,#2563eb)',
        'background-size:300% 300%',
        '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0)',
        '-webkit-mask-composite:xor',
        'mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0)',
        'mask-composite:exclude',
        'animation:__localmd_flow 3s ease infinite,__localmd_breathe 1.8s ease-in-out infinite',
      ].join(';');
      const st = document.createElement('style');
      st.textContent =
        '@keyframes __localmd_flow{0%{background-position:0% 50%}50%{background-position:100% 50%}' +
        '100%{background-position:0% 50%}}' +
        '@keyframes __localmd_breathe{0%,100%{opacity:.45}50%{opacity:1}}';
      f.appendChild(st);
      document.documentElement.appendChild(f);
    }
  } else if (frame) {
    frame.remove();
  }

  // Empty text means "take it away and say nothing" — a cancelled capture.
  if (!text) return;

  const el = document.createElement('div');
  el.id = ID;
  const bg = kind === 'error' ? '#b42318' : '#23272e';
  el.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    // Bottom CENTRE: the corner competes with chat widgets, cookie bars and
    // back-to-top buttons, which is where most pages already put things.
    'left:50%',
    'bottom:24px',
    'transform:translate(-50%,8px)',
    'max-width:min(420px,calc(100vw - 32px))',
    `background:${bg}`,
    'color:#e8eaed',
    'font:13px/1.45 -apple-system,"Segoe UI",Roboto,"PingFang SC",sans-serif',
    'padding:10px 15px',
    'border-radius:999px',
    'box-shadow:0 8px 28px rgba(0,0,0,.34)',
    'pointer-events:none',
    'opacity:0',
    'transition:opacity .15s ease,transform .15s ease',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis',
  ].join(';');
  if (kind === 'working') {
    const spin = document.createElement('span');
    spin.style.cssText =
      'display:inline-block;width:11px;height:11px;margin-right:8px;vertical-align:-1px;' +
      'border:2px solid rgba(255,255,255,.28);border-top-color:#e8eaed;border-radius:50%;' +
      'animation:__localmd_spin .8s linear infinite;';
    const style = document.createElement('style');
    style.textContent = '@keyframes __localmd_spin{to{transform:rotate(360deg)}}';
    el.append(style, spin);
  }
  el.append(document.createTextNode(text));
  document.documentElement.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translate(-50%,0)';
  });
  if (kind === 'working') return;
  const life = kind === 'error' ? 6000 : 2600;
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%,8px)';
    setTimeout(() => el.remove(), 200);
  }, life);
}

/** In-page: hide (or restore) our own overlay. A style rule rather than
 *  removing the nodes, so the toast and the frame come back exactly as they
 *  were, mid-animation and all. */
function setCaptureUiHiddenInPage(hidden: boolean): void {
  const ID = '__localmd_hide_ui__';
  const existing = document.getElementById(ID);
  if (!hidden) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const st = document.createElement('style');
  st.id = ID;
  st.textContent = '#__localmd_toast__,#__localmd_frame__{display:none!important}';
  document.documentElement.appendChild(st);
}

/**
 * Take our own receipt out of the picture while the page is being captured.
 *
 * The working toast and the breathing frame are drawn INTO the page, so a
 * full-page screenshot photographs them — the user gets an image of their page
 * with our progress indicator baked into it, which is both wrong and a little
 * absurd. The frame's animation is also one more thing repainting while the
 * capture scrolls and stitches, which is part of why the screen flickers.
 */
export async function setCaptureUiHidden(tabId: number, hidden: boolean): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: setCaptureUiHiddenInPage,
      args: [hidden],
    });
  } catch {
    /* not injectable — there is no overlay there to hide either */
  }
}

/** Best-effort: a page we cannot inject into (a PDF viewer, a chrome:// tab)
 *  simply gets no toast — never an error of its own. */
export async function showToast(tabId: number, text: string, kind: ToastKind): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showToastInPage,
      args: [text, kind],
    });
  } catch {
    /* not injectable — the popup and the badge are the other receipts */
  }
}

/** What a gesture says while it runs, and what it says when it worked. Pure, so
 *  the wording is testable and lives in one place. */
export function toastCopy(action: string): {
  working: string | null;
  done: (n?: number) => string;
} {
  switch (action) {
    case 'clip_page':
      return { working: 'Clipping this page…', done: () => 'Clipped to localmd' };
    case 'clip_selection':
      return { working: 'Clipping the selection…', done: () => 'Clipped to localmd' };
    case 'screenshot_page':
      return { working: 'Capturing the whole page…', done: () => 'Full-page screenshot sent' };
    case 'screenshot_region':
      // The overlay is its own "working" state; a toast under it would be noise.
      return { working: null, done: () => 'Screenshot sent to localmd' };
    case 'ask_page':
    case 'ask_selection':
      return { working: null, done: () => 'Opening localmd…' };
    default:
      return { working: null, done: () => 'Sent to localmd' };
  }
}
