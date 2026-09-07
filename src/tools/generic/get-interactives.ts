import { cli } from '../../runtime/registry.js';
import { assertTabId, frameRef } from './_helpers';

/** Cap on items returned per category — keeps the model's prompt size
 * sane on dense pages (a Twitter feed has hundreds of clickable elements
 * but the model only needs the top of the viewport). */
const MAX_PER_CATEGORY = 60;

/**
 * D2-lite change-observation (browseract-comparison ⑰). Remember the last
 * interactive-element signature set per tab so a follow-up scan can mark what
 * **appeared since the previous scan on the same page** with `new: true` — the
 * agent's action (click a menu, open a dialog) surfaces new controls and it can
 * focus those instead of re-reading the whole list. Reset to a fresh baseline
 * when the URL changes (a navigation makes everything "new" — that's noise, not
 * a delta). Cheap first stage of a full change-diff engine (D2).
 */
const lastInteractives = new Map<number, { url: string; sigs: Set<string> }>();
const NEW_DIFF_CATS = ['buttons', 'links', 'inputs', 'selects', 'editable', 'clickables'] as const;

/** Signature identifying an element across scans — everything but the volatile
 * per-scan `ref`. Pure. */
function recSig(cat: string, rec: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) if (k !== 'ref') rest[k] = rec[k];
  return cat + '|' + JSON.stringify(rest);
}

/** Mutate the scan result `r`: mark records whose signature isn't in `prevSigs`
 * with `new: true`. Returns the current signature set + the newly-seen count.
 * `prevSigs === null` (first scan / after navigation) establishes a baseline —
 * nothing is marked. Pure aside from the intended mutation. Unit-tested. */
export function applyNewFlags(
  r: Record<string, unknown>,
  prevSigs: Set<string> | null,
): { sigs: Set<string>; newCount: number } {
  const sigs = new Set<string>();
  let newCount = 0;
  for (const cat of NEW_DIFF_CATS) {
    const arr = r[cat];
    if (!Array.isArray(arr)) continue;
    for (const rec of arr) {
      if (!rec || typeof rec !== 'object') continue;
      const sig = recSig(cat, rec as Record<string, unknown>);
      sigs.add(sig);
      if (prevSigs && !prevSigs.has(sig)) {
        (rec as Record<string, unknown>).new = true;
        newCount++;
      }
    }
  }
  return { sigs, newCount };
}

/** All categories collectInteractives returns (buttons…scrollables). */
const ALL_CATS = [
  'buttons',
  'links',
  'inputs',
  'selects',
  'editable',
  'clickables',
  'scrollables',
] as const;

/** ⑨ Namespace the refs inside a sub-frame's tree text (`[r3]` → `[f5r3]`), the
 * text twin of mergeFrameResults' per-record `frameRef`. Anchored to line starts
 * (after indent tabs + the optional `*` new-marker) so a literal "[r3]" occurring
 * mid-text on the page can never be rewritten. Pure; unit-tested. */
export function namespaceTreeRefs(tree: string, frameId: number): string {
  if (!frameId) return tree;
  return tree.replace(/^(\t*\*?)\[(r[0-9a-z]+)\]/gm, (_m, pre, ref) => `${pre}[f${frameId}${ref}]`);
}

/** ⑨ Prefix `*` onto tree lines whose element appeared since the last scan — the
 * text twin of the flat lists' `new:true` (browser-use's `*[35]` marker). Runs
 * after frame merging, so refs may carry an `f<id>` prefix. Pure; unit-tested. */
export function starNewRefsInTree(tree: string, newRefs: ReadonlySet<string>): string {
  if (!newRefs.size) return tree;
  return tree.replace(/^(\t*)\[((?:f\d+)?r[0-9a-z]+)\]/gm, (m, pre, ref) =>
    newRefs.has(ref) ? `${pre}*[${ref}]` : m,
  );
}

/**
 * Merge the per-frame scan results from an `allFrames` injection into one flat
 * result (iframe blind-spot fix). Elements from a sub-frame get their `ref`
 * namespaced (`f<frameId><localRef>`) + a `frame` field so the action tools can
 * inject into the right frame; the top frame's scroll/highlight is kept as the
 * page-level one; a `frames` summary lists the sub-frames that contributed.
 * Pure; unit-tested. `results` is chrome.scripting's InjectionResult[].
 */
export function mergeFrameResults(
  results: Array<{ frameId?: number; result?: unknown }>,
  cap?: number,
): Record<string, unknown> {
  const merged: Record<string, unknown[]> = {};
  for (const c of ALL_CATS) merged[c] = [];
  const frames: Array<{ frameId: number; url: string }> = [];
  let scroll: unknown;
  let highlighted = false;
  let topTree: string | undefined;
  const subTrees: string[] = [];
  for (const res of results) {
    const r = res.result as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') continue;
    const fid = res.frameId ?? 0;
    const frameUrl = typeof r.frameUrl === 'string' ? r.frameUrl : '';
    if (fid === 0) {
      scroll = r.scroll;
      highlighted = !!r.highlighted;
      if (typeof r.tree === 'string') topTree = r.tree;
    } else {
      frames.push({ frameId: fid, url: frameUrl });
      // ⑨ a sub-frame's tree is appended under a header with its refs namespaced,
      // mirroring how its flat records get f<id>-prefixed refs below.
      if (typeof r.tree === 'string' && r.tree) {
        subTrees.push(`--- iframe f${fid}: ${frameUrl} ---\n${namespaceTreeRefs(r.tree, fid)}`);
      }
    }
    for (const c of ALL_CATS) {
      const arr = r[c];
      if (!Array.isArray(arr)) continue;
      for (const rec of arr) {
        if (fid !== 0 && rec && typeof rec === 'object') {
          const o = rec as Record<string, unknown>;
          o.ref = frameRef(fid, String(o.ref));
          o.frame = fid;
        }
        merged[c].push(rec);
      }
    }
  }
  // Global re-cap after merging frames: max_per_category is enforced PER FRAME,
  // so concatenating N frames yields up to cap×N per category — blowing the
  // prompt budget on pages with many (ad/embed) iframes. Re-slice to the cap.
  if (cap && cap > 0) {
    for (const c of ALL_CATS) if (merged[c].length > cap) merged[c] = merged[c].slice(0, cap);
  }
  const counts: Record<string, number> = {};
  for (const c of ALL_CATS) counts[c] = merged[c].length;
  const tree =
    topTree !== undefined || subTrees.length
      ? [...(topTree ? [topTree] : []), ...subTrees].join('\n')
      : undefined;
  return {
    counts,
    scroll,
    highlighted,
    ...merged,
    ...(frames.length ? { frames } : {}),
    ...(tree !== undefined ? { tree } : {}),
  };
}

cli({
  site: 'generic',
  name: 'get_interactives',
  access: 'read',
  description:
    'Scan all visible, interactive elements on an already-open tab (links / buttons / inputs / dropdowns / rich-text editors / custom clickables — modern components like div, span with cursor:pointer or a role/onclick/tabindex; includes elements inside open shadow DOM) and return a structured list grouped by category (elements covered by a popup / overlay are skipped automatically). Each element gets a temporary ref ID (written to the DOM as a `data-web-ref` attribute), which you can then use in the `click` / `type_into` tools to target it precisely. **On sites without an adapter, call this before doing navigation / form-filling / clicks**. A returned ref may become stale after the next major page change (navigation / SPA route change / large-scale DOM re-render); when unsure, just call it again. The result also carries a `scroll` field (current scroll position, how many pixels / screens remain above and below, whether at top/bottom) to help decide whether to `scroll_page` first and scan again. **When scanning the same page again**, elements that appeared since the last scan carry `new:true` (top level also has `new_count`) — do one action (open a menu / popup) then scan again, and you can focus straight on the newly appeared controls without re-reading the whole list (navigating to a new URL resets the baseline, so those do not count as new). **Includes iframes**: elements inside embedded iframes (including cross-origin) are scanned too; their refs carry a frame prefix (e.g. `f5r3`) and a `frame` field marking which frame they came from (top level also has `frames` listing each frame URL); passing such a ref to click / type_into automatically targets the operation inside the matching iframe. **For complex forms / ERP, CRM back-ends / structure-dense pages, prefer `format:"tree"`**: switches to a hierarchical text view (indent = nesting, `[ref]<tag attrs>text />`, ordinary text interleaved), which reveals which caption/label sits next to which input and which control belongs to which section — use it when a flat list cannot tell 20 identical-looking inputs apart',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help:
        'Target tab id — from open_url, or from get_page_text {url, keep_open:true}',
    },
    {
      name: 'max_per_category',
      type: 'int',
      help: `Max elements to return per category (default ${MAX_PER_CATEGORY}). On dense pages, lower it to 20-30 to save tokens`,
    },
    {
      name: 'only_in_viewport',
      type: 'bool',
      help: 'Return only elements visible within the current viewport (default false, returns all display-visible ones). Pair with scroll_page to scan in batches',
    },
    {
      name: 'highlight',
      type: 'bool',
      help: 'Mark the detected interactive elements on the page with colored numbered boxes (Set-of-Mark — the number in the box is that element\'s ref). A watching user can see what you are looking at; a later screenshot call then gives an annotated screenshot (usable by a vision model). **On by default**; pass false explicitly to turn off. The boxes are pointer-events:none so they do not block operations, and clear automatically on page scroll / next scan / after 60 seconds',
    },
    {
      name: 'format',
      type: 'string',
      help: "Output format: 'flat' (default, a flat list grouped by category) or 'tree' (hierarchical text view: indent = nested under which interactive element, `[ref]<tag attrs>text />`, with ordinary page text interleaved; elements that appeared since the last scan get a leading * on their line). tree preserves layout structure — which label sits next to which input, which control belongs to which section — so it has a higher success rate on complex forms / back-end systems; ref usage is identical to flat",
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const cap = Math.max(5, Math.min(200, Number(kwargs.max_per_category ?? MAX_PER_CATEGORY)));
    const onlyInViewport = !!kwargs.only_in_viewport;
    // B(§4.2): marks are ALWAYS on while operating (user decision — not a
    // setting); an explicit highlight arg still wins.
    const highlight = kwargs.highlight === undefined ? true : !!kwargs.highlight;
    const wantTree = kwargs.format === 'tree';

    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: collectInteractives,
      args: [cap, onlyInViewport, highlight, wantTree],
    });
    if (!results.length) throw new Error('executeScript returned no result');
    // Merge the top frame + every iframe (allFrames) into one flat result;
    // iframe refs are namespaced (f<frameId>…) so click / type_into can reach
    // into the right frame. Without this, iframe content is a Tier-A blind spot.
    const r = mergeFrameResults(results, cap);
    // ⑰ D2-lite: mark elements new since the last scan on this same URL.
    const url = tab.url ?? '';
    const prev = lastInteractives.get(tabId);
    const prevSigs = prev && prev.url === url ? prev.sigs : null;
    const { sigs, newCount } = applyNewFlags(r, prevSigs);
    lastInteractives.set(tabId, { url, sigs });
    if (lastInteractives.size > 30) {
      const oldest = lastInteractives.keys().next().value;
      if (oldest !== undefined) lastInteractives.delete(oldest);
    }
    // ⑨ tree mode: the flat scans still ran (they tag elements with refs and
    // feed the new-diff baseline), but the model gets ONLY the hierarchical text
    // — returning both would double the prompt cost for no information gain.
    // The flat records' `new:true` flags become `*[ref]` line markers.
    if (wantTree) {
      const newRefs = new Set<string>();
      for (const cat of NEW_DIFF_CATS) {
        const arr = r[cat];
        if (!Array.isArray(arr)) continue;
        for (const rec of arr) {
          const o = rec as Record<string, unknown>;
          if (o && o.new === true && typeof o.ref === 'string') newRefs.add(o.ref);
        }
      }
      return {
        tabId,
        url,
        title: tab.title ?? '',
        ...(prevSigs ? { new_count: newCount } : {}),
        format: 'tree',
        counts: r.counts,
        scroll: r.scroll,
        ...(r.frames ? { frames: r.frames } : {}),
        tree: starNewRefsInTree(typeof r.tree === 'string' ? r.tree : '', newRefs),
      };
    }
    return {
      tabId,
      url,
      title: tab.title ?? '',
      // Only meaningful once a baseline exists on this URL; `new:true` flags on
      // individual records point at what the last action surfaced.
      ...(prevSigs ? { new_count: newCount } : {}),
      ...r,
    };
  },
});

/** Runs in the page context. Stays self-contained (no imports). */
function collectInteractives(
  maxPerCategory: number,
  onlyInViewport: boolean,
  highlight: boolean,
  wantTree: boolean,
) {
  const ATTR = 'data-web-ref';
  const OVERLAY_ID = '__web-som-overlay';
  let counter = 0;
  const nextRef = () => `r${(++counter).toString(36)}`;

  // Open shadow roots, discovered once (bounded walk) so every scan below can
  // pierce them — querySelectorAll alone can't, which made web-component UIs
  // (lit / shreddit / design-system controls) invisible to perception AND action.
  const roots: Array<Document | ShadowRoot> = [document];
  {
    let walked = 0;
    for (let qi = 0; qi < roots.length && walked <= 8000; qi++) {
      const all = roots[qi].querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        if (++walked > 8000) break;
        const sr = (all[i] as HTMLElement).shadowRoot;
        if (sr) roots.push(sr);
      }
    }
  }
  const qsaDeep = (sel: string): Element[] => {
    const out: Element[] = [];
    for (const r of roots) r.querySelectorAll(sel).forEach((e) => out.push(e));
    return out;
  };
  // Composed-aware point test: elementFromPoint stops at a shadow HOST (descend
  // via shadowRoot.elementFromPoint), and contains() can't cross shadow
  // boundaries (walk parentNode / ShadowRoot.host) — without these, every
  // shadow element would read as "occluded by its host" and get dropped.
  const deepTop = (x: number, y: number): Element | null => {
    // elementsFromPoint + skip our own [data-wa-mask] overlay — an armed
    // interception mask (pointer-events:auto) would otherwise read as "covering
    // everything" and the occlusion filter would drop the whole page. Pure
    // read; see click.ts deepElementFromPoint for the same convention.
    const pick = (root: Document | ShadowRoot): Element | null => {
      if (typeof root.elementsFromPoint !== 'function') return root.elementFromPoint(x, y);
      const stack = root.elementsFromPoint(x, y);
      for (const e of stack) if (!e.closest('[data-wa-mask]')) return e;
      return null;
    };
    let cur = pick(document);
    let guard = 0;
    while (cur && (cur as HTMLElement).shadowRoot && ++guard < 20) {
      const inner = pick((cur as HTMLElement).shadowRoot!);
      if (!inner || inner === cur) break;
      cur = inner;
    }
    return cur;
  };
  const composedWithin = (node: Element, ancestor: Element): boolean => {
    let n: Node | null = node;
    while (n) {
      if (n === ancestor) return true;
      n = n instanceof ShadowRoot ? n.host : n.parentNode;
    }
    return false;
  };

  // Strip any stale refs from a previous call so the new ref numbering is
  // fresh and old refs don't keep referring to detached / replaced nodes.
  qsaDeep(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
  document.getElementById(OVERLAY_ID)?.remove(); // clear a prior highlight overlay

  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  function isVisible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (onlyInViewport) {
      if (r.bottom < 0 || r.top > vpH || r.right < 0 || r.left > vpW) return false;
    } else {
      // Allow off-screen, just reject totally collapsed elements.
    }
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    // Occlusion (Set-of-Mark topmost test, H10-P1): skip elements a modal /
    // overlay / sticky bar covers. `elementFromPoint` respects pointer-events, so
    // decorative (pointer-events:none) overlays don't count. Sample the center +
    // 4 inset corners; an element is "on top" if any sample hits it (or its
    // child/ancestor). Fail-open: if NO sample point is testable (off-screen, or
    // unsupported as in jsdom) we keep the element — we only DROP when we
    // positively see a different element covering every testable point.
    if (typeof document.elementFromPoint === 'function') {
      const inset = 3;
      const pts: Array<[number, number]> = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + inset, r.top + inset],
        [r.right - inset, r.top + inset],
        [r.left + inset, r.bottom - inset],
        [r.right - inset, r.bottom - inset],
      ];
      let testable = false;
      for (const [x, y] of pts) {
        if (x < 0 || y < 0 || x > vpW || y > vpH) continue; // point not in viewport
        const top = deepTop(x, y);
        if (!top) continue;
        testable = true;
        if (top === el || composedWithin(top, el) || composedWithin(el, top)) return true;
      }
      if (testable) return false; // in viewport but every sample hit something else
    }
    return true;
  }

  function tag(el: Element): string {
    const ref = nextRef();
    el.setAttribute(ATTR, ref);
    return ref;
  }

  /** Set-of-Mark overlay (H10-P2): paint a numbered colored box over every tagged
   * element — a debug / authoring aid, and (with a follow-up screenshot) an
   * annotated image for vision models. pointer-events:none so it never blocks
   * interaction; auto-cleared on the next get_interactives call or after 60s. */
  function paintOverlay(): void {
    const palette = [
      '#e6194B',
      '#3cb44b',
      '#4363d8',
      '#f58231',
      '#911eb4',
      '#1f9e89',
      '#f032e6',
      '#9A6324',
      '#469990',
      '#800000',
    ];
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    let i = 0;
    qsaDeep(`[${ATTR}]`).forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      if (rect.bottom < 0 || rect.top > vpH || rect.right < 0 || rect.left > vpW) return;
      const color = palette[i++ % palette.length];
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;border:2px solid ${color};box-sizing:border-box;`;
      const label = document.createElement('span');
      label.textContent = el.getAttribute(ATTR) || '';
      label.style.cssText = `position:absolute;top:0;left:0;background:${color};color:#fff;font:bold 10px/1.4 monospace;padding:0 3px;white-space:nowrap;`;
      box.appendChild(label);
      overlay.appendChild(box);
    });
    document.documentElement.appendChild(overlay);
    setTimeout(() => document.getElementById(OVERLAY_ID)?.remove(), 60_000);
    // The boxes are position:fixed at scan-time rects — after a scroll they'd
    // hover over the WRONG elements. Misleading marks are worse than none:
    // drop the whole overlay on the first scroll (window or inner container).
    window.addEventListener('scroll', () => document.getElementById(OVERLAY_ID)?.remove(), {
      once: true,
      passive: true,
      capture: true, // inner-container scrolls don't bubble; capture sees them
    });
  }

  function trimText(s: string | null | undefined, max = 80): string {
    return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function findLabel(el: Element): string {
    // Scope id-based lookups to the element's own tree (a shadow root has its
    // own id namespace — document.getElementById can't see into it).
    const root = el.getRootNode() as Document | ShadowRoot;
    // <label for="id">
    const id = (el as HTMLElement).id;
    if (id) {
      const escaped = id.replace(/(["\\])/g, '\\$1');
      const lbl = root.querySelector(`label[for="${escaped}"]`);
      if (lbl) return trimText(lbl.textContent);
    }
    // Wrapping <label>...
    const wrap = el.closest('label');
    if (wrap) {
      // Strip child's own text so we don't double-count.
      const cloned = wrap.cloneNode(true) as HTMLElement;
      cloned.querySelectorAll('input, textarea, select').forEach((n) => n.remove());
      return trimText(cloned.textContent);
    }
    // aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const target = root.getElementById(labelledBy);
      if (target) return trimText(target.textContent);
    }
    return '';
  }

  const seen = new WeakSet<Element>();
  const buttons: Array<{ ref: string; text: string; tag: string; aria?: string }> = [];
  const links: Array<{ ref: string; text: string; href: string }> = [];
  const inputs: Array<{
    ref: string;
    type: string;
    label: string;
    placeholder?: string;
    value?: string;
    required?: boolean;
  }> = [];
  const selects: Array<{
    ref: string;
    label: string;
    options: Array<{ value: string; text: string }>;
  }> = [];
  const editable: Array<{ ref: string; label: string }> = [];

  // BUTTONS (real <button>, role=button, submit/button inputs).
  qsaDeep('button, [role="button"], input[type="submit"], input[type="button"]').forEach((el) => {
    if (buttons.length >= maxPerCategory) return;
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    const aria = el.getAttribute('aria-label') ?? undefined;
    const text =
      trimText(el.textContent) ||
      trimText(aria) ||
      trimText((el as HTMLInputElement).value) ||
      trimText(el.getAttribute('title'));
    if (!text) return;
    buttons.push({ ref: tag(el), text, tag: el.tagName.toLowerCase(), aria });
  });

  // LINKS (only those with href that look navigable).
  qsaDeep('a[href]').forEach((el) => {
    if (links.length >= maxPerCategory) return;
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    const text = trimText(el.textContent) || trimText(el.getAttribute('aria-label'));
    if (!text) return;
    const href = (el as HTMLAnchorElement).href;
    if (!href || href.startsWith('javascript:')) return;
    links.push({ ref: tag(el), text, href });
  });

  // INPUTS (text-ish) + TEXTAREA.
  qsaDeep('input, textarea').forEach((el) => {
    if (inputs.length >= maxPerCategory) return;
    if (seen.has(el) || !isVisible(el)) return;
    const tag0 = el.tagName.toLowerCase();
    const type =
      tag0 === 'textarea' ? 'textarea' : ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return;
    seen.add(el);
    const label =
      findLabel(el) ||
      trimText(el.getAttribute('aria-label')) ||
      trimText((el as HTMLInputElement).placeholder) ||
      trimText((el as HTMLInputElement).name);
    inputs.push({
      ref: tag(el),
      type,
      label,
      placeholder: (el as HTMLInputElement).placeholder || undefined,
      value: (el as HTMLInputElement).value
        ? trimText((el as HTMLInputElement).value, 60)
        : undefined,
      required: (el as HTMLInputElement).required || undefined,
    });
  });

  // SELECTS.
  qsaDeep('select').forEach((el) => {
    if (selects.length >= maxPerCategory) return;
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    const opts = Array.from((el as HTMLSelectElement).options)
      .slice(0, 50)
      .map((o) => ({ value: o.value, text: trimText(o.textContent, 60) }));
    selects.push({
      ref: tag(el),
      label: findLabel(el) || trimText(el.getAttribute('name')),
      options: opts,
    });
  });

  // CONTENTEDITABLE — many comment / chat / rich-text inputs use this.
  qsaDeep('[contenteditable=""], [contenteditable="true"]').forEach((el) => {
    if (editable.length >= maxPerCategory) return;
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    editable.push({
      ref: tag(el),
      label:
        trimText(el.getAttribute('aria-label')) ||
        trimText(el.getAttribute('data-placeholder')) ||
        trimText(el.getAttribute('placeholder')) ||
        '',
    });
  });

  // CUSTOM / ROLE-BASED CLICKABLES — the categories above only find native tags
  // (<button>, a[href], input/select/textarea), role=button and contenteditable.
  // Modern apps build controls from role-less <div>/<span> with a click handler,
  // ARIA roles (menuitem / tab / option …), or just `cursor: pointer` — all
  // invisible to a tag/role/href scan. Catch them via three signals browser-use
  // proved out (page-agent borrow): an interactive ARIA role, an explicit click
  // signal (onclick / non-negative tabindex), or a computed `cursor: pointer`.
  //
  // `cursor` INHERITS, so a clickable card makes every descendant compute pointer
  // too. To avoid one ref per nested node, the cursor signal only fires on the
  // element that INTRODUCES pointer (its parent isn't pointer) — the clickable
  // root — collapsing a pointer chain to a single ref. Known limit: deeply nested
  // pure-pointer controls with no own signal collapse to that outermost ancestor
  // (the same trade-off browser-use makes).
  const clickables: Array<{ ref: string; text: string; why: string }> = [];
  const CLICK_ROLES = new Set([
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'option',
    'radio',
    'checkbox',
    'switch',
    'treeitem',
    'gridcell',
    'link',
  ]);
  const cursorOf = (el: Element): string => {
    try {
      return window.getComputedStyle(el).cursor;
    } catch {
      return '';
    }
  };
  // A "distinct interaction" carries its OWN click signal, so it earns a ref even
  // nested inside an already-tagged element (e.g. a menuitem inside a menu). Pure
  // cursor-inheritance with no own signal does not — its parent represents it.
  const isDistinct = (el: Element): boolean => {
    if (
      el.hasAttribute('onclick') ||
      el.hasAttribute('data-testid') ||
      el.hasAttribute('data-action')
    )
      return true;
    const role = el.getAttribute('role');
    if (role && CLICK_ROLES.has(role)) return true;
    const ti = el.getAttribute('tabindex');
    return ti !== null && Number(ti) >= 0;
  };
  // Why is this element a click target? null = it isn't one.
  const clickWhy = (el: Element): string | null => {
    const role = el.getAttribute('role');
    if (role && CLICK_ROLES.has(role)) return `role=${role}`;
    if (el.hasAttribute('onclick')) return 'onclick';
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return 'tabindex';
    if (cursorOf(el) === 'pointer') {
      const p = el.parentElement;
      if (!p || cursorOf(p) !== 'pointer') return 'cursor'; // pointer starts here
    }
    return null;
  };
  // Scrollable inner containers (page-agent's data-scrollable): overflow:auto/scroll
  // boxes with real scroll distance. Surfaced with a ref + remaining distance per
  // direction so the model can scroll them via scroll_page {ref} — window scroll
  // can't move an inner panel (chat message lists, modals, side panels).
  const scrollables: Array<{
    ref: string;
    tag: string;
    remaining: { up?: number; down?: number; left?: number; right?: number };
    label: string;
  }> = [];
  const SCROLL_CAP = 15;
  const scrollInfo = (el: Element) => {
    // cheap layout pre-filter before the pricier computed-style read
    const dy = el.scrollHeight - el.clientHeight;
    const dx = el.scrollWidth - el.clientWidth;
    if (dy < 4 && dx < 4) return null;
    const cs = window.getComputedStyle(el);
    const okY = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && dy >= 4;
    const okX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && dx >= 4;
    if (!okY && !okX) return null;
    const r: { up?: number; down?: number; left?: number; right?: number } = {};
    if (okY) {
      r.up = Math.round(el.scrollTop);
      r.down = Math.max(0, Math.round(dy - el.scrollTop));
    }
    if (okX) {
      r.left = Math.round(el.scrollLeft);
      r.right = Math.max(0, Math.round(dx - el.scrollLeft));
    }
    return r;
  };

  // Walk targets: body subtree + every open shadow root's subtree (flattened up
  // front so the loop body below stays unchanged), bounded like before.
  const walkTargets: Element[] = [];
  {
    let budget = 8000;
    for (const root of roots) {
      const list =
        root === document
          ? document.body
            ? document.body.querySelectorAll('*')
            : []
          : root.querySelectorAll('*');
      for (let i = 0; i < list.length && budget > 0; i++, budget--) walkTargets.push(list[i]);
      if (budget <= 0) break;
    }
  }
  let visited = 0;
  for (const el of walkTargets) {
    if (++visited > 8000) break; // bound the scan on huge pages
    if (clickables.length >= maxPerCategory && scrollables.length >= SCROLL_CAP) break;
    if (seen.has(el)) continue;

    // A scrollable container is its own category — not also a click target.
    if (scrollables.length < SCROLL_CAP) {
      const si = scrollInfo(el);
      if (si && isVisible(el)) {
        seen.add(el);
        const label =
          trimText(el.getAttribute('aria-label')) ||
          el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '');
        scrollables.push({ ref: tag(el), tag: el.tagName.toLowerCase(), remaining: si, label });
        continue;
      }
    }

    if (clickables.length >= maxPerCategory) continue;
    const why = clickWhy(el);
    if (!why) continue;
    // Skip a wrapper around an already-tagged native control unless it is itself
    // distinct — the inner control is the more precise target. (Native scans ran
    // first, so any inner control already carries the ref attribute.)
    if (!isDistinct(el)) {
      if (el.parentElement?.closest(`[${ATTR}]`)) continue; // nested under a tagged el
      if (el.querySelector(`[${ATTR}]`)) continue; // wraps a tagged control
    }
    if (!isVisible(el)) continue;
    const text =
      trimText(el.textContent) ||
      trimText(el.getAttribute('aria-label')) ||
      trimText(el.getAttribute('title'));
    if (!text) continue; // unlabeled icon-only node: no anchor for the model, skip
    seen.add(el);
    clickables.push({ ref: tag(el), text, why });
  }

  // Page scroll state (page-agent's header/footer model): tell the model whether
  // there's more content above / below / sideways, so after reading the viewport it
  // knows when to scroll_page instead of assuming the viewport is the whole page.
  const de = document.documentElement;
  const pageH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const pageW = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const sy = Math.round(window.scrollY);
  const sx = Math.round(window.scrollX);
  const below = Math.max(0, Math.round(pageH - (vpH + sy)));
  const right = Math.max(0, Math.round(pageW - (vpW + sx)));
  const scroll = {
    scroll_y: sy,
    page_height: Math.round(pageH),
    viewport_height: vpH,
    pixels_above: sy,
    pixels_below: below,
    pixels_right: right,
    pages_below: vpH > 0 ? Math.round((below / vpH) * 10) / 10 : 0,
    at_top: sy <= 1,
    at_bottom: below <= 4,
    more_above: sy > 1,
    more_below: below > 4,
    percent_scrolled: pageH > vpH ? Math.round((sy / (pageH - vpH)) * 100) : 100,
  };

  // ⑨ Hierarchical text view (page-agent / browser-use `flatTreeToString` FORMAT
  // — the format is borrowed, detection/visibility/occlusion reuse the scans
  // above, which already tagged every interactive element with ATTR):
  //   • one line per tagged element — `[ref]<tag attrs>own text />`;
  //   • indentation (\t) = how many TAGGED ancestors it nests under, so the
  //     model sees page STRUCTURE (which label sits by which input, which
  //     section a control belongs to) instead of a flat category list;
  //   • plain visible text is interleaved at its structural position;
  //   • an element's own text stops at nested tagged descendants (browser-use's
  //     get_all_text_till_next_clickable) — a menu line doesn't duplicate every
  //     menuitem's text.
  // Known limit (same as the flat lists): text isn't occlusion-tested, so text
  // behind an open modal can appear; the tagged elements themselves passed the
  // full isVisible incl. occlusion.
  let tree = '';
  if (wantTree) {
    const TREE_MAX_LINES = 400;
    const TREE_ATTRS = [
      'title',
      'type',
      'checked',
      'name',
      'role',
      'value',
      'placeholder',
      'alt',
      'aria-label',
      'aria-expanded',
      'aria-checked',
      'aria-haspopup',
      'data-state',
      'id',
      'for',
      'contenteditable',
    ];
    const SKIP_TAGS = new Set([
      'SCRIPT',
      'STYLE',
      'NOSCRIPT',
      'TEMPLATE',
      'META',
      'LINK',
      'HEAD',
      'SVG',
      'PATH',
      'IFRAME', // sub-frames arrive via the allFrames merge, not this walk
    ]);
    const lines: string[] = [];
    let dropped = 0;
    const emit = (depth: number, s: string): void => {
      if (lines.length < TREE_MAX_LINES) lines.push('\t'.repeat(depth) + s);
      else dropped++;
    };
    // Consecutive-text merging state: index/depth of the last emitted TEXT line
    // (reset by any interactive line). Dense admin TABLES emit one text node
    // per CELL — a 30×10 stats table alone eats 300 of the 400 lines and
    // truncates away the controls BELOW it (the pagination the model needed;
    // real-session finding §4.3.0c). Merging same-depth neighbors packs a row
    // into ~1 line while keeping reading order.
    let lastTextIdx = -1;
    let lastTextDepth = -1;
    const TEXT_LINE_MAX = 160;
    // Composed children: an element with a shadow root renders its SHADOW tree
    // (light children only show through <slot>), so descend accordingly.
    const kids = (el: Element): Node[] => {
      if (el.tagName === 'SLOT' && typeof (el as HTMLSlotElement).assignedNodes === 'function') {
        const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
        if (assigned.length) return assigned;
      }
      const sr = (el as HTMLElement).shadowRoot;
      return Array.from(sr ? sr.childNodes : el.childNodes);
    };
    // Cheap per-element visibility for text/structure (tagged elements already
    // passed the full isVisible during the scans). Cached — text siblings share
    // parents. Zero-rect alone doesn't kill a BRANCH (display:contents wrappers
    // have no box but render children); computed style is read only then.
    const visCache = new Map<Element, boolean>();
    const textVisible = (el: Element): boolean => {
      const hit = visCache.get(el);
      if (hit !== undefined) return hit;
      let v = false;
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) {
        if (onlyInViewport && (r.bottom < 0 || r.top > vpH || r.right < 0 || r.left > vpW)) {
          v = false;
        } else {
          const cs = window.getComputedStyle(el);
          v = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0;
        }
      }
      visCache.set(el, v);
      return v;
    };
    const branchDead = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width > 1 || r.height > 1) return false; // has a box → live
      const cs = window.getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden';
    };
    // Own text = descendant text stopping at nested TAGGED elements (their own
    // lines carry their text).
    const ownText = (el: Element): string => {
      let out = '';
      const rec = (n: Node): void => {
        if (out.length > 120) return;
        if (n.nodeType === Node.TEXT_NODE) {
          out += ' ' + (n.textContent ?? '');
          return;
        }
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        const e = n as Element;
        if (SKIP_TAGS.has(e.tagName.toUpperCase()) || e.getAttribute(ATTR)) return;
        kids(e).forEach(rec);
      };
      kids(el).forEach(rec);
      return trimText(out, 80);
    };
    // Inner scrollable containers get their remaining-distance summary inline.
    const scrollByRef = new Map<string, string>();
    for (const s of scrollables) {
      const rem = s.remaining as Record<string, number | undefined>;
      const parts: string[] = [];
      for (const k of ['up', 'down', 'left', 'right']) {
        if (rem[k] !== undefined) parts.push(`${k}:${rem[k]}`);
      }
      scrollByRef.set(s.ref, parts.join(','));
    }
    const lineFor = (el: Element, ref: string): string => {
      const text = ownText(el);
      const parts: string[] = [];
      for (const a of TREE_ATTRS) {
        let v: string | null = el.getAttribute(a);
        // live form state beats the (often absent) HTML attribute
        const tag0 = el.tagName;
        if (a === 'value' && (tag0 === 'INPUT' || tag0 === 'TEXTAREA' || tag0 === 'SELECT')) {
          const pv = (el as HTMLInputElement).value;
          if (typeof pv === 'string' && pv) v = pv;
        }
        if (a === 'checked' && tag0 === 'INPUT' && (el as HTMLInputElement).checked) v = 'true';
        if (v === null || v === '') continue;
        // attribute value that just repeats the visible text is noise
        if (text && v === text && (a === 'aria-label' || a === 'title' || a === 'placeholder'))
          continue;
        parts.push(`${a}=${trimText(v, 40)}`);
      }
      const sc = scrollByRef.get(ref);
      if (sc) parts.push(`scrollable=${sc}`);
      // <select>: without the flat arrays the model would never see the options —
      // and picking one is the whole point of the control. Inline a summary.
      if (el.tagName === 'SELECT') {
        const opts = Array.from((el as HTMLSelectElement).options)
          .slice(0, 12)
          .map((o) => trimText(o.textContent, 25))
          .filter(Boolean);
        const extra = (el as HTMLSelectElement).options.length - opts.length;
        if (opts.length) parts.push(`options=${opts.join('|')}${extra > 0 ? `|+${extra}` : ''}`);
      }
      return `[${ref}]<${el.tagName.toLowerCase()}${parts.length ? ' ' + parts.join(' ') : ''}>${text} />`;
    };
    let budget = 9000;
    const walk = (n: Node, depth: number, covered: boolean): void => {
      if (budget-- <= 0) return;
      if (n.nodeType === Node.TEXT_NODE) {
        if (covered) return; // a tagged ancestor's line already carries this text
        const t = trimText(n.textContent, 100);
        if (!t) return;
        const p = n.parentElement;
        if (!p || !textVisible(p)) return;
        // consecutive duplicate (split text nodes, repeated captions) → skip
        if (lines.length && lines[lines.length - 1].replace(/^\t+/, '') === t) return;
        // merge into the previous text line at the same depth (table cells /
        // label fragments) instead of one line per text node
        if (
          lastTextIdx === lines.length - 1 &&
          lastTextIdx >= 0 &&
          lastTextDepth === depth &&
          lines[lastTextIdx].length + t.length + 1 <= TEXT_LINE_MAX
        ) {
          lines[lastTextIdx] += ' ' + t;
          return;
        }
        const before = lines.length;
        emit(depth, t);
        if (lines.length > before) {
          lastTextIdx = lines.length - 1;
          lastTextDepth = depth;
        }
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const el = n as Element;
      if (SKIP_TAGS.has(el.tagName.toUpperCase())) return;
      const id = (el as HTMLElement).id;
      if (id === OVERLAY_ID || id === '__wa_overlay') return; // our own overlays
      const ref = el.getAttribute(ATTR);
      if (ref) {
        emit(depth, lineFor(el, ref));
        lastTextIdx = -1; // an interactive line breaks the text run
        kids(el).forEach((c) => walk(c, depth + 1, true));
        return;
      }
      if (branchDead(el)) return; // display:none / visibility:hidden subtree
      kids(el).forEach((c) => walk(c, depth, covered));
    };
    if (document.body) walk(document.body, 0, false);
    if (dropped) lines.push(`… +${dropped} rows truncated (pass only_in_viewport:true or scroll and scan in batches)`);
    tree = lines.join('\n');
  }

  if (highlight) paintOverlay();

  return {
    frameUrl: location.href, // used by mergeFrameResults to label sub-frames
    counts: {
      buttons: buttons.length,
      links: links.length,
      inputs: inputs.length,
      selects: selects.length,
      editable: editable.length,
      clickables: clickables.length,
      scrollables: scrollables.length,
    },
    scroll,
    highlighted: highlight,
    buttons,
    links,
    inputs,
    selects,
    editable,
    clickables,
    scrollables,
    ...(wantTree ? { tree } : {}),
  };
}
