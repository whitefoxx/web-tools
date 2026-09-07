/**
 * ⑩/⑩b Action receipt (page-agent borrow, page-agent-comparison §4.2): after a
 * mutating page action (click / type / select / key press), tell the model WHAT
 * CHANGED — did the tab navigate (all refs dead), did a popup/dropdown appear,
 * did the DOM grow — and (⑩b) hand it the NEW interactive elements directly
 * (ref + text), because ephemeral popups (autocomplete dropdowns) often close
 * on blur before a follow-up get_interactives can catch them (real-task
 * finding on Ctrip's city suggestions, §4.3.0b).
 *
 * This is page-agent's per-step <browser_state> refresh scaled down to a cheap
 * diff: two probe injections around the action instead of a full re-scan.
 *
 * Best-effort by contract: a receipt failure must never fail (or meaningfully
 * delay) the real action — every path here swallows its errors.
 */

/** How long the page gets to react before the after-probe reads it. Async UI
 * (React state → render → popup) needs a beat; tools' own wait_ms already ran
 * before this, so the settle only tops up when wait_ms was 0/small. */
const SETTLE_MS = 150;

export interface PageSig {
  /** visible popup-ish containers (listbox / menu / dialog / expanded) */
  pop: number;
  /** total element count — cheap "did the DOM grow" signal */
  el: number;
  /** before-mode: bounded signatures of visible interactive-ish candidates */
  sigs?: string[];
  /** after-mode: elements that appeared since the before-probe, ref-tagged */
  new_interactives?: Array<{ ref: string; text: string }>;
}

/** Injected probe, two modes sharing ONE function so the candidate collection
 * and signature computation are guaranteed identical on both sides of the diff:
 *  - `beforeSigs === null` → before-mode: return the signature list;
 *  - `beforeSigs` given    → after-mode: diff against it, tag each new element
 *    with a fresh `data-web-ref` (`n<salt><i>`, cleared like any ref by the
 *    next get_interactives scan) and return {ref, text} for the model to act on
 *    WITHOUT a re-scan.
 * Popups that matter are overwhelmingly marked with these roles/states
 * (combobox suggestion lists, menus, modals); the candidate selector adds `li`
 * for the common role-less autocomplete item (Ctrip-style). */
export function pageSigInPage(beforeSigs: string[] | null): PageSig {
  const SIG_CAP = 400;
  const OUT_CAP = 8;
  let pop = 0;
  document
    .querySelectorAll(
      '[role="listbox"],[role="menu"],[role="dialog"],dialog[open],[aria-expanded="true"]',
    )
    .forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) pop++;
    });
  let el = document.getElementsByTagName('*').length;
  // Don't count our own injected overlays (agent cursor / Set-of-Mark boxes) —
  // the FIRST action on a tab creates them, which would read as fake DOM growth.
  for (const id of ['__wa_overlay', '__web-som-overlay']) {
    const o = document.getElementById(id);
    if (o) el -= 1 + o.getElementsByTagName('*').length;
  }
  // Bounded visible-candidate collection (both modes).
  const sigOf = (e: Element): string => {
    const t = (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const ph = e.getAttribute('placeholder') ?? e.getAttribute('aria-label') ?? '';
    return e.tagName + '|' + t + '|' + ph.slice(0, 20);
  };
  const cands: Element[] = [];
  const all = document.querySelectorAll(
    'button,a[href],input,select,textarea,li,[role],[onclick],[tabindex],[contenteditable]',
  );
  for (let i = 0; i < all.length && cands.length < SIG_CAP; i++) {
    const e = all[i];
    if (e.closest('[data-wa-mask]') || e.closest('#__web-som-overlay')) continue;
    const r = e.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    cands.push(e);
  }
  if (beforeSigs === null) {
    return { pop, el, sigs: cands.map(sigOf) };
  }
  const out: Array<{ ref: string; text: string }> = [];
  // Fail closed on a capped before-list: everything past the cap would read as
  // "new" — silence beats noise.
  if (beforeSigs.length < SIG_CAP) {
    const seen = new Set(beforeSigs);
    const salt = Math.random().toString(36).slice(2, 6);
    for (const e of cands) {
      if (out.length >= OUT_CAP) break;
      const s = sigOf(e);
      if (seen.has(s)) continue;
      const text =
        (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) ||
        (e.getAttribute('placeholder') ?? e.getAttribute('aria-label') ?? '');
      if (!text) continue; // unlabeled node: no anchor for the model
      let ref = e.getAttribute('data-web-ref');
      if (!ref) {
        ref = 'n' + salt + out.length;
        e.setAttribute('data-web-ref', ref);
      }
      out.push({ ref, text });
    }
  }
  return { pop, el, ...(out.length ? { new_interactives: out } : {}) };
}

/** Pre-action probe. `null` = probe unavailable (restricted frame, race) — the
 * receipt then simply omits the popup/DOM fields. */
export async function captureSig(
  target: chrome.scripting.InjectionTarget,
): Promise<PageSig | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target,
      func: pageSigInPage,
      args: [null],
    });
    return (results[0]?.result as PageSig | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Diff a before/after pair into the receipt fields + a hint the model can act
 * on directly. Pure; unit-tested. */
export function diffSig(
  before: PageSig | null,
  after: PageSig | null,
  urlChanged: { from: string; to: string } | null,
): Record<string, unknown> {
  const receipt: Record<string, unknown> = {};
  if (urlChanged) {
    receipt.url_changed = urlChanged;
    receipt.hint = 'The page navigated; all previous refs are now stale — re-scan with get_interactives before continuing';
    return receipt;
  }
  if (!before || !after) return receipt;
  if (after.pop > before.pop) receipt.popup_appeared = true;
  const grew = after.el - before.el;
  if (grew > 3) receipt.new_elements = grew;
  if (after.new_interactives?.length) {
    receipt.new_interactives = after.new_interactives;
    receipt.hint =
      'The action surfaced new elements (a popover / dropdown / suggestion list?) — new_interactives above already carries their ref+text, so you **can click/type_into directly**; such popovers are often fleeting, use it now instead of re-scanning first';
  } else if (receipt.popup_appeared) {
    receipt.hint =
      'The action triggered a popover / dropdown (suggestion list, menu, or dialog) — run get_interactives to see the new elements (new:true / marked with * in the tree); many sites require picking an item from the list before it takes effect';
  }
  return receipt;
}

/** Post-action receipt: settle, check navigation, re-probe (diffing against the
 * before-probe's signatures), diff. */
export async function actionReceipt(
  tabId: number,
  target: chrome.scripting.InjectionTarget,
  beforeUrl: string,
  before: PageSig | null,
): Promise<Record<string, unknown>> {
  try {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    let urlChanged: { from: string; to: string } | null = null;
    try {
      const tab = await chrome.tabs.get(tabId);
      const now = tab.pendingUrl || tab.url || '';
      if (beforeUrl && now && now !== beforeUrl) urlChanged = { from: beforeUrl, to: now };
    } catch {
      /* tab gone — nothing useful to report */
    }
    // A navigating/navigated frame can't (and needn't) be probed.
    let after: PageSig | null = null;
    if (!urlChanged) {
      try {
        const results = await chrome.scripting.executeScript({
          target,
          func: pageSigInPage,
          args: [before?.sigs ?? null],
        });
        after = (results[0]?.result as PageSig | undefined) ?? null;
      } catch {
        /* best-effort */
      }
    }
    return diffSig(before, after, urlChanged);
  } catch {
    return {};
  }
}
