/**
 * Explore-session seam (core). Severs the shared generic tools' compile-time
 * edge to the heavy `explore/*` subsystem so the LITE bridge bundle can include
 * the standalone perception tools (open_url / get_html / query_dom /
 * get_dom_outline / find_in_dom / wait_for_selector) without dragging explore
 * recording / trace-store / synthesis into it.
 *
 * Those tools call {@link getActiveExploreSession} here instead of importing it
 * from `explore/session` directly. The FULL service worker injects the real
 * implementation at boot via {@link setExploreGate}; the LITE service worker
 * never does, so the getter returns null and those tools take their normal
 * (non-explore, `tab_id`-driven) path — exactly what they already do outside an
 * explore session.
 *
 * The seam publishes a MINIMAL structural interface ({@link ExploreSessionSeam})
 * — only the three members the base tools ever touch (`tabId`, `setSite`,
 * `recordState`) — instead of importing the full `ExploreSession` type. That is
 * what keeps `core/` free of a compile-time reference to `explore/session`, so
 * the base can be extracted without dragging the explore subsystem's types with
 * it (P4, docs/architecture.md §A). The full `ExploreSession` is a structural
 * superset, so the full SW wires its getter in without a change at the seam.
 */

/**
 * The slice of an explore session the shared base tools use. The full
 * `explore/session.ts` `ExploreSession` satisfies this structurally; nothing in
 * `core/` needs the rest of it.
 */
export interface ExploreSessionSeam {
  readonly tabId: number;
  setSite(site: string): void;
  recordState(e: {
    stream: 'state';
    url: string;
    title: string;
    html: string;
    label: string;
  }): void;
}

type ExploreGetter = () => ExploreSessionSeam | null;

let impl: ExploreGetter = () => null;

/** Wire the real getter (full SW boot). The lite SW never calls this, so the
 * getter stays the null default and the explore subsystem is never imported. */
export function setExploreGate(fn: ExploreGetter): void {
  impl = fn;
}

/** The active explore session, or null when not exploring / in the lite shell. */
export function getActiveExploreSession(): ExploreSessionSeam | null {
  return impl();
}
