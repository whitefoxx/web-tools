/**
 * localmd Connect tool registration — the third shell's surface: the 28 generic
 * WebCLI tools PLUS the adapter meta-tools and persistent site scripts, and
 * nothing else (no explore suite, no read_more — dead without the agent's
 * oversize history). 56 tools total, pinned by
 * tests/localmd-tool-surface.test.ts.
 *
 * Import order matters for exactly one pair: find-adapters-localmd re-registers
 * `generic__find_adapters` over the full-shell version (registry cli() is
 * last-write-wins on site/name) with run_adapter-oriented wording — this shell
 * does not register load_adapter, and the original text names it.
 *
 * Imported by src/background/localmd-connect-service-worker.ts ONLY. The full
 * shell keeps _all.ts; WebCLI keeps _generic.ts.
 */
import './_generic';

// find_in_dom is a shared-base primitive now (via _generic, imported above).

// eval_js is a shared-base primitive now (registered by _generic.ts, imported
// above) — WebCLI and localmd Connect share it. See docs/architecture.md §A.2.

// Dev build only (dead code elsewhere): reload the extension from the daemon so
// a rebuild takes effect without a trip to chrome://extensions.
import './dev-reload-extension';

// Site adapters (find_adapters / run_adapter) were RETIRED from this shell
// (2026-09-06): a way to reach a site is now a skill the agent builds from the
// base primitives (eval_js + recon) and the user saves in their own skills dir,
// not a shipped catalog. See docs/architecture.md §A.5.

// Site scripts are shared-base primitives now (via _generic, imported above);
// the confirm step is delegated to localmd's UI by contract (see connectGuard).

// Knowledge-base capture (docs/localmd-connect.md §14): the agent-driven clipper
// and the pull half of the browser-side capture inbox (context menu / shortcut /
// popup → inbox → `notifications/localmd/inbox` poke → list_inbox / ack_inbox).
import './clip-page';
import './inbox';

// The browser's memory of what the folder already holds — readable and
// correctable, because the extension cannot see a note being deleted (§14.4m).
import './saved-pages';

// Which knowledge base is open, mirrored from localmd so the popup can name the
// folder a capture goes to and offer the others (§14.4n).
import './kb-folders';

// The browser's own data — bookmarks / history / reading list / recently
// closed (§14.4 Phase 2). Every one sits behind an OPTIONAL permission the
// user grants in the popup, so none of them touches the install prompt.
import './browser-data';

// What the user marked while reading, from the in-page highlighter
// (§14.4 Phase 3). Re-registers `get_highlights` over the full shell's
// FEATURES-gated version, which knows nothing about colours or notes.
import './highlights';
