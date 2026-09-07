// The LITE generic tool set — the standalone browser primitives that work
// WITHOUT an explore session (they open their own tab or take a `tab_id`). This
// is what the pure-bridge shell registers; it imports NOTHING from explore /
// marketplace / selection, so the lite bundle stays light.
//
// Importing each module triggers its top-level cli({...}) registration.
//
// `eval_js` IS registered here (shared-base primitive, docs/architecture.md
// §A.2) as a tab-addressed tool; the full shell re-registers a session-bound
// variant on top via explore/_all (last-write-wins).
//
// NOT here (full shell only, via _all.ts):
//   • trace-bound explore tools (they read the session's network recording):
//     list_network, read_network, list_trace, find_in_network, capture_submission.
//     (find_structured_data + get_a11y_tree were promoted to tab-addressed base
//     tools — registered below; live network capture is capture_network.)
//   • marketplace/selection tools: find_adapters, load_adapter, get_highlights
//   (find_in_dom + the site-script tools are base now — registered below.)
//
// The 6 tools below that default to the explore tab when `tab_id` is omitted
// (open_url / get_html / query_dom / get_dom_outline / find_in_dom /
// wait_for_selector) reach the session through `core/explore-gate` (null in
// lite → they simply require a tab_id), NOT `explore/session` directly.

// Navigation + content. get_page_text is dual-mode (url XOR tab_id) and covers
// both "fetch a URL" and "read an open tab". web_search is the base "query →
// ranked {title,url,snippet}" primitive (search+fetch two-piece with get_page_text).
// fetch_url is the RAW (non-rendering) half of fetch (SW-side, cookie-auth).
import './open-url';
import './get-page-text';
import './web-search';
import './fetch-url';
import './screenshot';
import './scroll-page';
import './close-tab';

// Tab awareness + management.
import './get-active-tab';
import './list-tabs';
import './tab-manage';

// Interaction primitives. click covers ref / selector / text locators.
import './get-interactives';
import './click';
import './type-into';
// fill_form: the batch half of type_into — N fields in one DOM pass, plus the
// element kinds a real form has (select / checkbox / radio).
import './fill-form';
import './press-key';
import './select-option';
import './hover';
import './drag-and-drop';
import './file-upload';
// Pre-arm auto-answers for native alert/confirm/prompt so they can't deadlock us.
import './handle-dialog';

// In-page search. (read_more is NOT here — see _all.ts: the oversize stash it
// pages through is only ever written by the in-extension agent's history
// truncation, so in the agent-free shell it is a tool that can never succeed.)
import './find-in-page';

// Standalone DOM perception (take `tab_id`; explore tab is only a fallback).
import './get-html';
import './query-dom';
import './get-dom-outline';
import './wait-for-selector';
// list_links: extract all <a href> (absolute, deduped, same-origin/regex/scope
// filters) — the frontier-extraction primitive for agent-orchestrated crawling.
import './list-links';
// (find_in_dom is registered in _all.ts only — it's an authoring-oriented
//  value→selector reverse lookup, low value without adapters, so WebCLI omits it.)

// Tools a PAGE declares for agents (navigator.modelContext). Cheap option on an
// emerging standard: no CDP, no new permission — see docs/devtools-mcp-comparison.md §2⑨.
import './webmcp';

// Page-context JavaScript (MAIN world over CDP, tab-addressed) — a SHARED-BASE
// primitive (docs/architecture.md §A.2): the escape hatch that lets an agent
// build any adapter as a skill. The full shell re-registers a session-bound
// variant on top of this via explore/_all (last-write-wins); WebCLI and localmd
// Connect keep this tab-addressed one.
import './eval-js';

// Recon primitives — the "find the data" perception layer (docs/architecture.md
// §A.6), tab-addressed with an explore-session fallback. find_in_dom is already
// registered above; these two were promoted out of the explore-only set.
import './find-structured-data';
import './get-a11y-tree';

// Live, tab-addressed network observation (docs/architecture.md §A.6) — the base
// counterpart to explore's trace-reading list_network/read_network: arm a URL
// pattern, trigger, read bodies (optionally reduced to rows in the page).
import './capture-network';

// value→selector reverse lookup — the recon/authoring primitive that pairs with
// site-script authoring (find the element → hide/enhance it). Tab-addressed.
import './find-in-dom';

// Site scripts — persistent page fixes (docs/architecture.md §A.2/§A.6). A
// STATEFUL base primitive: the extension stores and re-injects the rule. The
// confirm step is delegated to the calling context (the CLI agent for WebCLI,
// localmd's UI for localmd Connect, the full shell's write-confirm) + the popup
// as standing control. Needs the "Allow user scripts" toggle.
import './create-site-script';
import './list-site-scripts';
import './get-site-script';
import './set-site-script-enabled';
import './delete-site-script';
import './preview-site-script';
