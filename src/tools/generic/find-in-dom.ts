import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';
import { getActiveExploreSession } from '../../core/explore-gate';

/**
 * Explore-time reverse lookup: the DOM dual of find_in_network. Given a VALUE
 * the agent saw on the page (a title, a name, a number), find the innermost
 * element that holds it and hand back **robustness-ladder-ranked candidate
 * selectors** (stable→weak) plus whether it sits in a repeating list unit. This
 * turns "I see 'DeepSeek 摇人' on the page" into a concrete, stable selector to
 * bake into the adapter — instead of the agent eyeballing get_html and guessing
 * (the exact failure the durability ladder is meant to prevent). A cheap
 * wrapper-induction: locate the value → generalize to a selector.
 *
 * ISOLATED content world (chrome.scripting), bounded per-match work. Explore tab
 * by default; a tab_id works standalone too.
 */
cli({
  site: 'generic',
  name: 'find_in_dom',
  access: 'read',
  description:
    '[Explore] Reverse-lookup: give a **value** you see on the page (title/author/number…) and get back the innermost element holding it + robustness-ranked candidate selectors (stable→weak: data-testid/itemprop/role/aria/semantic tags/stable href/semantic class), plus whether it sits in a **repeating list unit** (if so, gives the unit selector + sibling count — that is the list row). Use it to turn a "value you saw" directly into a stable selector usable in synthesis or a site script, instead of guessing at classes. Includes open shadow DOM. Pass tab_id (in an Explore session it may be omitted and defaults to the Explore tab).',
  args: [
    {
      name: 'text',
      type: 'string',
      required: true,
      help: 'Visible text value to reverse-look-up (whitespace-normalized + substring match)',
    },
    {
      name: 'tab_id',
      type: 'int',
      help: 'Target tab (required outside an Explore session, where it defaults to the Explore tab)',
    },
    { name: 'limit', type: 'int', default: 3, help: 'Max matches to return (default 3, cap 10)' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    let tabId: number;
    if (kwargs.tab_id !== undefined && kwargs.tab_id !== null && kwargs.tab_id !== '') {
      await assertTabId(kwargs.tab_id);
      tabId = Number(kwargs.tab_id);
    } else if (session) {
      tabId = session.tabId;
    } else {
      return { error: 'provide tab_id, or start an explore session first' };
    }
    const text = typeof kwargs.text === 'string' ? kwargs.text : '';
    if (!text.trim()) return { error: 'text must not be empty' };
    const limit = Math.max(1, Math.min(Number(kwargs.limit ?? 3) || 3, 10));

    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: findInDomInPage,
      args: [text, limit],
    });
    const out = res[0]?.result;
    if (!out) return { error: 'query failed (page is loading/refreshing, or scripts cannot be injected into it)' };
    return { text, ...out };
  },
});

/** Runs in the page context. Self-contained (executeScript serializes only this
 * function — no module refs). Bounded per-match work (V2.4 lesson). */
function findInDomInPage(
  needle: string,
  lim: number,
): {
  count: number;
  matches: Array<{
    tag: string;
    text: string;
    selectors: string[];
    unit?: { selector: string; siblings: number };
  }>;
} {
  const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim();
  const target = norm(needle);
  const esc = (s: string): string =>
    typeof (window as unknown as { CSS?: { escape?: (x: string) => string } }).CSS?.escape ===
    'function'
      ? (window as unknown as { CSS: { escape: (x: string) => string } }).CSS.escape(s)
      : s.replace(/["\\]/g, '\\$&');

  // Obfuscated/compiled class heuristic (mirrors synthesize.ts lintSource): short,
  // separator-free, internal camel change or letter+digit mix = hash-like → avoid.
  const isObf = (c: string): boolean => {
    if (c.length < 5 || c.length > 8 || /[-_]/.test(c)) return false;
    return /[a-z][A-Z]/.test(c) || (/[0-9]/.test(c) && /[A-Za-z]/.test(c));
  };
  const STABLE_ATTRS = [
    'data-testid',
    'data-test-id',
    'data-qa',
    'data-id',
    'itemprop',
    'jsname',
    'role',
    'aria-label',
    'name',
  ];
  // Candidate selectors for one element, stable→weak.
  const selForEl = (el: Element): string[] => {
    const tag = el.tagName.toLowerCase();
    const out: string[] = [];
    for (const a of STABLE_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length <= 40) out.push(`${tag}[${a}="${esc(v)}"]`);
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      const m = href.match(/^(?:https?:\/\/[^/]+)?(\/[A-Za-z0-9_-]+)\//);
      if (m) out.push(`a[href*="${m[1]}/"]`);
    }
    if (el.id && !isObf(el.id) && !/\d{4,}/.test(el.id)) out.push(`${tag}#${esc(el.id)}`);
    const semCls = (el.getAttribute('class') || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .filter((c) => !isObf(c));
    if (semCls.length)
      out.push(
        tag +
          semCls
            .slice(0, 2)
            .map((c) => `.${esc(c)}`)
            .join(''),
      );
    out.push(tag); // bare tag = last resort
    return [...new Set(out)];
  };

  // Collect elements across document + open shadow roots (bounded) so values
  // rendered inside web components are found too (shadow-aware family).
  const els: Element[] = [];
  {
    const roots: Array<Document | ShadowRoot> = [document];
    let walked = 0;
    for (let qi = 0; qi < roots.length && walked < 15000; qi++) {
      const nodes = roots[qi].querySelectorAll('*');
      for (let i = 0; i < nodes.length && walked < 15000; i++) {
        walked++;
        els.push(nodes[i]);
        const sr = (nodes[i] as HTMLElement).shadowRoot;
        if (sr) roots.push(sr);
      }
    }
  }
  // Find innermost elements whose textContent contains the value (no child
  // does) — the tightest wrapper.
  const matches: Array<{
    tag: string;
    text: string;
    selectors: string[];
    unit?: { selector: string; siblings: number };
  }> = [];
  for (let i = 0; i < els.length && matches.length < lim; i++) {
    const el = els[i];
    const tn = el.tagName;
    if (tn === 'SCRIPT' || tn === 'STYLE' || tn === 'NOSCRIPT' || tn === 'TEMPLATE') continue;
    if (!norm(el.textContent).includes(target)) continue;
    // innermost: skip if a child also contains it (that child will match instead)
    let childHas = false;
    for (let c = 0; c < el.children.length; c++) {
      if (norm(el.children[c].textContent).includes(target)) {
        childHas = true;
        break;
      }
    }
    if (childHas) continue;

    // Repeating-unit detection: nearest ancestor with ≥2 same-tag siblings — the
    // list "row" a value belongs to. Bounded ancestor walk.
    let unit: { selector: string; siblings: number } | undefined;
    let anc: Element | null = el;
    for (let up = 0; anc && up < 12; up++, anc = anc.parentElement) {
      const p = anc.parentElement;
      if (!p) break;
      const sameTag = Array.from(p.children).filter((s) => s.tagName === anc!.tagName);
      if (sameTag.length >= 2) {
        unit = { selector: selForEl(anc)[0], siblings: sameTag.length };
        break;
      }
    }
    matches.push({
      tag: el.tagName.toLowerCase(),
      text: norm(el.textContent).slice(0, 120),
      selectors: selForEl(el),
      unit,
    });
  }
  return { count: matches.length, matches };
}
