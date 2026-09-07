/**
 * Text-quote anchoring for persistent highlights (selection-toolbar highlights).
 *
 * A highlight is stored as { exact, prefix, suffix } — the selected string plus
 * ~30 chars of context on each side (the W3C-annotation TextQuoteSelector
 * shape). Re-anchoring on a later visit:
 *   1. build a linear text index of the page (concatenated text nodes),
 *   2. find `exact` occurrences (raw first; whitespace-collapsed fallback for
 *      pages that re-render with different whitespace),
 *   3. disambiguate multiple occurrences by prefix/suffix agreement,
 *   4. wrap the matched span's text nodes in <mark> elements.
 *
 * Pure DOM in/out — no chrome.*, unit-tested under jsdom. Kept dependency-free:
 * this ships in the every-page content-script bundle.
 */

export const HL_CLASS = 'webagent-hl';
export const HL_ATTR = 'data-webagent-hl';

/** Context length captured on each side of the exact quote. */
export const CONTEXT_CHARS = 30;

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);

export interface TextIndex {
  /** All visible-ish text node contents, concatenated. */
  text: string;
  /** Each text node with its start offset into `text` (sorted). */
  nodes: { node: Text; start: number }[];
}

export function buildTextIndex(root: Node): TextIndex {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node) {
      const p = n.parentElement;
      if (p && SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: TextIndex['nodes'] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    nodes.push({ node: t, start: text.length });
    text += t.data;
  }
  return { text, nodes };
}

/** Linear position of (node, offset) in the index; null if the node isn't a
 * text node of this index (e.g. an element boundary). */
export function pointFromNodeOffset(idx: TextIndex, node: Node, offset: number): number | null {
  for (const e of idx.nodes) {
    if (e.node === node) return e.start + Math.min(offset, e.node.data.length);
  }
  return null;
}

/** The text-node segments covering [start, end) of the index. */
export function segmentsFromSpan(
  idx: TextIndex,
  start: number,
  end: number,
): { node: Text; start: number; end: number }[] {
  const out: { node: Text; start: number; end: number }[] = [];
  for (const e of idx.nodes) {
    const nodeEnd = e.start + e.node.data.length;
    if (nodeEnd <= start) continue;
    if (e.start >= end) break;
    out.push({
      node: e.node,
      start: Math.max(0, start - e.start),
      end: Math.min(e.node.data.length, end - e.start),
    });
  }
  return out.filter((s) => s.end > s.start);
}

/** How well `text` around [start,end) agrees with the stored context. Counts
 * matching chars walking outward (prefix backwards, suffix forwards). */
function contextScore(text: string, start: number, end: number, prefix: string, suffix: string): number {
  let score = 0;
  for (let i = 0; i < prefix.length; i++) {
    const c = text[start - 1 - i];
    if (c === undefined || c !== prefix[prefix.length - 1 - i]) break;
    score++;
  }
  for (let i = 0; i < suffix.length; i++) {
    const c = text[end + i];
    if (c === undefined || c !== suffix[i]) break;
    score++;
  }
  return score;
}

function findAllRaw(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    out.push(i);
    if (out.length > 200) break; // pathological pages
  }
  return out;
}

/** Collapse runs of whitespace to single spaces, keeping a map back to raw
 * indices (for the re-render-changed-whitespace fallback). */
export function collapseWs(raw: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let inWs = false;
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) {
      if (!inWs && text.length > 0) {
        text += ' ';
        map.push(i);
      }
      inWs = true;
    } else {
      text += raw[i];
      map.push(i);
      inWs = false;
    }
  }
  return { text, map };
}

/** Locate the stored quote in the index. `near` (optional linear position)
 * wins ties before context scoring does. Returns [start, end) or null. */
export function findQuote(
  idx: TextIndex,
  exact: string,
  prefix: string,
  suffix: string,
  near?: number,
): { start: number; end: number } | null {
  if (!exact) return null;
  let candidates = findAllRaw(idx.text, exact).map((start) => ({ start, end: start + exact.length }));
  if (candidates.length === 0) {
    // Whitespace-insensitive fallback: page re-rendered with different spacing.
    const hay = collapseWs(idx.text);
    const needle = collapseWs(exact).text;
    if (!needle) return null;
    candidates = findAllRaw(hay.text, needle).map((s) => {
      const start = hay.map[s];
      const endIdx = s + needle.length - 1;
      const end = hay.map[endIdx] + 1;
      return { start, end };
    });
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    let score = contextScore(idx.text, c.start, c.end, prefix, suffix);
    if (near !== undefined) {
      // Prefer the occurrence nearest the original position on top of context.
      score -= Math.abs(c.start - near) / Math.max(1, idx.text.length);
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** Wrap the given segments in <mark class=HL_CLASS data-webagent-hl=id>.
 * Returns the created marks. Splits text nodes as needed. */
export function wrapSegments(
  segs: { node: Text; start: number; end: number }[],
  id: string,
): HTMLElement[] {
  const marks: HTMLElement[] = [];
  for (const seg of segs) {
    const doc = seg.node.ownerDocument;
    if (!doc || !seg.node.parentNode) continue;
    // Don't double-wrap our own marks (idempotent restore).
    if (seg.node.parentElement?.closest(`[${HL_ATTR}]`)) continue;
    let target = seg.node;
    if (seg.start > 0) target = target.splitText(seg.start);
    if (seg.end - seg.start < target.data.length) target.splitText(seg.end - seg.start);
    const mark = doc.createElement('mark');
    mark.className = HL_CLASS;
    mark.setAttribute(HL_ATTR, id);
    target.parentNode!.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }
  return marks;
}

/** Attribute selector for one highlight id. Ids are self-generated
 * ([a-z0-9_]), but escape quotes/backslashes anyway — and avoid CSS.escape,
 * which isn't a bare global under jsdom. */
export function hlSelector(id: string): string {
  return `mark[${HL_ATTR}="${id.replace(/["\\]/g, '\\$&')}"]`;
}

/** Remove every mark of this highlight id, merging text back. Returns count. */
export function unwrapById(root: ParentNode, id: string): number {
  const marks = [...root.querySelectorAll(hlSelector(id))];
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
  return marks.length;
}

export interface QuoteDescriptor {
  exact: string;
  prefix: string;
  suffix: string;
}

/** Describe a live selection Range as a TextQuote descriptor against the
 * index. Uses the range's own text; context comes from the located span. */
export function describeRange(idx: TextIndex, range: Range): QuoteDescriptor | null {
  const exact = range.toString();
  if (!exact.trim()) return null;
  const ref =
    range.startContainer.nodeType === 3
      ? pointFromNodeOffset(idx, range.startContainer, range.startOffset)
      : null;
  const span = findQuote(idx, exact, '', '', ref ?? undefined);
  if (!span) return null;
  return {
    exact,
    prefix: idx.text.slice(Math.max(0, span.start - CONTEXT_CHARS), span.start),
    suffix: idx.text.slice(span.end, span.end + CONTEXT_CHARS),
  };
}
