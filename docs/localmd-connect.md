# localmd Connect — the third shell (adapters + site scripts for localmd.app)

> Shell added 2026-08-06. This doc is the contract source for both sides: the
> extension (this repo) and localmd's client integration (see
> `localmd-connect-handoff.md` for the paste-to-localmd implementation prompt).

## 1. What it is

**localmd Connect** (`manifest.localmd.json`, name
`localmd Connect - Browser Superpowers`) is the companion extension for
[localmd.app](https://localmd.app) — an in-browser AI knowledge-base agent by
the same author. **Both are free and open source as of 2026-09-07**; until then
this shell was gated behind localmd.app's paid tier, and older text below (and
in `localmd-connect-handoff.md`) still reflects that — the pricing statements
there are historical, the licence gate they describe was never implemented. localmd already drives WebCLI's 28 generic browser tools over
the postMessage relay; this shell is WebCLI's headless base PLUS the two
full-shell capabilities that most amplify localmd's research workflows:

- **Marketplace site adapters** — ~300 ready-made, sha256-verified site tools
  (twitter/zhihu/reddit/youtube/…), loaded ephemerally on demand and executed
  through a single `run_adapter` meta-tool. A deterministic adapter beats
  scraping with generic tools.
- **Persistent site scripts** — user-approved hide/CSS/JS rules registered via
  `chrome.userScripts` that run on every matching page load (ad removal,
  decluttering, page enhancement) and persist across sessions.

Still absent BY CONSTRUCTION (localmd brings its own agent): the agent engine,
sessions, skills, memory, explore authoring, SidePanel, marketplace UI,
schedules, secrets vault, page↔LLM bridge.

## 2. One core, three shells

| axis               | Full ("Web Agent")                 | WebCLI                                | localmd Connect                                   |
| ------------------ | ---------------------------------- | ------------------------------------- | ------------------------------------------------- |
| vite mode          | (default)                          | `webcli` / `webcli-dev`               | `localmd` / `localmd-dev`                         |
| manifest           | `manifest.json`                    | `manifest.webcli.json`                | `manifest.localmd.json`                           |
| outDir             | `dist/`                            | `dist-webcli/` (+`-dev`)              | `dist-localmd/` (+`-dev`, §12)                    |
| SW entry           | `background/service-worker.ts`     | `background/webcli-service-worker.ts` | `background/localmd-connect-service-worker.ts`    |
| tool registration  | `tools/generic/_all.ts`            | `tools/generic/_generic.ts` (28)      | `tools/generic/_localmd.ts` (51)                  |
| executor           | `tools/dispatcher.ts`              | `core/execute-generic.ts`             | `localmd-connect/execute-adapter.ts`              |
| WS port / client   | 8787 / `web-agent`                 | 9376, dev 9377 / `webcli(-dev)`       | **dev build only** — 9378 / `localmd-connect-dev` |
| web-page transport | `onConnectExternal` (legacy)       | none since 0.3.0 (0.2.0: relay)       | relay, marker **`data-localmd-connect`**          |
| origin allowlist   | manifest-derived                   | none (removed 0.3.0)                  | **compiled in**, not editable (see §8)            |
| extension id       | `gcbgpkldpnmenoejbnbkdcagjhgbemeb` (unpublished) | store `jnhfdh…`, dev `hjdccc…`        | store `bgennb…`, dev `enodec…`                    |
| tab-group title    | `Web Agent`                        | `WebCLI`                              | `localmd Connect`                                 |
| build-time plugins | `sandboxPagePlugin`                | none                                  | **both** (adapters need sandbox/offscreen/runner) |

Build: `npm run build:localmd` (also part of `build:all`). The localmd mode is
the first to compose BOTH writeBundle plugins — they write disjoint files, and
`sandboxPagePlugin(outDir)` was parameterized for it (it used to hardcode
`dist/`).

## 3. Manifest deltas

vs `manifest.webcli.json` (the base): **adds** `userScripts` + `offscreen`
permissions, `web_accessible_resources: ["userscript-runner.js"]`, and (via the
build plugin's post-build patch, never in the source manifest) `sandbox.pages:
["sandbox.html"]` — the three prerequisites of the adapter runtime (func
adapters inject via `chrome.userScripts.execute`; ephemeral loads eval in the
offscreen-hosted sandbox iframe).

vs `manifest.json` (the full shell): **drops** `sidePanel`, `notifications`,
`side_panel`, `externally_connectable`; gains the popup action.

`key` is inline (see §9), so an unpacked `dist-localmd/` load always gets the
same id.

## 4. Tool surface — 56 tools, pinned by `tests/localmd-tool-surface.test.ts`

The 28 WebCLI generic tools, plus 8 (adapters + site scripts) and, since
2026-09-03, the 3 knowledge-base capture tools of §14.3 and the 10
browser-data tools of §14.4 (the later §14.4 phases added the rest; §14.4n
keeps the running count), and since 2026-09-06 the page-context primitive of
§15:

| tool                      | access | why here                                                                                                          |
| ------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `find_in_dom`             | read   | value→selector reverse lookup — the selector-discovery step of site-script authoring; works with explicit tab_id  |
| `eval_js`                 | read   | tab-addressed page-context JavaScript (MAIN world over CDP, async, JSON back) — what an adapter's `page.evaluate` did, run by the agent itself; static write guard + `allow_write` (§15) |
| `find_adapters`           | read   | marketplace search (CN↔EN aliases) — RE-REGISTERED (`find-adapters-localmd.ts`) with run_adapter-oriented wording |
| `run_adapter`             | write  | the adapter meta-tool: load-if-needed (sha256) + execute in one call (see §5)                                     |
| `create_site_script`      | write  | persistent hide/css/**js** rule — full surface, confirm delegated to localmd (see §7)                             |
| `list_site_scripts`       | read   | inventory + the "Allow user scripts" runnable flag                                                                |
| `set_site_script_enabled` | write  | pause/resume without deleting                                                                                     |
| `delete_site_script`      | write  | remove entirely                                                                                                   |
| `preview_site_script`     | read   | transient CSS preview (match counts, highlight mode) + one-shot `dry_run_js` in the real USER_SCRIPT world        |

Deliberately NOT registered: `load_adapter` (replaced by run*adapter — see §5),
`read_more` (pages the agent-history oversize stash, which only the full
shell's engine writes), the rest of the explore suite (session-bound recording,
synthesis — `eval_js` alone crossed over on 2026-09-06 as a tab-addressed
generic tool, §15), `web_task` (no agent engine here).

Because this shell does not register `load_adapter`, the stock `find_adapters`
description (which names it) would be a dangling reference — hence the
re-registration, exploiting the registry's last-write-wins de-dupe on
(site, name). `_all.ts` and the full shell are untouched.

## 5. run_adapter — why a meta-tool instead of load_adapter + dynamic catalog

localmd's agent runtime (Vercel AI SDK) fixes its tool set when a turn starts:
a tool that appears in `tools/list` mid-turn cannot be called until the next
turn, and localmd registers external tools up front precisely because the SDK
can only gate a fixed set. The full shell's flow (`load_adapter` → the adapter
appears in the catalog → call it by name) therefore never works within a turn
for localmd.

`run_adapter {site, name, args}`:

1. registry miss → `loadEphemeralAdapter` (fresh index fetch, sha256-verified
   source, sandbox eval — the exact `load_adapter` path);
2. execute through `localmd-connect/execute-adapter.ts`;
3. return `{tool, access, result}` (+ `loaded: true, args_spec` on a fresh
   load). Argument errors embed the adapter's full arg schema so the model
   self-corrects on the next call.

The catalog stays constant (51), nothing persists across SW restarts, and the
flow works mid-turn with zero localmd client changes. Cost: the model sees no
per-adapter JSON schema — `find_adapters` results + the schema-bearing errors
compensate.

## 6. The executor — `src/localmd-connect/execute-adapter.ts`

The adapter-capable sibling of `core/execute-generic.ts`, lifted from the full
shell's `tools/dispatcher.ts` (`executeAdapterInner`): generic tools delegate to
`executeGenericTool`; `_userScriptSource` func adapters lease an exclusive tab
from the per-site pool (max 5/site), get the §10.36 injectability guard, and run
via `runInstalledFuncAdapter`; pipeline adapters run tab-less or with a leased
PageShim. It lives in the SHELL directory, not `src/core/` — it imports
`adapters/namespace` + `userscript/sw-runner`, and core's guarantee is that it
never does.

Deliberately dropped vs the dispatcher (v1): secret env injection (func
adapters get `env: {}` — `process.env.*` reads see undefined), explore
recording, the cockpit mask, the run-tab janitor, adapter health recording,
adapter hints, per-tab key locks. Consequences worth knowing:

- **Pool tabs are reaped on an idle sweep, not at a run end** (`createPoolReaper`
  + `createIdleSweep`, wired into the SW's `onCallStart`/`onCallEnd`): ten quiet
  seconds after the last call, free pool-opened tabs close, and the agent window
  goes with them when nothing but its placeholder is left. v1 shipped with **no
  reaper at all**, and the note that stood here claimed the external agent would
  close them — it cannot: a pool tab's id never leaves the executor. See §10.48.
  The tabs the caller DOES hold (`open_url`, `get_page_text {keep_open}`) remain
  its own to close — same contract as WebCLI (docs/webcli.md §10).
- **Double pacing**: a `run_adapter` call paces once on the `generic` bucket
  (the meta-tool itself) and once on the leased tab's bucket (the inner
  adapter) — ~3–5s overhead per call, accepted for v1.

The SW must wire `chrome.runtime.onUserScriptConnect → handleRunnerPortConnect`
(plain `onConnect` NEVER fires for runner ports) and call `configureWebWorld()`
at boot — without these every func adapter times out. Pipeline adapters need
neither.

## 7. Site scripts — full create, confirm delegated (NORMATIVE)

The full shell's bridge restricts `create_site_script` to hide-only because
css/js need an in-panel confirm and external CLI agents have no UI. localmd
Connect REMOVES that restriction — css and js are accepted — because its
calling app is localmd itself, which has a real UI and the "agent proposes,
user disposes" doctrine. The contract, stated in the tool description and in
`LOCALMD_CONNECT_INSTRUCTIONS`:

> Before calling `create_site_script` with css/js, the calling app MUST show
> the user the match patterns and exactly what will be hidden/injected, and get
> explicit confirmation. The tool trusts that the confirm already happened.

Defense in depth behind that contract:

- the origin allowlist is compiled in and short, so the only page that can
  call at all is the one this extension exists to serve;
- `buildSiteScript` validation still applies (specific host patterns only —
  `<all_urls>` / bare-`*` hosts rejected; selector sanitizing);
- `llmAccess` is not accepted (no LLM in this shell, so no page↔LLM bridge);
- the popup lists every script with pause/delete — the user's standing override;
- `preview_site_script` (+ `dry_run_js`) exists so the agent verifies before it
  commits, and can show the user real effects during the confirm.

Storage is the shared IndexedDB (`web-agent-site-scripts` — per-extension, so
this shell's scripts are its own); `syncSiteScriptsOnBoot()` re-registers on
every SW start. Everything requires the user's one-time "Allow user scripts"
toggle at `chrome://extensions` — `list_site_scripts`/`create_site_script`
report `runnable: false` and the popup shows an amber call-to-action until then.

**Inspecting a saved script's source (2026-09-07).** `list_site_scripts` returns
only a summary (`has_css` / `has_js` booleans) — persistent injected code the user
could not read back was a transparency gap. Two channels now show the full source:
`get_site_script(id)` (a read tool, in the shared base so WebCLI has it too)
returns the match patterns, hidden selectors, CSS and JS; and each row in the
options page **expands on tap** to the same (matches / selectors / css / js in a
monospace panel — code set via `textContent`, so a script's own text can't inject
markup). This is the standing-control counterpart to the delegated create-confirm:
the user can review exactly what runs on their pages, then pause or delete it.

## 8. Page protocol — how localmd reaches this shell

The relay protocol originated in WebCLI 0.2.0 (`docs/webcli.md` §15, kept as
the design record); **as of WebCLI 0.3.0 this shell is its only carrier** —
this section is the canonical home. Same envelope, this shell's marker:

```
detect     : document.documentElement.dataset.localmdConnect === <ext id>
page → ext : postMessage({ webcli:'mcp', dir:'to-ext', ext, msg:<jsonrpc> })
ext → page : postMessage({ webcli:'mcp', dir:'to-page', ext, msg:<jsonrpc> })
on attach  : postMessage({ webcli:'mcp', dir:'to-page', ext, ready:true })
```

- The relay entry is `src/localmd-connect/web-relay.ts` — the WebCLI relay's
  design with this shell's marker attribute (the WebCLI copy was deleted in
  0.3.0). Emitted as `web-relay.js` by `relayScriptPlugin` and registered at
  runtime per allowed origin (shared `core/web-origins.ts` machinery).
- **Pages MUST echo `ext`** (read from the marker or the `ready` frame) in
  every `to-ext` frame. WebCLI ≤0.2.0 installs and dev builds serve the same
  envelope, so an untargeted frame on a page carrying both relays executes in
  BOTH extensions — twice, which matters the moment a write tool is involved.
- MCP: JSON-RPC 2.0 / 2025-03-26, `initialize` (carries
  `LOCALMD_CONNECT_INSTRUCTIONS`) → `notifications/initialized` → `tools/list`
  (51) → `tools/call`. 1 MB frame cap inbound, 16 MB outbound (§14.2). No
  `web_task`. Server→client: `notifications/localmd/inbox` (§14.2).
- There are **two** origin lists, and keeping them apart matters.
  `ALLOWED_ORIGINS` answers "who may reach the tools"; `LOCALMD_APP_ORIGINS`
  answers "where is localmd" — the list `ensureLocalmdTab` searches when a
  capture needs to focus or open the app. They coincide in the shipping build,
  which is exactly why handing one to the other went unnoticed until a dev
  profile showed it: "Ask localmd" focused this repo's FIXTURE server, because
  the dev allowlist carries it. Pinned by `tests/localmd-capture.test.ts`.

  Origins are **COMPILED IN** (`ALLOWED_ORIGINS` in the SW), not stored and not
  editable. The shipping build allows exactly `https://localmd.app`; the dev
  build adds `http://localhost:5173` (localmd's dev server) and
  `http://localhost:8123` (this repo's fixture server). Everything else is
  identical to WebCLI's two-layer gate: host-scoped injection + exact-origin
  service check, async, fails closed.

  Two reasons it is not a list the user edits. **It has nothing to add:** this
  shell serves one web app, so an "add a site" box is only ever a way to grant
  a site someone was talked into typing. And **`localhost:5173` is Vite's
  default port** — shipping it would hand full cookie-authenticated browser
  control to whatever dev server the user happens to be running, which is why
  the localhost entries exist only in a build that never reaches a store.

## 9. Identity

**Published 2026-08-12 as `bgennbocoapjiiolmmlcbfingimhmchh`** — the store
assigned it from a key pair Google holds, so nothing in this repo could have
chosen it. Since then `manifest.localmd.json`'s `key` carries the STORE's public
key, recovered from the published CRX (recipe in `docs/webcli-releases.md` §1),
which makes a plain `--mode localmd` unpacked load resolve to the published id
instead of a second extension that marks the same pages and answers the same app.

The self-generated key that used to sit there (private half
`extension-key-localmd.pem`, gitignored at the repo root → id
`enodecpmlecfpmofogpmbagdcfheamgf`) did not become garbage; it became the DEV
identity, and lives in `LOCALMD_DEV_KEY` in `vite.config.ts` so that
`--mode localmd-dev` can be installed alongside the store copy. One id per
profile means the shipping build cannot.

Nothing in the product hardcodes either id, and it must stay that way: localmd
finds the extension through the `data-localmd-connect` marker, whose value is
`chrome.runtime.id` at runtime. Only docs and localmd's store link name an id.

## 10. Verification

- `npm run check` — includes `tests/localmd-tool-surface.test.ts` (51-tool pin,
  dangling-reference sweep incl. `load_adapter`, manifest store limits, key
  presence, permission deltas) and `tests/run-adapter.test.ts` (load-if-needed,
  error passthrough, args coercion).
- `npm run build:localmd` → `dist-localmd/` must contain: `manifest.json` (with
  `key`, patched `sandbox.pages`, WAR `userscript-runner.js`), the SW bundle,
  popup assets, `web-relay.js`, `sandbox.html` (inline script),
  `offscreen.html` + `offscreen.js`, `userscript-runner.js`, icons.
- Real-machine smoke (docs/tests methodology): load `dist-localmd` unpacked
  (id must match §9) → enable "Allow user scripts" → popup shows the seeded
  origin. Drive via `BRIDGE_PORT=9378 node bridge/server.mjs` and
  `/command`: `generic__find_adapters {query:"hackernews"}` →
  `generic__run_adapter {site:"hackernews", name:"top"}` (pipeline, no toggle
  needed) → a func adapter on a public site (tab lands in the "localmd Connect"
  group) → `create_site_script` against a fixture page
  (`python3 -m http.server 8123 --directory docs/tests/fixtures`) → reload,
  verify effect → popup pause/delete. Relay smoke: add `http://localhost:8123`
  as an origin and drive `initialize`/`tools/list`/`tools/call` from a test
  page reading `dataset.localmdConnect`, `ext` echoed; with WebCLI installed on
  the same page, verify both markers coexist and targeted frames execute once.

## 11. No skills repo — decided, not deferred (2026-08-06)

WebCLI ships a public skills repo (`whitefoxx/web-tools`: daemon +
`SKILL.md`) because its consumer is a CLI agent, and the WS transport carries
**no** `instructions` — a hand-maintained skill file is the only channel that
reaches it. localmd Connect does not get one, and the asymmetry is the point:

- **Its consumer is a web app**, and the relay transport DOES carry
  `instructions` — `LOCALMD_CONNECT_INSTRUCTIONS` rides the MCP `initialize`
  response, so guidance ships with the build and cannot drift from the code the
  way a separate repo's `SKILL.md` can (WebCLI's did, and was corrected only
  when 0.3.0 forced a re-read).
- **The tool descriptions carry the flow on their own.** Demonstrated on the
  first real-machine pass: find_adapters → run_adapter → the site-script
  authoring loop all ran with no skill loaded, off `GET /tools` alone.
  `tests/localmd-tool-surface.test.ts` pins that property (no dangling
  references, honest access flags).
- **A repo is a real surface**: a public repo + submodule + version sync +
  release checklist, for a consumer that does not exist yet.

The WS bridge is **dev-only** (§12), so there is no shipped CLI path for a
skill to serve in the first place. What remains true for the dev build: it is
driven by the GENERIC daemon in this repo's `bridge/` (`BRIDGE_PORT=9378 npx -y
github:whitefoxx/web-tools`), which is transport-only and knows nothing
about either shell's tool set, and a CLI agent on it gets the catalog but not
the `instructions` — so the write-confirm contract (§7) reaches it only through
the tool descriptions. That is acceptable for a testing path. If a CLI path
ever ships, the cheap fix is a skill file in this repo's `bridge/`
sibling, not a new public repo.

## 12. Two builds: `localmd` ships, `localmd-dev` can be driven

The shipping extension has **no way in from outside the browser**. A page on an
allowed origin is the entire attack surface, which is the strongest version of
this product's security story and costs nothing — its only consumer is a page.

But developing it needs the opposite: a CLI agent (this repo's own real-machine
test methodology) has to drive the shell to test adapters and site scripts. So
the WS daemon bridge lives behind `__LOCALMD_DEV__`:

|                     | `--mode localmd` → `dist-localmd/`  | `--mode localmd-dev` → `dist-localmd-dev/`        |
| ------------------- | ----------------------------------- | ------------------------------------------------- |
| WS daemon bridge    | **absent** (dropped by the bundler) | port 9378, client `localmd-connect-dev`           |
| `alarms` permission | not requested                       | added back in `vite.config.ts` (the redial timer) |
| allowed origins     | `https://localmd.app`               | + `localhost:5173`, `localhost:8123`              |
| popup               | status + adapters + site scripts    | ditto + a CLI-agent disclosure                    |
| name / key          | as in the manifest                  | `localmd Connect (dev)` + `LOCALMD_DEV_KEY`       |

`__LOCALMD_DEV__` is a build-time literal, so `dist-localmd/` contains no
`createWsBridge`, no redial alarm and no localhost origin — verified by grep in
the release checklist, not by faith in tree-shaking.

Note the flag carries MORE than WebCLI's does: `__WEBCLI_DEV__` only swaps an
identity, while this one removes a CAPABILITY. A dev build is therefore not a
valid stand-in when smoke-testing what you are about to upload.

Until the extension is published, both modes resolve to the same id (the
manifest still holds the self-generated key), so they cannot be installed side
by side — harmless, since there is no store install to sit beside. At first
publish the store's key goes into the manifest and `LOCALMD_DEV_KEY` makes them
diverge, exactly as it did for WebCLI.

### Debugging the dev relay: check that the page LOADED (2026-08-18)

An afternoon went into "the relay is dead on `http://localhost:5173` after a dev
reload — `data-localmd-connect` is absent, while `https://localmd.app` still
carries it". Registration was inspected, host permissions were inspected, an MV3
recycle was forced to re-run `syncRelayScripts()`, and a fix was written for a
stale-registration bug.

There was no bug. **The Vite dev server was not running**, so every check read
`document.documentElement` on `chrome-error://chromewebdata/`. An error page has
no marker for the same reason it has no content. Chrome keeps the tab titled
`localhost` and `chrome.tabs` still reports the requested URL, so nothing about
the tab list gives it away — `location.href` does.

**Before concluding anything about the extension, assert the page loaded**:

    // in the page, not the SW
    ({ url: location.href, marker: !!document.documentElement.getAttribute('data-localmd-connect') })

`url` coming back as `chrome-error://…` means the question was never asked.

Two other things this cost, worth keeping:

- **"Adapters still work" does NOT prove host access.** The manifest carries
  `debugger`, and the executor drives pages over CDP attach, which needs no host
  permission at all. A scraping adapter can succeed on a site the extension may
  not inject a content script into — so it is no evidence either way when a
  content script is the thing that is missing.
- **`syncRelayScripts` logs only when something CHANGED** (`relay scripts synced
  (+N −M)`). A boot where everything is already registered looks identical in the
  console to a boot where the function never ran, so the absence of that line is
  not evidence — read `getRegisteredContentScripts()` instead. (An unconditional
  log line would be an improvement; it is not made here, because the bug it would
  have helped diagnose did not exist.)

The abandoned fix is worth recording too, as a shape to avoid: it added a forced
re-registration pass on `chrome.runtime.onInstalled` alongside the existing boot
pass, and the two ran unawaited. They raced — the forced pass read the listing
mid-flight, unregistered what it saw, then collided with what the boot pass had
just added (`Duplicate script ID` in the console). That error was then read as
evidence for the very bug the pass was written to fix. **A symptom your own change
produced is not evidence for the theory that motivated the change.**

## 13. Known v1 limits (all deliberate)

- No secrets vault: env-reading func adapters degrade (empty `process.env`).
- run_adapter double-paces (~3–5s/call).
- No tab reaper — the external agent owns tab lifecycle (WebCLI contract).
- ~~Icons are shared with the other shells~~ — resolved 2026-08-06: dedicated
  icon (localmd's bracket mark, dot swapped for a bolt — the store name's
  "Browser Superpowers"). Source `public/icons/localmd-connect.svg`, PNGs
  regenerated with sharp (transparent corners, never qlmanage).
- ~~No dev-mode variant~~ — added 2026-08-07, for a reason bigger than
  identity: it is the only build with a daemon (§12).
- ~~Explore authoring (agent-generated NEW adapters) stays full-shell-only;
  localmd users consume the marketplace~~ — reversed 2026-09-05: the marketplace
  is now **experimental** and on its way out of this shell; the agent is meant
  to build what it needs from generic primitives and keep it as data (§15).

## 14. The browser as a context container — knowledge-base capabilities (2026-09-03 →)

> Plan of record for the next phase of this shell. Phase 1 is landed on the
> `product` branch (unit-tested; real-machine pass pending — see §14.6).

### 14.1 Framing

localmd's knowledge base is a local folder. This shell gives its agent a
SECOND context container, the browser, which is wider than it looks: every
tool with a web site is reachable through it (site adapters + the generic
tools), and the browser itself holds the user's own data — tabs, bookmarks,
history, the reading list. Together the two cover most of a knowledge
worker's context. Three layers, each a batch of tools:

| layer                       | what                                                                           | direction          | status                   |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------ | ------------------------ |
| sites                       | adapters + generic tools                                                       | localmd pulls      | shipped (§1–§7)          |
| browser-native data         | tabs (localmd's `@` picker), bookmarks, history, reading list, recently closed | localmd pulls      | tabs ✅ · rest = Phase 2 |
| the user's reading activity | clips, highlights / annotations, screenshots, "ask localmd"                    | the BROWSER pushes | clips + ask ✅ (Phase 1) |

The third row is new in kind: everything before it was localmd calling a
tool. A clip starts on the other side — the user is on a page, presses a
menu item, and localmd may not even be open. That is what §14.2 is for.

### 14.2 Two foundations (Phase 0, landed)

**D1 — the capture inbox + a poke** (`src/localmd-connect/inbox.ts`). Every
user gesture lands in an IndexedDB queue owned by the extension. Delivery is
two-step: the SW broadcasts `notifications/localmd/inbox {count}` over every
handshaken relay port whenever the queue changes (and once more to a page
that has just completed its handshake, via the core's new `onClientReady`
hook), and localmd PULLS with `list_inbox` → writes → `ack_inbox {ids}`. The
notification is a hint, never the delivery: a tab can miss it, the queue
cannot. The queue lives on this side and not in the KB by localmd's own rule
— the KB holds what the user owns, never a record the machinery must keep
correct — and it is built to be lost (unacked = re-listed, acked = gone).

**A poke needs a live port, and the port dies on its own** (fixed 2026-09-03,
after nine captures piled up unnoticed). Chrome recycles an idle MV3 service
worker after a few minutes — an extension reload does the same — and every relay
Port goes with it. Nothing told the page: `onDisconnect` fires only in the
CONTENT SCRIPT, and the relay did not forward it, so localmd's row stayed green
over a connection that no longer existed and every broadcast reached nobody.
Reloading localmd drained the whole backlog at once, which is what identified
it: connecting worked, staying connected did not.

The relay now posts `{ closed: true }` on disconnect; localmd's `McpRelayClient`
turns that into `onLost`, the row goes red, and the app's existing
focus-retries-failed-rows path reconnects — which re-runs `onClientReady` and
drains. Coming back to the tab is therefore the recovery, and coming back to the
tab is exactly what "Ask localmd" does.

The lesson is in the comment this replaced: it said there was no lifecycle event
to observe, and that a dead relay would surface as a timeout on the next call.
Both true, and the conclusion wrong — waiting for the next call is the wrong
direction when the point of the connection is that the other side can start the
conversation.

Transport core changes (`src/core/external-mcp-core.ts`, shared, opt-in):
the handler now carries `broadcast(method, params)` (handshaken ports only —
a peer mid-handshake cannot make sense of a server notification; a port
leaves the audience on disconnect), and `ExternalMcpConfig` gained
`onClientReady(notify)` + `maxOutboundBytes`. Pinned by
`tests/external-mcp-notify.test.ts`. The full shell and WebCLI are untouched
(both defaults preserve the old behaviour byte for byte).

**D2 — images across the relay.** The 1MB frame ceiling was sized for text;
a clip with inlined images or a sized full-page screenshot is legitimately
several MB and `postMessage` does not care. This shell sets
`maxOutboundBytes` to 16MB; the INBOUND ceiling stays at 1MB. Whether the
bytes then reach the KB is localmd's side of the contract (§14.5, item 3):
today its `flattenToolResult` collapses an MCP image block to the string
`[image image/png]`.

### 14.3 Phase 1 — the clipper + "ask localmd" (landed)

New tools (39 total, `tests/localmd-tool-surface.test.ts`):

| tool         | access | what                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clip_page`  | read   | `{url \| tab_id, mode, images, selector, max_bytes}` → a `ClipPayload`: page metadata (canonical, site, author, published/modified, description, lang, og:image — `extractPageMeta`, meta tags + a JSON-LD pass), main-content Markdown, image URLs (`images:"inline"` fetches them as data URLs with the user's cookies, ≤20 / 3MB each / 12MB total), and for `mode:"selection"` a TextQuote `{exact, prefix, suffix}`. The CALLER writes the note. |
| `list_inbox` | read   | pending items, oldest first; `summary:true` omits payloads; `kind` filter                                                                                                                                                                                                                                                                                                                                                                             |
| `ack_inbox`  | write  | remove processed ids (idempotent) — flagged write because it drops user-captured data; localmd's confirm gate does not key on it                                                                                                                                                                                                                                                                                                                      |

The clipper (`src/localmd-connect/clip.ts`) does everything that needs the
browser and nothing that needs the KB. Three modes, ONE walker:
`article` runs the main-content pick, `full` scopes to `body` (boilerplate
filter kept, pick dropped), `selection` reads the live Selection, serializes
the fragment with absolutized links, and runs the same `extractPageMarkdown`
over a mini-DOM parse of it — so a clipped paragraph and a clipped page never
disagree on dialect. Lazy images (`data-src` and friends) are swapped in
before the walker reads `src`.

Extractor upgrades in `get-page-text.ts`, which `get_page_text`, `fetch_url`
and the clipper all share:

- **Main-content pick by text density, only where the page declares nothing.**
  A page with `<main>` / `<article>` / `[role=main]` is taken at its word.
  Without one, a Readability-lite scorer runs over `body`: each paragraph-like
  element (P / PRE / LI / BLOCKQUOTE / TD, ≥25 chars) credits its parent in
  full and its grandparent by half; the top scorer wins if it holds ≥60% of
  the scope's paragraph text and is not link-dominated (>50% link text), else
  `body` is kept whole (a thread of many small posts must not collapse to one
  of them). Deliberately NOT `@mozilla/readability`: the scorer is ~60 lines
  over the mini-DOM surface (so the raw-fetch path gets it too), and the
  library needs a real DOM. Re-evaluate if a corpus shows the scorer losing to
  it on ≥3 real page shapes.

  **The "only where the page declares nothing" half was bought with a
  regression** (findings F-51). The first version narrowed inside `<main>` too
  and passed every hand-written fixture; a four-page real corpus then showed it
  dropping MDN's article intro, because the ≥60% bar counts paragraph-like text
  only and a long method list beats a short intro. Measured against the
  PRE-CHANGE behaviour, page by page:

  | page                           | before | after | note                                     |
  | ------------------------------ | -----: | ----: | ---------------------------------------- |
  | MDN `Range` reference          |   8054 |  8054 | was 4610 — intro lost                    |
  | Wikipedia article              |  48571 | 48571 | unchanged throughout                     |
  | GitHub repo page               |   9491 |  9491 | was 2641 — README only, but unverifiable |
  | Hacker News item (no `<main>`) |   2018 |  1139 | drops top nav, wrapper row, footer only  |

  `extractPageMarkdown` is shared by all three shells' `get_page_text`, so a
  heuristic that quietly loses prose is the expensive kind of mistake — when
  unsure it must keep everything.

- **Table cells go through the walker** (findings F-50). `tableToMd` flattened
  each cell with `textContent`, which eats markup: on a table-LAID-OUT page
  every link vanished before the `A` branch ever saw it. Hacker News clipped
  with **zero** links; it now yields 17 on an item page. Nested tables are also
  emitted once now (`closest('table') === table`) instead of once per level.
- **Links and images come out ABSOLUTE.** Reported by the user (2026-09-03):
  `get_page_text` gave the model links it could not follow, so a follow-up
  question meant re-reading the page. The walker now resolves every href/src
  against `location.href` on both the tab and the raw-fetch path. The default
  `format:"text"` still drops links — recorded as a follow-up, not changed (a
  default change reaches all three shells); `LOCALMD_CONNECT_INSTRUCTIONS`
  tells the agent to read with `format:"markdown"` when it may follow a link
  next. Note this fix ALONE did nothing for the page that prompted the report
  — see the table-cell item above.
- `[hidden]` elements are skipped like `aria-hidden`.

User-side entry points (`src/localmd-connect/capture-actions.ts`,
`manifest.localmd.json`): a context menu (Clip page / Clip selection / Ask
localmd about this page / …this selection; `contextMenus` permission — no
install-prompt warning), two commands (`Alt+Shift+S` clip, `Alt+Shift+L`
ask; user-rebindable), and three popup buttons with a pending-count line.
All funnel into `captureToInbox`. Routing afterwards: a CLIP keeps the user
where they are (a localmd tab is opened in the background if none exists, so
the item is written soon; the toolbar badge shows the pending count as the
receipt); an ASK focuses localmd, opening it if needed — the conversation
happens there with the KB in context, never in an overlay on the page.

### 14.4 Phase 2 — the browser's own data (landed)

Ten tools (49 total), every one behind an OPTIONAL permission:

| tool                       | access | permission    |
| -------------------------- | ------ | ------------- |
| `search_bookmarks`         | read   | `bookmarks`   |
| `list_bookmarks`           | read   | `bookmarks`   |
| `create_bookmark`          | write  | `bookmarks`   |
| `delete_bookmark`          | write  | `bookmarks`   |
| `search_history`           | read   | `history`     |
| `list_reading_list`        | read   | `readingList` |
| `add_to_reading_list`      | write  | `readingList` |
| `remove_from_reading_list` | write  | `readingList` |
| `set_reading_list_read`    | write  | `readingList` |
| `list_recently_closed`     | read   | `sessions`    |

**The removals were missing at first**, and the gap showed up immediately: the
write tools could not be tested on a real machine because nothing could clean up
after the test. The first cut had copied the shape of the five tools deleted in
`e31fde0` (search + create) without asking whether that set was complete — the
Chrome APIs (`bookmarks.remove`, `readingList.removeEntry` / `updateEntry`) had
been there all along.

Two rules the removals follow:

- **A delete returns what it deleted**, so `create_bookmark` /
  `add_to_reading_list` with those values is the undo. `removeEntry` tells the
  caller nothing, so `remove_from_reading_list` looks the entry up first purely
  to be able to hand its title back.
- **No folder deletion.** `bookmarks.removeTree` takes everything inside with
  it and the API has no undo (Chrome's own UI does). `delete_bookmark` refuses
  a folder id and says why. `update` / `move` are absent too, but only because
  nothing has asked for them yet — that one is a scope call, not a safety one.

**Optional is the entire reason this can exist.** Five of these shipped in the
full extension in June 2026 and were deleted a month later (`e31fde0`): asked
for up front they turn the install prompt into "read and change your browsing
history / bookmarks / reading list", which is not a trade to put in front of
someone who has not seen the product yet. `optional_permissions` moves the
decision to the moment it buys something. A test pins it
(`tests/localmd-tool-surface.test.ts`): if one of the four ever appears in
`permissions`, that decision has been silently reversed.

The popup is the only place they can be granted — `chrome.permissions.request`
needs a user gesture in an extension page, so neither a web page nor the
service worker can ask. A "Browser data" section lists the four with one line
each on what it buys; unchecking revokes immediately.

Two shape decisions worth keeping:

- **An ungranted tool FAILS**, with a message that names the switch and says
  not to retry (prefix `permission_required:` so a client can match on it
  without parsing prose). It does not answer with an empty list: "nothing
  matches" and "I am not allowed to look" are different answers, and a tool
  that conflates them teaches the agent to report the wrong one (F-47).
- **Everything pages**, because the calling app clips a tool result well below
  the size a history search reaches. Everything pages by OFFSET, over one
  bounded query, asking for a row more than it returns so it knows whether to
  offer a cursor at all.

  History was written with a time cursor first, on the reasoning that a time
  series must not be paged by offset — right in general, wrong for this API, and
  it took the first real history to show it (F-53). `chrome.history.search`
  selects URLs with a VISIT in the window but reports each one's GLOBAL
  `lastVisitTime`, so a page seen both recently and long ago matches every
  window while always carrying its recent timestamp: consecutive pages
  overlapped by a row. The unit test had missed it because the fake filtered on
  the row's own `lastVisitTime` — it reproduced the misunderstanding rather than
  the API. History paging is capped at 1000 rows deep, since each page re-runs
  the query.

Real artefacts this is for: "import my 'AI papers' bookmark folder as a source
list", "what did I read about X this week → today's capture page", "turn what I
have open plus what I just closed into a reading note".

### 14.4d Two things the browser-side capture path needed to be usable

Both found by using it, neither visible from the code.

**A tool that touches no website must not be paced.** Every generic tool waits
on `humanPace` — a 0.6–1.8s jitter plus a 2.5s minimum gap — so a site cannot
tell a machine is driving it. Reading the capture inbox took 1.3–5.5 seconds out
of the extension's OWN IndexedDB, and a drain is two calls, so pressing "Ask
localmd" sat there long enough to look broken. `AdapterDef.local` now marks the
24 tools with no site on the other end (tabs, inbox, highlights, site scripts,
bookmarks / history / reading list, the adapter catalogue) and both generic
executors skip pacing for them. The dangerous direction — a page-driving tool
marked local loses the pacing exactly where it is the point — is pinned by
`tests/local-tools.test.ts`, which also fails if a tool belongs to neither list.

**Where "Ask localmd" goes is a BUILD fact, not a search.** Two versions got
this wrong the same way: first by searching the connect allowlist (which in a
dev profile focused this repo's fixture server), then by searching both app
origins with a most-recently-used tiebreak (which still jumped a dev build to
production whenever a localmd.app tab was open). `LOCALMD_APP_ORIGINS` now holds
exactly one origin per build.

### 14.4c Phase 3 — what the user marked while reading (landed)

An in-page highlighter (`src/localmd-connect/page-tools.ts`), and two tools over
what it stores: `get_highlights` (read) and `delete_highlights` (write) — 51
tools. `clip_page` also carries a page's highlights, so a note and its
annotations arrive together rather than the note arriving first.

It is NOT the full shell's selection toolbar. That one's centre of gravity is a
set of one-shot LLM actions and this shell has no LLM. What is reused is the
machinery that was expensive to get right — `selection/anchor.ts`'s TextQuote
anchoring, the shadow-root UI, the restore loop — and what is added is what a
knowledge base needs: five colours (the same five localmd renders annotations
in, so an archived highlight looks like the one on the page), a note per
passage, and two buttons that hand the passage to localmd (Clip / Ask).

**Highlights do not push into the capture inbox.** Twenty highlights on one page
would be twenty pokes and twenty drains, for something the user is not asking
anyone to act on yet. They are a WORKING COPY in the extension; they become
knowledge-base content when a clip is written or when the agent asks. Same rule
as the inbox, one layer out.

Registration follows the relay's pattern with one deliberate difference: the
script is registered for EVERY http(s) page and disables itself from settings,
rather than being registered per host. Registration then never churns when the
blacklist changes, SPAs are covered for free, and `storage.onChanged` switches
tabs that are already open. A blacklist rather than an allowlist, for the reason
`docs/selection-toolbar.md` §2.1 already settled: a feature you must switch on
per site is a feature nobody uses.

Storage is the shared `selHl:<url>` store, extended with two OPTIONAL fields
(`color`, `note`) so entries written by the full shell's toolbar still read
correctly — an absent colour means yellow, an absent note means the user did not
write one.

### 14.4e Phase 4a — screenshot one element (landed)

`screenshot { ref | selector }` clips the capture to one element's box, in page
coordinates with `captureBeyondViewport`, so the element can be anywhere on the
page. A `ref` is what `get_interactives` stamped on the element as
`data-web-ref`; a `selector` is any CSS selector (first match). The result
carries `element` and the `clip` rect. Same encoding levers as before
(`format`, `quality`, `max_width`), and the same one-canvas-pass rule.

Deliberately refused, with the reason in the error: an iframe-scoped ref
(`f5r3`). The clip is in the top document's coordinates and a sub-frame's rect
would need that frame's own offset added — a real feature, not a v1 one, and a
wrong clip that calls itself the element is worse than no clip. `full_page`
with a target is refused too. Pure parts pinned by
`tests/generic-screenshot-clip.test.ts`.

Why this before region capture: it is what the AGENT reaches for ("screenshot
that chart"), it is pure tool work, and it reuses the existing capture path
unchanged. The drag-and-annotate capture is the USER's gesture and a UI, and
comes next.

### 14.4f Phase 4b — screenshot a region, annotate it, send it (landed)

The user's half of screenshots: a context-menu item, `Alt+Shift+A` and a popup
button put the full shell's Monica-style overlay on the page — drag a
rectangle, then rect / ellipse / arrow / pen / text / mosaic — and the picture
goes into the capture inbox as kind `screenshot`. localmd drains it like a
pasted picture (`importFile` → `raw/images/` in a raw-layout folder, `inbox/`
elsewhere), named after the page it came from.

Two reuse decisions. The in-page selector moved VERBATIM out of
`src/sidepanel/region-capture.ts` into `src/capture/region-select.ts` and the
SidePanel imports it back — one behaviour, two callers. And the composite (crop
the tab capture to the rect, draw the annotation over it) does not need an
offscreen document: a service worker can decode a PNG with `createImageBitmap`
and draw on an `OffscreenCanvas`, which is exactly what the stitched full-page
screenshot already does. The overlay's ⬇ ("download instead") is honoured
through `chrome.downloads`, and a cancelled or downloaded capture is not an
inbox item and not an error.

### 14.4g Phase 5 — the browser knows what the folder knows (landed)

The only way the extension can learn that a page became a note is localmd
saying so. It now does, in the ack: `ack_inbox {ids, written:[{id, path}]}`
names the file each clip became, and the extension keeps page URL → note path
in `chrome.storage.local` (`src/localmd-connect/kb-index.ts`), keyed by the
clip's canonical URL when it had one and with the fragment dropped — the same
article reached through two tracking links is one note.

What that buys, in order of how often it is seen: the toolbar icon says
**KB** on a page localmd has already written down — a per-TAB badge, where the
pending count is global, so Chrome shows the mark on a saved page and the count
everywhere else. They competed at first, pending winning, which meant a single
stuck item hid the mark on every page for as long as it sat there;
the popup names the note; and `clip_page` reports `already_in_kb` so the agent
can decide against a second note instead of writing one.

It is a CACHE of localmd's answer, not a record anyone maintains. A note that
is later moved or deleted leaves a stale entry, and the worst that does is a
badge that is wrong until the next clip of that page corrects it — nothing in
the KB depends on it, which is the test localmd's own rules put on state like
this. localmd has no URL that opens a file, so the popup names the note rather
than linking it; a deep link is the obvious next step and belongs on that side.

### 14.4h A PDF in a tab becomes the file in `raw/papers/` (landed)

Chrome's PDF viewer is a plugin with nothing to walk, and a paper is worth more
to a knowledge base as the file it is than as any text scraped out of it —
localmd indexes PDFs and cites into them by block. So `clip_page` (and the
context menu's Clip page) on a PDF tab fetches the bytes with the user's cookies
— a paper behind an institutional login comes through — and hands over
`{kind:"pdf", data, size, title, url}`; localmd's drain writes it through
`importFile`, which files a `.pdf` under `raw/papers/` in a raw-layout folder.

Recognition: the path (`.pdf`, or arXiv's `/pdf/` segment) first, else a HEAD
for `application/pdf` with a short timeout — a server that refuses HEAD is not
thereby a PDF. The bytes are checked for the `%PDF-` signature, because a login
page served as 200 is the common way this goes wrong. Size is bounded by the
16MB outbound frame (§14.2) at ~12MB, and a larger file fails with a message
rather than arriving cut in half.

### 14.4i Two more gestures into today's page (landed)

**Jot this page** (context menu, popup) puts one line into localmd's daily
capture page: the page as a link, plus whatever was selected. **Save open
tabs** (popup) puts the window's http(s) tabs there as a list — a reading
session, kept. Both are inbox kinds (`jot`, `tabs`) that localmd's drain
appends with its own `jotToday`, which is the point: the daily page is
already the folder's zero-friction intake — filing by date is what makes a
passing thought reach the folder at all — so neither needed a note shape of
its own. localmd's own tab is left out of a saved session; it is the one page
that was not being read.

### 14.4n The popup answers "which folder, and where are my marks" (2026-09-04)

Four changes from one round of use, all of them about the popup being the
browser's window onto a folder it cannot see.

- **It names the knowledge base**, and offers the others. Every button in it
  writes into a folder, and a capture that went somewhere other than the user
  pictured is only discovered later. The list is mirrored from localmd
  (`sync_kb_folders` — its recents plus the open one, pushed on connect and
  whenever either changes); picking another sends
  `notifications/localmd/open-kb {name}` and focuses localmd. It CANNOT be done
  here: a File System Access handle belongs to the page it was granted to, and
  a lapsed grant needs a user gesture in that page. So the popup asks, localmd
  decides, and the name shown is always what IS open rather than what was
  requested — corrected by the sync that follows.
  The picker is a menu that FLOATS over what follows (`position: absolute`),
  not one that pushes it down: the popup has no room to grow, so a list that
  moved the page would move the button the user was about to press, and with
  four folders would push it out of the window. It closes on a pick, on a click
  anywhere else, and on Escape. Picking does not navigate anywhere — the switch
  happens in localmd's background tab and the name above updates when its next
  sync lands, so the confirmation appears where the request was made.
- **A way to localmd**, in the header: the open tab if there is one, a new one
  if not (`ensureLocalmdTab`, the same resolution "Ask localmd" uses).
- **Annotations are reachable and addressable.** The popup could say "3
  highlights on this page" and not answer "which, and where". The count is now
  a button, and the footer has a way in; both open the settings page's
  Annotations section (`?page=` scrolls to that page's group). Clicking a
  passage opens its page and scrolls to the mark — the request is left in
  storage (`hlFocus`) because the tab does not exist yet, and the content
  script consumes it after re-anchoring; a tab that is already open gets a
  message instead, since its highlights were restored long ago. The flash is a
  Web Animation on the mark, so there is no stylesheet to inject and nothing
  left behind if the page navigates mid-animation.
- **Clip and Ask share a row**, sized 2:1, with the two screenshot gestures
  below, icon-left like the two above them. Clip is why the popup is open; Ask
  is the other whole-page gesture; the screenshots are variants of one thing.

An extension page is opened by the path the MANIFEST declares, never a
hand-written one: the bundler emits these at their source path
(`src/localmd-connect/options.html`), so `getURL('options.html')` is a URL that
has never existed — and it fails as a blank tab with nothing in any console
(F-62).

A second round, from using it:

- **The page's own annotations are a menu in the popup**, not a link out. The
  count opens the passages themselves, each with its colour and note, and a
  click scrolls THIS tab to it (`LOCALMD_FOCUS_HIGHLIGHT` straight to the
  content script). The full list is still one row down, for everything that is
  not this page. `LOCALMD_PAGE_STATE` carries up to 50 of them.
- **The folder row says what it is** ("Knowledge base"), and the saved/not-saved
  chip moved onto the host line — the same thought as where the page is from,
  and a one-word answer does not deserve a line of its own. The note's path
  stays below.
- **Settings became two panes**: the topics on the left, one topic on the right,
  driven by the hash so Back works and the popup's deep link is the same
  mechanism rather than a special case. The nav is built FROM the sections, so
  adding one is an edit to the HTML alone; each carries the count its heading
  shows, and the dev-only CLI block hides its way in as well as itself.
- **A topic's header stays put while its list scrolls.** The search box was
  scrolling away from the results it filters. The pane is a flex column now:
  heading, explanation and search box hold their place, and only the list moves
  (`.scroller`, `flex: 0 1 auto` so an empty list takes no room and its "nothing
  yet" line stays under the search box rather than at the bottom of the window).
  Site headings stick inside the adapter list, so a long catalogue always says
  which site you are reading. Below 720px the whole page scrolls again.

  Two consequences of that pane worth knowing: it is **centred** in what the
  sidebar leaves (`margin-inline: auto`) rather than pinned to its edge, and a
  scrolling section CLIPS — so a full-width search box lost the left and right
  sides of its focus ring, top and bottom intact. Every clipping container now
  carries `padding-inline: 4px` with a matching negative margin, which is the
  width of the ring (`outline: 2px` at `outline-offset: 2px`) and moves
  nothing.
- **The adapter catalogue shows all of it**, grouped by site, with a real
  loading state — it is fetched over the network on first open, and a blank list
  reads as "no adapter covers any site", the opposite of the answer this section
  exists to give. The 40-row cap (and the "showing N of M" line that explained
  it) is gone: it was sized for a 328px popup list.

And two on the in-page bar:

- **A marked passage can be handed to localmd from the bar itself** ("Ask
  localmd", the same offer the selection toolbar makes). A highlight IS the
  passage the user wants to talk about, and re-selecting the text to reach the
  other bar was the only way to do it.
- **The reading tools stay out of localmd itself** — `DEFAULT_BLACKLIST`, a
  shipped list entry rather than a rule (revised 2026-09-05; it was
  `isLocalmdApp`, a hard-coded branch, for a day). The app is a text EDITOR: a
  selection there is an edit, and a toolbar on every selection is in the way of
  the thing this extension exists to serve. But that is a good DEFAULT, not a
  law — expressed as data it is visible in the settings list, removable by
  anyone who disagrees, and one mechanism instead of two. Suffix-matched, so any
  subdomain is covered; the development app on another host is not, and is added
  like any other site. The relay, the popup and every capture tool were never
  affected either way.
- **The hover note does not show while a bar is up.** Two floating things over
  one passage is one too many, and the note landed on top of the buttons being
  reached for; the bar offers "Edit note" anyway.

Surface: 53 → 55 tools (`sync_kb_folders`, `get_kb_folders`).

### 14.4m The browser's index of the folder is revalidated, not assumed (2026-09-04)

`kb-index.ts` is what the toolbar badge, the popup and `clip_page`'s
`already_in_kb` read: page URL → note path, learned from `ack_inbox`'s
`written` pair and never corrected. A note deleted in the app left the popup
showing a green tick and a path that was gone (F-61).

The extension cannot see the folder, so the folder's app checks. Two tools —
`list_saved_pages` (the whole index) and `sync_saved_pages` (`forget` /
`moved`) — take the surface to 53; entries are still only created by
`ack_inbox`. localmd's `lib/connectSaved.ts` verifies each path with
`fs.exists`, and only when one is missing looks for a note declaring the same
`url:` in its frontmatter, so a note the agent MOVED stays saved rather than
being forgotten (the candidate is `exists`-checked too — the note cache can lag
the disk). It runs on connect, on delete/rename in the files store, and on
every return to the tab. The badge repaints from `chrome.storage.onChanged`, so
the tab in front of the user updates without a switch away and back.

### 14.4l The interaction pass (2026-09-03)

Eight changes from one round of real use, most of them about the difference
between a feature existing and a feature being usable.

- **Jot and Save-open-tabs removed.** They were cheap to build and neither
  earned its place next to four capture actions; the daily page is still
  reachable from localmd itself.
- **`screenshot_page`** — the whole page, scrolled and stitched, into the
  inbox. It calls the registered `generic__screenshot` adapter's func directly
  rather than going through the executor: the executor paces every non-`local`
  call by seconds to look human to a SITE, and there is no site being fooled
  when the user pressed a button.
- **Settings became their own page** (`options.html`, `options_ui`). Four
  collapsed sections inside a 328px popup meant every open showed a wall of
  things nobody was there to change. A settings page is read rarely and
  carefully; a popup is opened for one quick thing.
- **Icons** (`ui-icons.ts`, inline SVG — the pages run under a CSP that fetches
  nothing, and an icon set is a dependency with a version and a license for six
  glyphs). One primary action with its icon, three tiles with icon-over-label, a
  gear in the header. Dark mode via `prefers-color-scheme`.
- **The toast moved to bottom CENTRE** — the corner is where pages already put
  chat widgets, cookie bars and back-to-top buttons — and a working capture now
  draws a **breathing gradient border** around the viewport. A line of text at
  the bottom of a busy page is easy to miss; the whole window changing state is
  not.
- **Highlight swatches are circles** and cannot be squashed by the flex row.
- **Cancelling a note taken straight after highlighting removes the highlight
  too.** The mark was made in order to hold a note that was then abandoned;
  leaving it is litter the user has to clean up. Cancelling an EDIT of an
  existing note leaves it alone.
- **Hovering a noted highlight shows the note.** It is the reason the passage
  was marked, and it was reachable only by clicking through to an editor.

Notes live in `chrome.storage.local` beside the highlight (per page URL), and
reach the knowledge base in the clip's sidecar (§14.4c).

Both pages are now covered by tests that LOAD THE REAL HTML AND RUN THE REAL
SCRIPT (`tests/localmd-popup.test.ts`, `tests/localmd-options.test.ts`) — see
F-56 for why a screenshot of a popup proves nothing about a popup.

**Two more from the same round, both about scripts that were registered but not
running.** `registerContentScripts` reaches only FUTURE navigations, so an
install or update left every open tab with an orphaned relay and captures that
appeared only after a manual refresh; the service worker now re-injects
`web-relay.js` and `page-tools.js` into open tabs on `onInstalled`, behind
re-entry guards (findings F-57). The guard added for that placed a call above
the `const` it depended on — a TDZ error under ESM, but the bundler lowers
`const` to `var`, so the shipped relay ran with `EXT_ID === undefined`, marked
the page `"undefined"`, and dropped every frame localmd sent as addressed to
another install. Clip, screenshots and asks died together and a refresh could
not revive them (findings F-58). The relay is now the third script with a test
that RUNS it (`tests/localmd-web-relay.test.ts`): nothing imported it before, so
nothing could have noticed.

**And one more behind that.** With the relay healthy, captures still did not
arrive: three full-page PNG screenshots were 25 MB in one `list_inbox` reply,
the worker truncated it to fit its 16 MB frame, and localmd read the non-JSON
remainder as an empty inbox (findings F-59). `list_inbox` now batches by bytes
(`pickInboxBatch`, always at least one item, an undeliverable item flagged
`oversized`), a whole page is captured as WebP rather than PNG, and localmd
treats a non-JSON reply as the failure it is.

What the flood that followed looked like, and what it was, is F-60: not
duplication but delayed delivery; a clip's pictures filed beside the note with
link destinations CommonMark does not parse (now `raw/images/`, encoded); and
two queue behaviours fixed on the localmd side — a drain is now rounds until
`pending` is 0, a poke mid-drain earns one more look, and two tabs of the app
take turns under a Web Lock instead of both writing everything.

### 14.4k The popup is about the page you are on (landed)

It had accreted into three things at once — an onboarding card, a settings
page and an action launcher — all visible on every open, 529 lines of it. A
returning user scrolled past an introduction to reach six equal-weight buttons.

Three layers now, in the order the question is actually asked:

1. **This page.** Title, host, whether the knowledge base already holds it (with
   the note's path and date), how many highlights are on it. One message
   answers all of that — `LOCALMD_PAGE_STATE` — because the popup wants all of
   it at once, every time.
2. **What to do with it.** One primary button (Clip this page), four small ones
   (Selection / Region / Jot / Ask), and — set apart, because it is about the
   WINDOW and not the page — Save this window's tabs. A page that cannot be
   captured disables the first five and says why, rather than failing on click.
3. **Settings**, behind one collapsed row that carries the status dot.
   Highlighting, browser data, site scripts, the adapter catalogue and the dev
   CLI section all live in there. The "Allow user scripts" warning stays
   OUTSIDE it, because a setting that is actually wrong is not a setting, it is
   a problem.

**A side panel was considered and rejected.** The full shell has one because it
hosts an agent conversation; here the conversation is localmd, and a persistent
panel would be a second window competing with the app it exists to serve. The
one thing a panel would add that a popup cannot — staying open while you read —
is what the in-page highlighter and its toolbar already give.

### 14.4j A capture leaves a receipt on the page (landed)

Only "Ask localmd" navigates; every other gesture deliberately leaves the user
where they are. With no feedback that is indistinguishable from nothing having
happened, and it was reported that way three times for captures that had in
fact worked — a region screenshot sitting in `raw/images/`, a jot already on
the daily page, a KB badge hidden behind an unrelated pending item.

So a capture now says so on the page it was made on: a working toast where the
work takes a moment (clipping), then a result toast that REPLACES it, or the
error. Injected per call rather than sent to the highlighter's content script,
because that script can be off or blacklisted and a receipt missing on some
pages is worse than none. A cancelled region capture takes the toast away
rather than announcing the cancellation.

### 14.4b Phases 4–5 (planned, in order)

- **Phase 3 — web highlights.** A runtime-registered `<all_urls>` content
  script (same `registerContentScripts` machinery as `web-relay.js`) with the
  selection toolbar + `src/selection/anchor.ts` re-anchoring; default on,
  popup blacklist. Highlights gain `color` + `note`. The extension store is
  the working copy, the KB the archive: each add/remove is an inbox event;
  localmd writes it to the clip's sidecar (extend its `annotations.ts`
  format with a `web` kind `{url, exact, prefix, suffix, color, note,
createdAt}`) so its AnnotationsViewer and `@` digest work unchanged.
  One-way; a KB-side delete does not reach the browser (v1, stated).
  `get_highlights` re-registers here (drop it from the surface test's
  exclusion list).
- ~~**In-page quick actions** (translate / explain a selection in place) would
  need the reverse LLM channel — MCP `sampling/createMessage`, which localmd's
  relay client does not handle — decided after real use, not before.~~ **Landed
  2026-09-04 — §14.4o.** Real use decided it: the bar could mark a passage and
  hand it to localmd, and the two things a reader most often wants from a
  passage (what does this say, what does this mean) were the two it could not
  do. (Phase 5, the KB-aware browser, landed — §14.4g.)

(The PDF case landed — §14.4h; the tab-session and jot gestures — §14.4i.)

### 14.4o Translate / Explain on the bar — the extension asks localmd (2026-09-04)

The selection bar could mark a passage, note it, clip it and hand it to
localmd. What it could not do is the two things a reader most often wants from
a passage they stopped on: **what does this say** (it is in another language)
and **what does this mean**. Both are one bounded completion over the selected
text, which is precisely what the full shell's toolbar has always offered — and
precisely what this shell had no way to run, because it holds no API key and
runs no model.

It does not need one. There is a localmd on the other end of the relay with a
model already configured and a bill already being paid, and MCP has a direction
for exactly this that this integration had never used: **`sampling/createMessage`**,
the SERVER asking the CLIENT to run a completion. One place holds the key.

#### What moved

**`src/core/external-mcp-core.ts` — the transport learns to ask.**
`handleExternalConnect.request(method, params, timeoutMs)` posts a
server→client request to the most recently handshaken port (where `broadcast`
addresses them all: a request needs exactly ONE answer, and with two app tabs
open the freshest is the one the user most recently had in front of them) and
resolves on the reply. Pending requests are rejected when that port
disconnects, so a recycled service worker fails the caller instead of leaving
the page's popover thinking forever.

Its ids are STRINGS (`srv-1`, …) where every client id is a number, which is
not cosmetic — see the fix below.

**The fix that had to come with it.** `handleRpcMessage` used to answer any
frame it could not parse with an error carrying that frame's id. A REPLY has no
`method`, so every reply to one of our own requests tripped that guard and
posted an error back — carrying an id from OUR id space, which the page then
matches against its OWN pending calls. That is a reply delivered to the wrong
caller. Now a frame with an id and a `result`/`error` and no `method` is
recognised as an answer before any guard runs: routed to the waiting caller, or
DROPPED when nobody is waiting (a response is never responded to). String ids
make the collision unrepresentable on top of that.

This was not theoretical. Measured on the live browser against the build that
predates the fix: posting a reply frame into the relay came straight back as
`{"error":{"code":-32600,"message":"not a valid JSON-RPC 2.0 request"},"id":"probe-2"}`.
With a string id the page drops it; with the number id both sides would
otherwise have used, it would have resolved somebody's tool call.

**`src/localmd-connect/ask-model.ts` — the question, and the wake.** Builds the
sampling params, reads the text out of the result (the spec's single content
block, and the array shape clients also send), and — the part that is the
feature rather than plumbing — **opens localmd in the background and asks again
when nobody was listening**. The relay only exists inside a localmd tab, so for
somebody reading an article the normal state is no connection at all. Clips
already answer that by opening the app in the background; a quick action does
the same and then waits for the handshake (`onClientReady`, event-driven, not
polled). First action of a session costs a second; the rest cost nothing. A
failure that opening a tab cannot fix (no model configured) is NOT retried.

**`src/localmd-connect/page-tools.ts` — the bar and the answer.** The actions
sit between the colours and Note/Clip/Ask: the colours mark the passage, these
two make sense OF it, the rest put it somewhere. The answer opens in a popover
anchored to the passage, with Copy and Close; it survives scrolling (reading a
long explanation while scrolling the article under it is the normal way to use
one) and goes on a click elsewhere or Esc. Its anchor is stored in PAGE
coordinates, because the answer arrives seconds later and re-placing the grown
popover against a stale viewport rect would fling it somewhere unrelated.

**Dragging it says "keep it".** The popover moves by its header, clamped to the
window so it cannot be put somewhere it can no longer be closed. A panel that
has been moved stops closing on a click elsewhere — dragging it clear of the
passage and then clicking back into the article would otherwise throw away the
room the reader just made — and stops being re-anchored when the answer lands,
which is the same promise a moment earlier. ✕ and Esc still close it, so there
is no pin to explain. (The full shell's toolbar reached the same conclusion by
a visible pin button; one panel at a time needs less.)

**Which localmd answers is the BUILD's question, not the browser's.**
`request()` takes an `origins` filter and the service worker passes
`LOCALMD_APP_ORIGINS`. Without it "the most recently handshaken port" would have
sent a dev build's question to the published app, because the dev
`ALLOWED_ORIGINS` admits `https://localmd.app` too (so the published app can be
driven while testing). That is the third time this exact shape has been
available to get wrong — the comment above `LOCALMD_APP_ORIGINS` narrates the
first two — and the rule that keeps coming out of it is: **a build knows which
app it belongs to; never infer it from what the user happens to have open.**
`broadcast` (the inbox poke, the open-KB request) is still unfiltered, which is
the same asymmetry one layer over: in a DEV build with a production tab open,
that tab can drain a capture into the production knowledge base. Known, not
fixed here.

**`localmd/src/lib/connectRelay.ts` — the client learns to be asked.**
`onFrame` read `notifications/` and then looked every other id up in its pending
map, so a server REQUEST was silently dropped. It now reads `m.method` FIRST:
a method means the far side is talking to us, not answering us. That ordering is
load-bearing — both directions number their requests from 1, so an incoming
request id would otherwise have been matched against our own pending calls.
`initialize` declares `capabilities: { sampling: {} }`; a request with no
handler is refused with -32601 rather than dropped, so the extension's caller
fails immediately instead of sitting out its timeout.

**`localmd/src/lib/connectSampling.ts` — the answer.** `generateText` on the
primary profile: no tools, no session, no history, nothing written. The same
one-shot shape as `agent/summarize`. Bounded on the way in (prompt chars,
maxTokens ceiling, timeout) because the params are shaped by another codebase.

#### Two decisions worth keeping

**The recipes are DATA, not two code branches.** `DEFAULT_PAGE_ACTIONS` is the
full shell's `DEFAULT_SEL_ACTIONS` minus Summarize, and the prompt itself lives
in `src/selection/prompt.ts`, shared by both shells' service workers. The two
differ in WHO answers, never in what "translate this" means. Adding a third
action is a row in a list; making them user-editable is an options-page form
over a field that already exists and already merges.

**Consent is the press.** MCP asks a client to keep a human in the loop for
sampling. The human is in it: the request is only reachable from an extension
they installed, on an origin they authorised, and is only ever sent because they
pressed a button on a page they are looking at. A confirmation in a background
tab would arrive after the thing it is meant to gate. What the app does instead
is BOUND the request.

#### What the first day of real use found (2026-09-05)

Pressing Translate right after an extension reload, without touching the
localmd tab first, failed every time with *"localmd opened but did not connect
in time"* — against a tab that was open and whose relay was, when measured,
answering pings. The transport heals itself after a reload (the service worker
re-injects the relay into open tabs); the APP does not notice, because a client
is what starts an MCP conversation and the only thing that re-probed a failed
row was a focus event. A background tab gets none. Full post-mortem:
[F-65](./tests/findings.md).

Both halves now use the signal the relay was already sending. It posts
`{ready:true}` on every attach; localmd listens for it and reconnects a Connect
row that is in `error`, and the extension — when its wake finds a tab that was
ALREADY open — injects one `postMessage` of that same frame before waiting.
Injected rather than sent, because the whole problem is that there is no port to
send on. An app too old to listen ignores it, and the wait then ends in a
message that names the manual fix rather than blaming the clock.

The general form, worth keeping: **a self-healing transport is not a
self-healing connection**, and **"the tab exists" is not "the app is
listening"** — `ensureLocalmdTab` answers a question about Chrome, so every
caller that then waits on the APP has to provoke it or say what it wanted.

#### Verified (2026-09-04, dev build + daemon 9378)

The localmd half end to end on the real browser, by posting an extension-shaped
frame into the dev app at `localhost:5173` from the USER_SCRIPT world
(`preview_site_script {dry_run_js}`, the probe pattern §14.4l settled on):

- `sampling/createMessage` → `{"role":"assistant","content":{"type":"text","text":"The weather is very nice today."},"model":"deepseek-v4-flash","stopReason":"endTurn"}` —
  a real completion on the configured profile, in the MCP result shape.
- an unsupported method → `-32603 roots/list is not supported`, so a mistake
  comes back as an error rather than as silence.
- the pre-fix echo quoted above.

The extension half — the bar, the popover, the drag, and the background wake
against a localmd nobody had touched since the reload — was confirmed by the
user on the real browser (2026-09-04 for the first three, 2026-09-05 after
F-65). Exercising it needs an extension RELOAD plus a page refresh: the content
script's re-entry guard means a reload does not replace the script in an
already-open tab (F-63's lesson). Tracked in `docs/tests/platform.md` §7e.

### 14.4p Prompts — the toolbar's asks become the user's (2026-09-05)

§14.4o shipped Translate and Explain as two buttons with two hard-coded
prompts. Real use asked the obvious next question: what about the third thing,
and the fourth. A prompt is data, so the answer is an editor, not a release.

**On the name.** They were "quick asks" for a day, which collided with the
other entry — the popup's whole-page **Ask** — in exactly the way the split
below was meant to prevent. They are now **Prompts**, which names the thing you
create and edit (the editor's two fields are a name and a prompt), and the
whole-page entry is **Chat**. The bar reads: the wand runs a Prompt, the bubble
starts a Chat. The internal capture action stays `ask_page` / `ask_selection`
and the inbox kind stays `"ask"` — those are the contract localmd reads
(§14.5), and renaming a label is not a reason to renumber a protocol.

**Two entries, not one.** The bar had grown two ways of asking about a passage
that end in different places, and one of them said so only in a tooltip. They
are now separate: a **wand** opens the list of prompts and runs one HERE, answering in a
popover; a **speech bubble** takes the passage to localmd to keep talking. Same
passage, two destinations, and the destination is the choice.

**One button and a list, not one button per prompt.** The set is the user's to
grow now. A toolbar that got wider every time somebody wrote a prompt would end
up covering the paragraph it is about.

**Running one says so on the passage, not only in the popover.** The bar goes,
the popover opens loading, and the passage itself lights up with a sweep while
the model is working. The mark then STAYS — three states on one set of boxes
(steady while the popover is open, a sweep while the model is busy, deeper
while the quote is hovered), toggled by class rather than rebuilt, so nothing
flashes where the eye already is. It used to go out the moment the answer
arrived, which is the moment you start comparing the two. Drawn as absolutely-positioned boxes over the page's line
boxes (`Range.getClientRects`, kept in PAGE coordinates at capture time),
because a transient effect must not wrap anything in the page's own DOM the way
a real highlight does — and because a Range does not survive the click that
dismissed the bar.

**And the popover keeps the passage.** A one-line quote under the title, with
the full text in its tooltip. The sweep is gone by the time the answer arrives,
and comparing a translation against its original is exactly then; hovering that
line lights the passage up again, steady rather than sweeping, and CLICKING it
scrolls there — an answer read long enough is an answer whose passage has
scrolled away, and hovering can only point at something still on screen.

The open-ended prompt marks the passage as soon as its box opens, not only once
the question is sent — the selection has just been released, so without it
nothing on the page says what the box is about.

**A pin, and a drag that pins.** The popover can be pinned from its header;
dragging it pins it too, because moving something is already saying you want to
keep it. Pinned means it survives a click on the page and is not re-anchored
when the answer changes its height.

**The last ten answers are remembered** (`localmd-connect/prompt-cache.ts`),
keyed on the FILLED prompt — template, passage and output language already
combined. That separates one saved prompt from another for free, and any change
to any of them misses without anyone having to remember to put it in a key. Ten,
not a history: this is for the "wait, what did that say" of the last few
minutes; an answer worth keeping is a clip, not a cache. A cached answer says so
with a tag on the popover, and clicking that tag asks again — a cache nobody can
see past is a cache that eventually lies, since the model in localmd can change
under an unchanged prompt.

**"Continue in localmd"** is the door out of the popover, on the answer itself.
localmd's draft ends with a `---` rule, so the cursor lands below what the
browser brought rather than somewhere inside a wall of text that is not the
reader's.
It goes where the toolbar's speech bubble goes, but carries what has already
been said: the passage, the prompt that was run on it, and the answer. The
popover answers one question well and is deliberately not a chat — so the exit
from it should not make the reader re-explain what they just read. Carried as
two OPTIONAL fields on the `ask` inbox payload (`prompt`, `answer`), rendered by
localmd's `askDraft`; an older app ignores them and opens with the passage
alone, which is what it did before.

Running a prompt also **releases the selection**. Not tidiness: the mouseup that
ends the click lands on the page, because the menu button was removed on
mousedown — and the document's mouseup handler is the one that raises the
toolbar, so it came straight back on top of the answer ([F-66](./tests/findings.md)).

**Icons past the colours.** Five text labels across someone's own paragraph is
wider than most of the sentences it would sit over. The words moved into
`title`, where they still read to a screen reader and to anyone who hovers. The
quick-ask glyph is a single four-point star: the first attempt was a wand plus
two little sparkle crosses, which at 16px is four hairlines meeting at a point
and reads as two plus signs beside a diagonal. One closed shape has one
silhouette and survives the size.

#### The template contract

A saved prompt is a **name and a template** — nothing else, because every field the
editor asks for is a field somebody has to have an opinion about before they can
have their fifteen-second win. Two variables carry what the prompt cannot say:

- `${content}` — the passage. **If the template never mentions it, the passage
  is appended at the end in triple quotes.** That rule is not a nicety: most
  prompts people write are pure instructions ("summarise this in three
  bullets"), and a tool that sent those with nothing attached would look broken
  for the commonest thing anyone types. `${input}` is accepted as an alias
  because several other tools call it that, and a pasted prompt should work.
- `${lang}` — the output language, from one setting, so one prompt serves every
  language. Free text: "formal Japanese" is a fine answer and no dropdown would
  have it. Empty follows the browser's own language (`resolveLang`), so someone
  who never opens Settings still gets a sensible Translate.

**An empty prompt is the general one, not a broken one.** The page asks
for the instruction when you use it, and what you type becomes the TEMPLATE —
same engine, template written later. So a typed question gets the variables and
the append-in-triple-quotes rule exactly as a saved one does, and no code path
knows about a special case. The third default (`Ask…`) is simply an entry with
no prompt; clearing any ask's prompt in the editor makes it behave the same way.

That is also the honest answer to "what about the fourth thing I want to ask":
do it the long way, and promote it to a saved ask when it turns out to recur.
The alternative — shipping a fourth, fifth and sixth preset — guesses at what
somebody reads.

Substitution order is load-bearing: `${lang}` is filled first, so a passage that
happens to contain the text `${lang}` is not treated as a variable. The passage
is data.

The filling happens in the CONTENT SCRIPT (`fillPromptTemplate`), where the
template, the passage and the language already are — and the filled string is
then the WHOLE message, sent verbatim. Nothing downstream re-frames it, which
is what makes the help's promise true; `ask-model.ts` says so where somebody
might otherwise add a helpful line of context.

#### What is switchable, and why there are three switches

- **Each prompt** has an `on`. Switching one off KEEPS it — a definition you
  wrote and are not using this month is not a definition you want to retype.
- **The toolbar itself** (`bar`). Someone can want their highlights to come
  back on a revisit and not want a bar over every sentence they select. Turning
  it off leaves the rest alone: marks still restore, and clicking one still
  opens its own bar.
- **The whole in-page feature** (`enabled`), as before.

With no ask switched on, the wand does not appear at all — there is no menu to
open.

#### The settings page

- **The highlights list can edit and delete what it shows.** A note was
  readable here and editable only by going back to the page and clicking the
  mark; it edits in place now, beside the passage that gives it its meaning.
  Each row also removes itself. **Both removals ask first**, in the page's OWN
  dialog rather than `window.confirm` — that one is a different typeface, a
  different button order and a bar naming the page's URL, so it reads as the
  browser interrupting rather than as this page asking, and it cannot show the
  passage it is about to remove. These are the user's own annotations and
  nothing brings them back, so the question names what is going: how many and
  on which page, or the passage itself. The SAFE button takes focus, and
  Escape and the backdrop both cancel — every quick way out leads away from the
  destructive thing. Deleting a site script, the other irreversible act on this
  page, uses the same dialog.
- **The list follows the pages.** A `storage.onChanged` listener rebuilds it
  when a `selHl:` key changes, which is the missing half of a symmetry the
  content script already had (a mark removed here stops being painted on an
  open tab). A list of annotations that goes stale the moment you highlight
  something is a list you stop trusting. Deferred, not skipped, while a note
  editor is open: losing what somebody is typing to show them a row they did
  not ask about is a bad trade.
- **Highlights is one section, not two.** Annotations (your content) and
  Highlighting (four switches that produce it) were two nav entries for one
  feature, which reads as two features. Merged, with the shape that keeps the
  list the first thing you see: the switches on one line above it, the
  stay-off list — the bulky, rarely-touched half — folded, then the search box
  and the highlights themselves.

- A **Prompts** section: the language, the list (toggle, name, the prompt
  itself as the subtitle), and an editor with the help beside it rather than
  behind a link — the question "what can I put in here" arrives at the same
  moment as the box. The language box is free text with its own list behind a
  caret. It was a `<datalist>` first, which is the obvious control and the
  wrong one twice over: it draws no arrow until the field has focus, so nothing
  said the suggestions were there — and it FILTERS its options by what is
  already typed, so with a language in the box it opened empty, which reads as
  broken. Chrome also draws its own arrow for one, next to ours. Written out,
  the list always shows everything and marks the current answer.
- **Highlighting** gained the two settings that existed in the model and
  nowhere in the UI: the default colour (shown as the colours, since a dropdown
  reading "yellow" is a worse way to pick yellow) and the toolbar switch.
- **The nav moved to the middle with the pane it drives.** It was pinned to the
  window's left edge while the content was centred in what was left, so on a
  wide screen the two halves of one control surface sat at opposite ends of the
  glass.
- Every list is the same card now. The blacklist rows were `.script`, a class
  with no CSS anywhere on the page, so they had been rendering as bare text and
  a default browser button since the settings moved out of the popup.
- The sidebar shows the two products' own marks — localmd Connect's at the top,
  localmd's beside the link to the app at the bottom — rather than a gear in a
  coloured box. This page is the one place the extension introduces itself, and
  the link at the bottom goes somewhere else, which the mark now says.
  (`public/icons/localmd-app.svg` is localmd's `public/icon.svg`, copied: the
  page runs under a CSP that fetches nothing.)

Settings are re-`mergePageTools`'d on arrival: the message crosses a process
boundary, and during an extension update the worker on the other side can be a
version whose settings object has a field fewer than this page reads.

**Verified**: the page itself, in a browser — the built bundle served over
localhost with a stubbed `chrome`, and screenshotted (`docs/tests/platform.md`
§7f). That is how the three layout defects above were found; none of them shows
up in jsdom, where every box is the right size because no box has a size.

### 14.5 What localmd owes the contract (client-side checklist)

**Implemented on the `feat/connect-capture` branch of `~/code/localmd`**
(2026-09-04, 1481 tests green, verified end to end on a real machine — §14.7):
`lib/clip.ts` writes a clip into the KB, `lib/connectInbox.ts` drains the queue,
`McpRelayClient` hands notifications to the store instead of dropping them,
`clientFor` binds the drain to the Connect row, `lib/connectSaved.ts`
revalidates the browser's index of the folder and `lib/connectKb.ts` mirrors
which folder is open. **Every item below is done**, item 3 included — the image
sink writes a tool's image into `.tmp/` and hands the model its path.

The deltas, for the record (its `connectRelay.ts` header is that repo's
contract doc):

1. **Handle `notifications/localmd/inbox {count}`.** Today
   `McpRelayClient` drops every `notifications/*` frame. On it (and on
   connect), call `list_inbox`; render each item as a card the user can
   accept; `ack_inbox` after writing. No id on the frame — never reply.
2. **Write the clip note.** The extension returns data; localmd decides the
   path (`landingPathFor` → `raw/articles/` in a raw-layout KB, `inbox/`
   otherwise — the user's structure is not rearranged without asking) and
   the frontmatter. Proposed convention, in the house style: `type: source`,
   `title`, `url` (canonical when present), `site`, `author`, `published`,
   `clipped` (ISO), `tags`; body = the Markdown; `mode:"selection"` adds a
   `> quote` block and keeps `{exact, prefix, suffix}` in frontmatter under
   `anchor:` for citing back. Inlined images become files where the folder
   files pictures — `raw/images/` in a raw layout, the inbox beside the note
   otherwise — named after the note, and the Markdown's `![](https://…)` is
   rewritten to a relative, ENCODED destination (spaces and parentheses break
   a bare CommonMark link; F-60).
3. **Keep MCP image blocks** (landed). `flattenToolResult` (`lib/mcp.ts`) no
   longer collapses `{type:'image'}` to `[image image/png]`: an `ImageSink`
   writes the bytes into `.tmp/` and the model is handed the path, the way
   `view_image` already works. Without a folder open the sink returns null and
   the result says the image could not be shown rather than pretending.
4. **`ask` items.** Focus the composer, attach the item's `tabId` as a tab
   chip (existing `@` machinery — the page is read live, not from the clip),
   quote `payload.selection` if present, ack.
5. **Doctrine wording** (clarified 2026-09-03): the agent may reorganize the
   KB — after asking. It does not change the user's existing structure on
   its own initiative, but proposing a move and doing it on consent is in
   bounds. Clip-note placement follows the same rule.
6. Prompt copy: `clip_page` for "save this page", `format:"markdown"` when
   links matter, the inbox loop.
7. **The inbox loop is bounded by bytes, not only by count** (added after
   F-59). One `list_inbox` reply carries at most ~12 MB of items; `pending`
   says how many remain, so keep draining until it is 0 — the extension pokes
   again after every ack, which makes that automatic. An item flagged
   `oversized: true` arrives without its payload and cannot be delivered:
   ack it (and say so), do not retry it. A reply that is not JSON is a
   FAILURE — never read it as an empty inbox; that reading is how eight
   captures once sat behind a green row.
8. **Answer `sampling/createMessage`** (landed 2026-09-04, §14.4o). The
   extension holds no API key: its in-page Translate / Explain are one bounded
   completion run HERE, on the primary profile. `McpRelayClient` reads
   `m.method` before its pending map (a request is not a reply — and both
   directions number from 1), `initialize` declares
   `capabilities: { sampling: {} }`, and `lib/connectSampling` bounds the
   prompt, the token ceiling and the timeout. Errors go back as JSON-RPC
   errors: the extension shows the message in a popover on the page, so
   "no model is configured" must READ like something a person on a web page
   can act on.
9. **An `ask` may carry `prompt` and `answer`** (added 2026-09-05). Both
   optional: they are set when the reader pressed "Continue in localmd" on an
   in-page answer rather than sending a bare passage. `askDraft` renders the
   answer under the quote so the conversation starts where they already are.
   Ignoring them is a correct older implementation, not a bug.
10. **Reconnect on the relay's `ready:true` frame** (landed 2026-09-05, F-65).
   The extension's service worker re-injects the relay into open tabs after it
   is reloaded or updated, so the TRANSPORT comes back on its own — but only a
   client can start an MCP conversation, and a background tab never gets the
   focus event that used to be the only thing re-probing a failed row. Listen
   for the frame (`isRelayReadyFrame`) and reconnect rows whose status is
   `error`; `connecting` is a handshake already in flight and must be left
   alone. Without this, everything the extension wants to ASK — today the
   in-page quick actions — fails against a tab that is open and healthy.

### 14.6 How the extractor is verified — a real-page corpus

Hand-written fixtures prove the walker implements the rule; they cannot prove
the rule is right (F-51). For any change that decides what content to DROP, the
acceptance test is a corpus of real pages compared against the pre-change
behaviour, reporting what was lost line by line:

```bash
# 1. fetch a few real pages (server-rendered ones need no browser)
curl -s -x http://127.0.0.1:7890 -A "Mozilla/5.0" "<url>" -o /tmp/corpus-<n>.html
# 2. run BOTH behaviours over each, offline, through the mini DOM:
#      before = querySelector('main, article, [role=main]') ?? 'body', no pick
#      after  = extractPageMarkdown(max, null, doc)
#    and print every substantial line present in `before` and absent from `after`
npx vite-node /tmp/corpus.mjs
```

Pick pages that differ in SHAPE, not in topic: one with a semantic root and long
prose (Wikipedia), one whose `<main>` holds a long list beside a short intro
(MDN — the shape that broke it), one where `<main>` is mostly app chrome
(GitHub), one with no semantic markup at all (Hacker News, table layout). The
rendered DOM of a JS-built page can be captured for the same offline loop with
`get_html {tab_id, max_chars}` — no rebuild needed between iterations.

### 14.7 Verification status

- `npm run check`: typecheck ✅, the affected suites ✅
  (`localmd-tool-surface` 39-pin, `localmd-capture`, `external-mcp-notify`,
  `generic-extract-markdown` incl. the density cases, `mini-dom-parity`,
  `generic-fetch-url`, `external-mcp`); full vitest ✅. Lint: no new errors
  (two pre-existing ones in `_mini-dom.ts` / a test helper are untouched).
- `npm run build:localmd:dev` ✅ — manifest carries `contextMenus` + the two
  commands; the SW bundle carries the notification.
  **Real-machine pass, driven over the dev daemon (`BRIDGE_PORT=9378`), 2026-09-03:**

| check                                                         | result                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalog                                                       | ✅ 39 tools; `generic__clip_page` / `list_inbox` / `ack_inbox` present                                                                                                                                                                                                      |
| `clip_page` article mode (`clip-article.html`)                | ✅ og:title beat `<title>`; canonical/site/author/description/lang; `published` from a meta tag and `modified` from JSON-LD; nav/header/footer/sidebar/comments/`[hidden]` all dropped; relative link absolutized, absolute one untouched; `data-src` lazy image swapped in |
| `images:"inline"`                                             | ✅ 74-byte PNG fetched and base64'd, `mime`/`bytes`/`dataUrl` set                                                                                                                                                                                                           |
| `mode:"full"`                                                 | ✅ nav/header/footer dropped by the tag filter, sidebar + comments kept (the pick is skipped)                                                                                                                                                                               |
| `mode:"selection"` (`clip-select.html`, auto-selects on load) | ✅ heading + body Markdown, link absolutized, `{exact, prefix, suffix}` anchor, tab left open                                                                                                                                                                               |
| `list_inbox` / `ack_inbox`                                    | ✅ empty listing; ack of an unknown id is a no-op (`removed:0`)                                                                                                                                                                                                             |
| relay handshake + broadcast audience (`relay-client.html`)    | ✅ marker `enodec…`, `initialize`, 39 tools, a live `tools/call`; the fixture now sends `notifications/initialized` and records inbound notifications                                                                                                                       |
| cold vs warm cost                                             | ✅ first call after the 10s idle sweep ~8–10s (agent window rebuilt), warm 1.4–2.7s — same as `get_page_text` on the same page                                                                                                                                              |
| extractor corpus (§14.6)                                      | ✅ after the F-51 fix: MDN / Wikipedia / GitHub 100% of the pre-change output, HN drops only chrome                                                                                                                                                                         |

**Phase 2, on real data (2026-09-03).** All four permissions granted from the
popup, then driven over the dev daemon:

| check                      | observed                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ungranted                  | ✅ all four gates fail (`ok:false`) with `permission_required: <perm>` and the popup switch named — never an empty list                                        |
| `list_bookmarks` tree walk | ✅ the two real roots with child counts, no bookmarks at the top level; descending into one pages 40 children 5 at a time (`o5` → `o10`)                       |
| `search_bookmarks`         | ✅ 505 hits, newest first, containing folder resolved, folder rows excluded                                                                                    |
| `search_history` paging    | ✅ **after the F-53 fix**: 4 pages × 5 rows, ZERO duplicates, and the walk is byte-identical to one 20-row page; the depth cap refuses `o1000`                 |
| `list_reading_list`        | ✅ 67 entries, read/unread flag, paging cursor                                                                                                                 |
| `list_recently_closed`     | ✅ closed tabs with kind / url / closed_at                                                                                                                     |
| writes (bookmarks)         | ✅ create → findable → delete → gone, with the deleted title/url/parent handed back as the undo; a folder id is refused by name                                |
| writes (reading list)      | ✅ add → unread → `set_reading_list_read` (still listed, hidden by `unread_only`) → remove → a second remove says it is not there. 67 entries before, 67 after |

**Phases 3b–5 and the extras, on real data (2026-09-03)**, driven over the dev
daemon:

| check                            | observed                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| element screenshot by `selector` | ✅ `.article` clipped to 900×408 (77 KB), `#nav` to 900×24 (7.8 KB) — the size gap is the clip doing its job |
| element screenshot by `ref`      | ✅ `r1` → 236×18, the link's own box                                                                         |
| its three refusals               | ✅ an iframe ref, a selector matching nothing, and `full_page` + a target — each with its reason             |
| PDF clip                         | ✅ `{kind:"pdf"}`, `%PDF-` signature, 585 bytes decoded and matching `size`, no `markdown` key               |
| a page URL is unaffected         | ✅ still a page clip with Markdown                                                                           |
| KB index, empty                  | ✅ `clip_page` omits `already_in_kb`; an ack naming an unknown item remembers nothing                        |

**Phase 3, on real data (2026-09-03)**, driven against a fixture that selects a
passage and dispatches the `mouseup` the highlighter listens for — a real user
selection being the one gesture the bridge cannot make:

| check                        | observed                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| toolbar on selection         | ✅ 5 swatches + Note / Clip / Ask localmd, all visible to `get_interactives` through the shadow root                            |
| highlight                    | ✅ stored with its colour; `<mark class="webagent-hl" data-hl-color="green">` in the page                                       |
| **re-anchor after a reload** | ✅ the mark comes back on the same words, colour intact                                                                         |
| clicking an existing mark    | ✅ its own bar (5 swatches + Note + Remove, no Clip/Ask); recolouring updates storage and the mark                              |
| note                         | ✅ textarea → Save → stored on the entry, and the mark gains `data-hl-note` (the underline)                                     |
| a second highlight           | ✅ two entries on one page, each with its own colour and anchor                                                                 |
| `clip_page`                  | ✅ carries both, with colour, note and `{exact, prefix, suffix}`                                                                |
| `delete_highlights`          | ✅ by id and whole-page; the mark disappears from the LIVE tab (the `storage.onChanged` listener), store empty                  |
| the blacklist                | ⏸ needs the popup — `chrome.permissions`-style user gestures, and the settings are the user's to change, so no tool writes them |

Two fixtures were added for this (`docs/tests/fixtures/clip-article.html`,
`clip-select.html`, plus `hero.png`), and `relay-client.html` gained the
notification-observing half.

**The gesture chain, walked by hand** (no tool can drive a context menu). The
user right-clicked a real article and chose **Clip page to localmd**, with
`relay-client.html` open and handshaken:

| step                                      | observed                                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gesture → inbox                           | ✅ one `clip` item, the real page's URL, title and `tabId`                                                                                                                                |
| payload quality on a page nobody prepared | ✅ canonical / author / published / description / site / lang / og:image all present; 12,666 chars of clean article Markdown; 6 links; 1 image inlined (17 KB), 0 failures; not truncated |
| broadcast to a connected page             | ✅ `#status` gained `notify:localmd/inbox:1`                                                                                                                                              |
| `ack_inbox`                               | ✅ `{removed:1, remaining:0}`, followed by `notify:localmd/inbox:0` (the badge clears the same way)                                                                                       |

Two extractor fixes were re-verified in the browser after the rebuild, on the
pages that had exposed them: MDN came back at 8,914 chars with the intro
present and 62 links (it had been 4,610 with the intro gone), and a Hacker News
item page yielded 17 links including the user and comment links (it had been
zero).

**The client half, end to end** (2026-09-03). With localmd's dev server on
`localhost:5173`, a folder open and the Connect row on, a second clip gesture
travelled the whole way by itself: extension → poke → localmd's relay client →
drain → a note on disk. The note landed at
`raw/articles/<title>.md` — the KB has a `raw/` tree, so the intake rule put it
there — 13 KB, frontmatter complete, one H1, the source line correct, tables
intact, and the page's picture saved beside it as a real PNG.

That last file was the one flaw: it was the page's `og:image`, which the note
never references, so the clip left an orphan in the folder. Fixed on the localmd
side (only pictures the Markdown shows are written); the extension keeps
reporting it, because which of a page's images becomes a file is a question
about the knowledge base, not about the page.

Finding the note took much longer than it should have, and the lesson is
findings F-52: `inbox/` was empty, so the drain was declared broken, and three
plausible theories about SW recycling, `onClientReady` and IndexedDB were chased
before `find` turned up the note in `raw/articles/`. Where a clip lands is a
CONDITIONAL in the code; verifying "it is not there" by checking one branch of
that conditional proves nothing.

Rendering that captured payload through localmd's own note writer produced a
correct note first time, and exposed two cosmetic bugs on the localmd side that
no fixture had: a second `# heading` when the page's Markdown already opened
with one (MDN), and `site · author` printed twice when a publication sets both
meta tags to its own name. Both fixed on the `feat/connect-capture` branch —
which is the argument for §14.6 in miniature: the shapes real pages take are
not the shapes you think to write down.

## 15. Site adapters and site scripts are experimental — adapters become data (2026-09-05 →)

> Decision of record. Both the marketplace of site adapters (`find_adapters` +
> `run_adapter`) and persistent site scripts are now labelled **experimental**
> in every human-facing surface of this shell and of localmd (popup section
> headings, localmd Settings → Tools copy, the user manual, the store listing
> source). The adapters are on their way OUT of this shell; the site scripts
> stay experimental until the same question is answered for them. Nothing is
> removed yet — see the phased plan at the end.

### 15.1 Why — the doctrine already says it

localmd's `AGENTS.md` states the principle this shell was built against and
then quietly violated: *tool code provides capability, never a particular
tool*; individual tools are **data** the user or the agent creates on top of
the machinery, and *a curated list is a promise that rots*. A catalogue of 294
hand-maintained site adapters, each pinned by a sha256 that must be rotated on
every edit and re-verified on a real browser (`docs/tests/adapters.md`: 175
passed / 22 to re-check / 35 never run at the time of writing), is exactly that
promise. §13 recorded "explore authoring stays full-shell-only; localmd users
consume the marketplace" as a deliberate v1 limit; this section reverses it.

The target is not "no adapters". It is: an adapter is something the agent
builds from generic primitives in one conversation and keeps as data the user
owns — readable, editable, travelling with the folder. When the candidate set
below reaches "one sentence → working adapter", the marketplace leaves this
shell and nothing is lost, because Connect never persisted a marketplace adapter
in the first place (loads are ephemeral, per session).

### 15.2 What the 294 adapters actually are

A survey of every source file in `marketplace/` (regex counts; a file can hit
several rows):

| technique                                                   | files |
| ----------------------------------------------------------- | ----: |
| `fetch(api, {credentials:'include'})` from inside the page  |   143 |
| tab-less `fetch` pipeline step (public API)                 |    37 |
| request header derived from page state (csrf / bearer)      |   ~65 |
| `querySelector` DOM scraping                                |   111 |
| framework state globals (`ytInitial*`, `__NEXT_DATA__`, …)  |    18 |
| `performance.getEntries` network sniffing                   |    18 |
| `AuthRequiredError` / hand-written login-wall text checks   | 138 / 105 |
| a per-site `shared.js` inlined (id parsing, URL building)   |   136 |
| `type: pipeline` / `type: func`                             | 77 / 217 |

Three conclusions. **Most of the catalogue is "call the site's own JSON API
with the user's cookies"** — no site-specific code is needed for that beyond
the URL and a shaping rule, and localmd's `HttpToolSpec` (`.agents/tools.json`,
`transport: extension` = this shell's `fetch_url`) already expresses it as
data. **The hard tail is knowledge, not tooling**: the largest files reverse a
signing scheme (xiaohongshu — the adapter itself gives up and demands a signed
URL), parse GraphQL queryIds out of JS bundles (twitter), or drive a player
until it leaks a token-bearing request (youtube, 39 KB). **Most of it is not
knowledge-base work at all**: twitter's 34 commands are half follow/block/list
writes, linkedin carries Sales Navigator messaging, instagram is social
actions — opencli's inheritance, not localmd's need. For a knowledge base the
adapter's value over `clip_page` + `fetch_url` is exactly three things:
structured lists (search results, a shelf), paginated collections (bookmarks,
history), and data that is not in the DOM (transcripts, private-API notes).

### 15.3 The measurement — candidates rebuilt with generic tools only

Method: the `localmd-dev` build driven over the port-9378 daemon, `find_adapters`
/ `run_adapter` forbidden, every other tool allowed. Each candidate was attempted
the way an agent would, and the blocker recorded when it failed. Priorities
came from the user mid-round: well-known international sites first; of the
Chinese ones Bilibili and Zhihu matter, WeRead (needs a key) and Xiaohongshu do
not; YouTube matters most.

| candidate                              | route that worked (or the blocker)                                                                                                    | verdict |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Hacker News top / item / search        | `fetch_url` on the public Firebase + Algolia APIs                                                                                     | ✅ |
| Reddit thread / search                 | `fetch_url` on the `.json` views, with cookies                                                                                        | ✅ |
| Zhihu hot / search / answer / question | `fetch_url` on `api/v4` with cookies — no `x-zse-96` needed from the SW                                                               | ✅ |
| Zhihu column article                   | `api/v4/articles` answers 403; the column page as `format:"markdown"` gives the full body (4.7 K chars)                              | ✅ |
| Bilibili video / search / comments / subtitles | `fetch_url` with cookies; `x/player/wbi/v2` returned 12 subtitle tracks and the JSON body **unsigned**                         | ✅ |
| Bilibili user videos (`space/wbi`)     | −403 without a `w_rid` signature → needs md5 in JS                                                                                    | ❌ |
| ChatGPT history / read                 | `api/auth/session` → bearer → `backend-api` — works, but the token passes through the model's context                                | ✅ (with a caveat) |
| Claude.ai history / read               | cookie-only `api/organizations/…/chat_conversations`                                                                                  | ✅ |
| Gemini recents / read                  | DOM: `list_links` for the recents, `query_dom` on `user-query, model-response` (12 turns); `get_page_text` alone sees almost nothing | ✅ |
| X single tweet                         | `cdn.syndication.twimg.com/tweet-result`, no cookies                                                                                  | ✅ |
| X thread / bookmarks                   | page-origin synchronous XHR to GraphQL (`ct0` from `document.cookie` + the public bearer + queryIds from the twitter-openapi placeholder file): 30 tweets / 7 bookmarks | ✅ with a hint |
| X bookmarks via DOM                    | readable, but a virtual list — needs a dedup-across-scrolls loop the agent cannot run in one call                                     | ⚠️ |
| YouTube transcript                     | every route failed — see 15.4; the real adapter, run as a control on the same video, returned 137 rows in 56 s                        | ❌ |
| WeRead                                 | not signed in on this browser; needs the key-based (`weread-official`) path                                                          | 🔒 out of scope |
| Xiaohongshu note                       | `edith…/user/me` 406 (needs `x-s`); the note page is readable through a signed link from `list_links` + `get_page_text`              | ⚠️ deprioritised |
| LinkedIn                               | not signed in on this browser                                                                                                          | 🔒 |

The "page-origin synchronous XHR" rows used `preview_site_script dry_run_js` —
a site-script preview tool pressed into service as the only way this shell
can run JavaScript in a page. That worked because it runs in the page's origin
(cookies, `Origin`, `Referer` all the site's own) and because a synchronous
`XMLHttpRequest` needs no `await`; its limits (isolated `USER_SCRIPT` world, no
async) are precisely where YouTube failed.

### 15.4 YouTube, in detail — the priority case, solved (2026-09-06)

YouTube was the user's hard requirement and it is the case that taught the round
the most, because the obvious routes are all dead and the working one is not the
adapter's.

What does NOT work today (verified on real, logged-in Chrome, dev build):

- **The pot wall.** A caption track's `baseUrl` fetched from the page answers
  `200` with an **empty body** unless the request carries a one-time `pot`
  (proof-of-origin) token the player computes via attestation and we cannot
  reproduce. InnerTube `get_transcript` — the pot-free path the marketplace
  adapter tries first — answers **400 "Precondition check failed"** on every
  video tried (ASR and manual alike). The shipped 39 KB `youtube/transcript`
  adapter, run as a control, **now fails too** ("Caption URL returned empty
  response") — YouTube tightened the preconditions and the adapter rotted, which
  is the whole argument for this section in one data point.
- **Watching the wire doesn't help.** The player renders captions on screen, but
  its caption fetch does **not** cross the tab's debugger Network domain — it is
  served by YouTube's ServiceWorker (or from the media pipeline), which a
  tab-target CDP attachment does not see. Captions were also **not** exposed on
  the `<video>` element's `textTracks`. A short-lived exception (a fresh,
  never-loaded video's first fetch occasionally crossing the page context) is not
  reproducible enough to build on.

What DOES work, reliably and pot-free: **drive YouTube's own "Show transcript"
panel and read the DOM.** The panel is the exact control a user clicks;
YouTube populates it through its authenticated path; the agent only reads the
rendered `ytd-transcript-segment-renderer` rows. One `eval_js` call:

1. expand the description (`#expand`), find the `aria-label="Show transcript"`
   button (there are several — the visible one wins; try each until a panel
   fills), click it;
2. wait for a `ytd-engagement-panel-section-list-renderer` whose `target-id`
   contains `transcript` to leave `HIDDEN` and hold a segment renderer (the
   element name changed — the "modern transcript view" — which is why the
   marketplace adapter's `page.evaluate` selectors would miss it);
3. scroll the virtualized list until the row count stops growing;
4. read each segment's `.segment-timestamp` + `.segment-text`.

Measured (each a single `open_url` + one `eval_js`, ~13 s):

| video                                   | rows | chars | span         |
| --------------------------------------- | ---: | ----: | ------------ |
| `kCc8FmEb1nY` "Let's build GPT"         | 1106 | 107 K | 0:00→1:56:15 |
| `zjkBMFhNj_g` "[1hr] Intro to LLMs"     |  581 |  64 K | 0:00→59:45   |
| `5MgBikgcWnY` (a talk, 27 caption langs)|  422 |  14 K | 0:09→19:25   |

So the generic-primitive path is not just possible, it is **more robust than the
adapter it replaces** — it depends on the UI a billion people use, not on an
internal token scheme that breaks monthly. The one gap is videos with no usable
transcript panel (an official music video's panel exists but does not populate);
the recipe returns a clear "no transcript" there rather than hanging. The whole
of the site knowledge is the four DOM steps above — which is exactly the content
that belongs in a skill, not in shipped extension code.

### 15.5 The primitive the round actually needed — one, not five (by evidence)

§15.3 listed five candidate primitives from the measurement. Building the real
artifacts (YouTube transcript; X thread/bookmarks) collapsed that list to **one
that shipped**, and the discipline is worth recording: the other four were gaps
imagined before the artifact existed.

- **`eval_js` — asynchronous JavaScript in the page's MAIN world, returning
  JSON — is the whole of it, and it shipped.** It carries YouTube (drive the
  transcript panel, read the DOM), X (a same-origin GraphQL XHR with `ct0` from
  `document.cookie` + the public bearer + a public queryId, reduced to rows in
  the page: 30 tweets from a 155 KB payload), and the general "reduce before
  returning" need. The full shell already had it, explore-only; here it is a
  tab-addressed generic tool (`tools/generic/eval-js-localmd.ts`), pinned by
  `tests/localmd-tool-surface.test.ts`. Its static write guard blocks obvious
  network writes (`allow_write` overrides) — note InnerTube/GraphQL **reads** use
  `POST`, so a read that must POST passes `allow_write:true`; softening the guard
  to recognise read-POSTs is a possible follow-up, not needed by any shipped
  skill yet.
- **Network observation with bodies — hypothesised, then NOT shipped.** §15.3
  guessed YouTube needed it. It didn't: the caption fetch is ServiceWorker-side
  and invisible to a tab-target debugger, and the working route (the UI panel)
  needs no wire access at all. No other candidate needed it either (X was
  page-origin XHR under `eval_js`). A `capture_network` tool was built and
  reverted the same day — shipping a tool with no artifact behind it is exactly
  the imagined-gap trap this project's method warns against. If a real artifact
  later needs "which request produced this value", it is a known, cheap addition
  (the CDP Network plumbing exists in `runtime/page.ts`).
- **The other three** (a credential that never enters the model's context,
  response shaping, a generic sign-in signal) are real but belong to the skill
  container (§15.6) or to later artifacts, not to this shell's tool surface now.

### 15.6 Where an adapter lives once it is data — a skill, with an executable core

The user's steer (2026-09-05): make adapters **skills**, because people already
know what a skill is. That fits localmd better than a new spec kind would:

- localmd already reads `.agents/skills/<name>/SKILL.md` (open SKILL.md format,
  `name` / `description` / `invocation` frontmatter, progressive disclosure,
  slash menu), and its built-in integration skill already ends with "save a
  skill into the KB describing the tools you built and their quirks".
- A skill is human-readable, editable, versioned with the folder, and
  shareable the way people already share skills. It is the natural home for
  the part of an adapter that is **knowledge**: which endpoint, which header
  comes from which cookie, that the article API 403s but the page does not,
  that YouTube's pot-free path 400s.
- A skill is *instructions*, though, and instructions cost model turns on
  every run. So the executable core stays deterministic and one call:
  - pure-HTTP cases → a saved HTTP tool bundle (`manage_tools save_bundle`,
    `transport: extension`), which localmd runs without the model doing the
    request;
  - page-context cases → a fenced JS block in the skill that the agent hands
    verbatim to `eval_js`, returning rows.

  The skill references both and explains them; the model reads the skill once
  and calls one tool. That is "tools are data on top of machinery" with the
  skill as the container — and it needs no new machinery on the localmd side
  beyond what §15.5 asks of this shell.

  **Superseded (2026-09-06):** the earlier plan pre-wrote per-site skills (a
  `docs/adapter-skills/` staging area, later this repo's `skills/adapters/`).
  Real-machine testing exposed that maintaining per-site skills in ANY form is a
  maintenance nightmare, so the project ships **none** — only the base + a couple
  of hints (`reach-a-site`), while users' own agents build and save their own.
  The eight verified recipes were folded into `docs/tests/site-probes.md` as
  base-capability probes; see `docs/architecture.md` §A.5. The **method** half
  still ships: `LOCALMD_CONNECT_INSTRUCTIONS` carries the "build one with eval_js"
  robustness ladder, so the agent one-shots the easy majority live.

### 15.7 The plan, in order

1. ~~Measure with today's tools~~ — §15.3.
2. ~~**Primitive** (this shell): `eval_js`~~ — landed 2026-09-06
   (`tools/generic/eval-js-localmd.ts`, pinned by
   `tests/localmd-tool-surface.test.ts`; surface 55 → 56). Only `eval_js`
   shipped; the network-observation tool was built and reverted the same day
   for want of an artifact that needed it (§15.5). `fetch_url` unchanged; the
   sign-in signal is deferred to the first artifact that needs it.
3. ~~**First artifact** — YouTube transcript~~ — proven 2026-09-06 (§15.4),
   pot-free via the "Show transcript" DOM panel, more robust than the shipped
   adapter (which now fails). The reusable snippet is the skill's executable
   core.
4. **Container** (localmd, next): a "browser adapter" skill convention —
   SKILL.md + a fenced `eval_js` JS block (page-context) or a saved HTTP bundle
   (pure-HTTP), and the built-in integration skill taught to produce it.
   Credential carrying per §15.5.
5. **Rebuild test**: one sentence per remaining candidate ("give me a tool that
   reads a Bilibili video's subtitles"), the agent builds + saves the skill, run
   again the next day. Score each: no help / one hint / failed. The hints become
   a generic recipe doc the agent reads (the robustness ladder, the sign-in
   check, "signed URL" cases, "the UI panel beats the private API when the API is
   pot-locked") — that is where the 294 adapters' experience goes, not their code.
6. **Retire**: when the candidate set passes, this shell stops registering
   `find_adapters` / `run_adapter`; the marketplace repo stays for the full
   shell. The site-script tools get the same test before their label comes
   off or they go the same way.

Until step 5, the experimental label is the contract with users: these may
change shape or disappear, and nothing they rely on is persisted by them.

### 15.8 The adapter-eval build artifacts followed the tools out (2026-09-06)

**Symptom.** After P5-B retired `find_adapters` / `run_adapter` from this shell
(step 6), the shipped `dist-localmd/` still carried the whole adapter-eval trio —
`sandbox.html` (patched into the built manifest as a sandbox page),
`offscreen.html` + `offscreen.js`, and `userscript-runner.js` + its
`web_accessible_resources` entry — plus the `offscreen` permission in
`manifest.localmd.json`. `offscreen.js` bundled `sidepanel/sandbox-host`, so the
"lean" shell was still shipping full-shell UI code, and the unused `offscreen`
permission is exactly the kind of thing a Web Store reviewer rejects a new item
over.

**Root cause.** P5-B removed the tool *registrations* and the SW code paths, but
`vite.config.ts` composed `sandboxPagePlugin(outDir)` into the localmd build
unconditionally, and the manifest's permission/WAR list predated the retirement.
The plugin is the adapter-eval emitter: nothing in this shell opens an offscreen
document (`evalAdapterViaOffscreen` is full-shell only), navigates the sandbox,
or loads the runner file — site scripts inject **inline** code via
`chrome.userScripts.register` / `.execute({ js: [{ code }] })`, never
`{ file: 'userscript-runner.js' }`.

**Fix.** Dropped `sandboxPagePlugin` from the localmd path in `vite.config.ts`
(kept `relayScriptPlugin` + `pageToolsPlugin`); removed `offscreen` from
`manifest.localmd.json` `permissions` and deleted the dead `userscript-runner.js`
WAR. The full extension still runs `sandboxPagePlugin` (it evals adapters); WebCLI
is unchanged. Verified on a clean build: `dist-localmd/` has no `sandbox.html` /
`offscreen.*`, the built manifest has no `sandbox` / `offscreen` / WAR, the SW
bundle has zero `sandbox-host` / offscreen references, and `web-relay.js` +
`page-tools.js` (registered at runtime via `chrome.scripting`, no WAR needed) are
still emitted. Pinned by two `tests/localmd-tool-surface.test.ts` cases (the
site-script/capture permissions stay; `offscreen` must be absent). A 78-byte
`public/userscript-runner.js` placeholder still copies into every build's root —
harmless and unreferenced here now that the WAR is gone.

**Lesson.** Retiring a capability is two edits, not one: the tool/SW code AND the
build/manifest surface it emitted. A tracer that walks import closures won't catch
this — the dead artifacts are emitted by a Vite plugin, outside the SW's import
graph — so a shell's shipped `dist/` is worth an eyeball after any capability
removal. This also cleared the last build-level edge from the lean localmd shell
into `sidepanel/` (P4, architecture.md §A.4).
