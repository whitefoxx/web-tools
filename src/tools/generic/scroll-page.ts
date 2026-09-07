import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep, parseFrameRef } from './_helpers';

cli({
  site: 'generic',
  name: 'scroll_page',
  access: 'read',
  description:
    'Simulate human scrolling on an **already-open** tab (each scroll is a random 70%-100% of a viewport height, with jitter between them). Commonly used to trigger lazy-loading / infinite-scroll feeds to load more content. Scrolls the **window** by default; pass `ref`/`selector` to scroll an **inner scrollable container** (chat message list / side panel / popup, etc. — see the `scrollables` field returned by get_interactives). Use with the tab_id obtained from `open_url`',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help:
        'Target tab id — from open_url, or from get_page_text {url, keep_open:true} (which reads the page AND leaves it open). Never make one up, and never reuse an id from a result that said tab_closed:true',
    },
    {
      name: 'times',
      type: 'int',
      help: 'Number of scrolls. Default 3, cap 30',
    },
    {
      name: 'direction',
      type: 'string',
      help: '`down` (default) / `up` / `top` / `bottom`. down/up scroll relatively, top/bottom jump absolutely to the start/end',
    },
    {
      name: 'delay_ms',
      type: 'int',
      help: 'Wait in ms after each scroll. Default jitters within [800,1500]; 0 means no wait',
    },
    {
      name: 'ref',
      type: 'string',
      help: 'Scroll an **inner scrollable container** instead of the window: pass the `scrollables[].ref` returned by get_interactives. Use this for inner-scroll UI like chat message lists / side panels / popups',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'CSS selector, same effect as ref (scrolls that element or its nearest scrollable ancestor). Use either ref or selector; if neither is given, scrolls the window',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const times = Math.max(1, Math.min(30, Math.floor(Number(kwargs.times ?? 3))));
    const direction = String(kwargs.direction ?? 'down').toLowerCase();
    if (!['down', 'up', 'top', 'bottom'].includes(direction)) {
      throw new Error(`direction must be one of down/up/top/bottom; got "${direction}"`);
    }
    const delaySpec = kwargs.delay_ms;
    const fixedDelay = delaySpec === undefined ? null : Math.max(0, Number(delaySpec));

    // Container mode: scroll a specific inner element (by ref from get_interactives,
    // or a CSS selector) instead of the window — needed for panels / chat message
    // lists that scroll internally, which window scroll can't move.
    const ref = typeof kwargs.ref === 'string' ? kwargs.ref : null;
    const selectorArg = typeof kwargs.selector === 'string' ? kwargs.selector : null;
    // A ref from get_interactives may be iframe-namespaced (f<fid>r<n>) — parse it
    // so we inject into the RIGHT frame and use the LOCAL ref for the selector
    // (mirrors click.ts / type-into.ts; else an iframe scrollable's documented ref
    // fails with "scroll target not found").
    const parsed = ref ? parseFrameRef(ref) : null;
    const containerSelector = parsed
      ? `[data-web-ref="${parsed.localRef}"]`
      : selectorArg;
    if (containerSelector) {
      let last:
        | {
            found: boolean;
            scrollable?: boolean;
            container?: string;
            before?: number;
            after?: number;
            max?: number;
            at_top?: boolean;
            at_bottom?: boolean;
          }
        | undefined;
      for (let i = 0; i < times; i++) {
        const res = await chrome.scripting.executeScript({
          target: parsed?.frameId ? { tabId, frameIds: [parsed.frameId] } : { tabId },
          func: (sel: string, dir: string) => {
            const start = document.querySelector(sel) as HTMLElement | null;
            if (!start) return { found: false };
            // Walk up to the nearest vertically-scrollable ancestor — the ref may
            // point at an element INSIDE the scroll area, not the scroller itself.
            let node: HTMLElement | null = start;
            let target: HTMLElement | null = null;
            for (let k = 0; node && k < 20; k++) {
              const cs = window.getComputedStyle(node);
              const canY =
                (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                node.scrollHeight - node.clientHeight > 4;
              if (canY) {
                target = node;
                break;
              }
              if (node === document.body || node === document.documentElement) break;
              node = node.parentElement;
            }
            if (!target) return { found: true, scrollable: false };
            const before = target.scrollTop;
            const max = target.scrollHeight - target.clientHeight;
            const vh = target.clientHeight;
            if (dir === 'top') target.scrollTop = 0;
            else if (dir === 'bottom') target.scrollTop = max;
            else
              target.scrollTop =
                before + (dir === 'up' ? -1 : 1) * vh * (0.7 + Math.random() * 0.3);
            const after = target.scrollTop; // instant (no smooth) → accurate readback
            return {
              found: true,
              scrollable: true,
              container: target.tagName.toLowerCase(),
              before,
              after,
              max,
              at_top: after <= 1,
              at_bottom: after >= max - 4,
            };
          },
          args: [containerSelector, direction],
        });
        last = res[0]?.result;
        if (!last?.found) {
          throw new Error(
            `scroll target not found for ${ref ? `ref=${ref}` : `selector="${selectorArg}"`}. ` +
              `Re-run get_interactives for fresh refs, or omit ref/selector to scroll the window.`,
          );
        }
        if (last.scrollable === false) {
          return {
            tabId,
            container_scroll: false,
            note: 'element found but has no scrollable ancestor; omit ref/selector to scroll the page window instead.',
          };
        }
        const atEnd =
          (direction === 'down' && last.at_bottom) || (direction === 'up' && last.at_top);
        const wait = fixedDelay ?? (atEnd ? 800 : 800 + Math.floor(Math.random() * 700));
        if (wait > 0) await sleep(wait);
        if (atEnd) break;
      }
      return { tabId, direction, container_scroll: true, ...last };
    }

    const steps: Array<{ before: number; after: number; height: number }> = [];
    for (let i = 0; i < times; i++) {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (dir: string) => {
          const before = window.scrollY;
          const height = Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight ?? 0,
          );
          const vh = window.innerHeight;
          // Instant ('auto'), NOT 'smooth': smooth scrolling is driven by rAF, which
          // Chrome PAUSES in background tabs — so a smooth scroll on a tab opened with
          // active:false (the agent's common case) silently never moves. Instant works
          // regardless and makes the immediate scrollY read-back accurate. The human-ish
          // stride + jittered delays already provide the anti-bot realism.
          if (dir === 'top') {
            window.scrollTo({ top: 0, behavior: 'auto' });
          } else if (dir === 'bottom') {
            window.scrollTo({ top: height, behavior: 'auto' });
          } else {
            // Random fraction of viewport in [0.7, 1.0] for human-ish stride.
            const step = vh * (0.7 + Math.random() * 0.3);
            window.scrollBy({ top: dir === 'up' ? -step : step, behavior: 'auto' });
          }
          return { before, after: window.scrollY, height };
        },
        args: [direction],
      });
      const step = res[0]?.result;
      if (step) steps.push(step);
      if (i < times - 1) {
        const wait = fixedDelay ?? 800 + Math.floor(Math.random() * 700);
        if (wait > 0) await sleep(wait);
      } else {
        // Always pause a beat after the LAST scroll so lazy-load XHRs can settle.
        await sleep(fixedDelay ?? 800);
      }
    }

    const probe = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        scrollY: window.scrollY,
        pageHeight: Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
        ),
        viewport: window.innerHeight,
        atBottom: window.scrollY + window.innerHeight + 4 >= document.documentElement.scrollHeight,
      }),
    });
    return {
      tabId,
      direction,
      scrolls_performed: steps.length,
      ...(probe[0]?.result ?? {}),
    };
  },
});
