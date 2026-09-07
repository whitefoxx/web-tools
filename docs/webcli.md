# WebCLI — "one core, two shells"

> **2026-08-06 — now three shells.** A third headless shell, **localmd Connect**
> (`--mode localmd` → `dist-localmd/`), builds on WebCLI's base and ADDS
> marketplace adapters + persistent site scripts for localmd.app. It took over
> the §15 relay protocol wholesale (its DOM marker is `data-localmd-connect`);
> **WebCLI 0.3.0 dropped web-app access entirely** and is WS-daemon-only again.
> Pages MUST still address relay frames with `ext` (0.2.0 WebCLI installs and
> dev builds can coexist with localmd Connect). Everything WebCLI-specific in
> this doc still holds; the deltas live in
> [localmd-connect.md](./localmd-connect.md).

Decouples the two tool categories (generic browser tools vs site adapters) into
independent layers, then ships a SECOND, lightweight Chrome extension — **WebCLI**,
a pure browser-control bridge with **no in-browser agent** — that exposes ONLY the
generic browser tools to external agents (Claude Code, Codex, and web apps the user
approves) over the
existing transports.

- Full extension (`manifest.json` → `dist/`): agent + adapters + SidePanel +
  marketplace + explore. Unchanged behavior. Name "Web Agent", ID
  `gcbgpkldpnmenoejbnbkdcagjhgbemeb`.
- **WebCLI** (`manifest.webcli.json` → `dist-webcli/`): generic tools + the two
  transports + a tiny status popup. ~185 KB SW bundle (vs the full ~640 KB when
  the same graph is inlined). ID `jnhfdhpafndcbppkphhfpecflhogngge` (the PUBLISHED
  store id — see [webcli-releases.md](./webcli-releases.md) §1).

Built 2026-07-15 on branch `lite-bridge` (off `product`). See the sibling design
in [external-agent-control.md](./external-agent-control.md) — WebCLI is the "pure
provider" packaging of the same T7 transports.

## 1. The shared core (`src/core/`)

Everything WebCLI runs on lives in `src/core/`, and it imports NOTHING from the
full shell (agent / adapters / explore / marketplace / sidepanel). That
zero-coupling is enforced **by construction** (import graph), not by tree-shaking
faith — verified by grepping the built WebCLI bundle (see §6).

| File                        | Role                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/execute-generic.ts`   | Standalone executor for `generic__*` tools — the dispatcher's `site==='generic'` branch + pure helpers, duplicated on purpose. The full `tools/dispatcher.ts` keeps its own copy so its behavior is unchanged.                                                                                           |
| `core/explore-gate.ts`      | The seam that severs generic tools' compile-time edge to the heavy `explore/*` subsystem. `getActiveExploreSession()` delegates to an injected impl; the FULL SW wires the real one at boot (`setExploreGate`), WebCLI never does (→ null → tools take their normal `tab_id` path). `import type` only.  |
| `core/bridge-core.ts`       | `createBridge({execute, controlTools, …})` → `{runExternalTool, isExternalTool}`. The single copy of external-call dispatch + write gates. Full injects `executeAdapter` + rich CONTROL_TOOLS; WebCLI injects `executeGenericTool` + `{}`.                                                               |
| `core/ws-bridge.ts`         | `createWsBridge(cfg)` — the WebSocket transport (dial / register+catalog / heartbeat / backoff reconnect / `call→run→reply` loop with per-call timeout + reply-on-live-socket §10.34 + `poke()` for alarm redial). Shell-agnostic. Covered by `tests/ws-bridge.test.ts`.                                 |
| `core/external-mcp-core.ts` | `createExternalMcpHandler(cfg)` — the `onConnectExternal` JSON-RPC/MCP transport (origin gating, initialize/tools/list/tools/call, MCP content + image blocks, 1MB ceiling). `webTask` is OPTIONAL: full injects the agent-engine delegate, WebCLI passes `undefined` (→ `web_task` unlisted, `-32602`). |

Also reused by both shells: `runtime/*` (registry, `page.ts` CDP shim),
`tools/manifest.ts`, and the clean tab helpers `background/agent-window.ts` +
`background/controlled-tabs.ts`.

## 2. Tool decoupling — three groups

The old `src/tools/generic/*` was NOT actually generic: it was entangled with
explore, marketplace, and selection. It's now partitioned:

- **WebCLI generic (28 today** — this bullet said 29 when written, then 25 after
  the §11 sweep, then 28 with the §14 borrows; the live count is pinned by
  `tests/webcli-tool-surface.test.ts`**)** — registered by
  `tools/generic/_generic.ts`, work standalone (open
  their own tab or take `tab_id`). The ones that default to the explore tab when
  `tab_id` is omitted (open_url, get_html, query_dom, get_dom_outline,
  find_in_dom, wait_for_selector, list_links) reach the session through
  `core/explore-gate` (null in WebCLI), NOT `explore/session`.
  - **`web_search`** (added 2026-07-16) — the base "query → ranked
    {rank,title,url,snippet}" primitive that pairs with get_page_text (search +
    fetch, the way most agents expect a base web toolset). It's a GENERIC
    capability, not a site adapter — marketplace has many in-site searches
    (zhihu/search …) but nothing general — so it lives here and WebCLI's
    agent-free shell gets it for free. Impl mirrors get_page_text's url mode
    exactly (throwaway background agent tab → `waitForPageReady` on the first
    result LINK → `executeScript` a self-contained per-engine `extractSerp` →
    close in `finally`); **no API key**, uses the user's real Chrome session so
    bot-detection is far milder than a headless scraper. 3 engines: `google`
    (best results, most volatile DOM), `bing` (stable DOM, EN+CN), `duckduckgo`
    (lite.duckduckgo.com, no-JS/most parseable, EN-leaning). Baidu deferred.
    - **`engine` is REQUIRED** (2026-07-26): `"auto"` → try
      `google → bing → duckduckgo`, first with results wins (`tried[]` records the
      trace); or pin exactly one. There is deliberately **no default** — the
      caller states what it is doing, and the call reads unambiguously. An
      unsupported value (`"baidu"`, `"yahoo"`) is now an **error naming the legal
      values**: it used to fold into "cascade", so `engine:"baidu"` quietly
      searched Google and reported success, and the caller never learned its pin
      was ignored. Same silent-substitution class as §10.47's dead tab id.
    - **`max_wait_ms`** (default 12000, 1000–60000): the page-ready wait cap is a
      tunable arg, not hardcoded — a slow/heavy SERP can be retried bigger.
    - **Text fallback**: if NO engine yields structured results (selector rot,
      SERP restructure, or a block page), it still returns the SERP's visible
      **text** (`fallback:"text"` + `text` field) so the agent gets something
      readable. This open-URL→read-text path is also how a user/agent searches an
      UNSUPPORTED engine today (open_url the query URL → get_page_text); the 3
      above just additionally get parsed results.
    - Robustness inside a single attempt: content-based ready selector +
      retry-on-empty (see [findings F-40](./tests/findings.md) — cn.bing streamed
      the `li.b_algo` container before its anchors, so waiting on the container
      extracted 0; fixed by waiting on `li.b_algo h2 a`).
    `extractSerp` is exported + jsdom-unit-tested (per-engine selectors with
    fallbacks, DDG `uddg=` / Google `/url?q=` redirect decoding, engine-host
    filtering, zero-results bot-check → `blocked:true`; a real cn.bing SERP
    regression fixture). Since SERP DOM drifts, the extractor + ready selectors
    are where maintenance lands — treat selector rot as the expected failure mode
    (the text fallback is the safety net that keeps it useful meanwhile).
  - **`list_links`** (added 2026-07-16) — extract every `<a href>` on a page as
    absolute, deduped URLs (+ anchor text), with optional `selector` scope,
    `same_origin`, and `pattern` (regex) filters; pierces open shadow DOM; returns
    `{url,text}[]` plus `total`/`truncated`. Same url/tab_id/explore addressing as
    get_html. It's the **frontier-extraction primitive for agent-orchestrated
    crawling** — a deliberate design call (confirmed with the user): we DON'T ship
    a `crawl` tool, because crawling is a loop (fetch → extract links → filter/dedup
    → BFS/DFS → repeat → stop) = ORCHESTRATION, which the upper-layer agent (full
    extension or an external agent over the bridge) does with open_url +
    get_page_text + list_links. web_search is the exception that earned a tool
    (small bounded output + fragile in-LLM parse); crawl's output is large/unbounded
    so the tradeoff flips → stays orchestration. What was missing was only the cheap
    single-page primitive that makes that loop efficient (one call → the whole
    frontier, vs get_html + LLM-parsing hrefs each hop; query_dom is only a ≤30
    sample probe). `extractLinks` is exported + jsdom-unit-tested. Principle going
    forward: **add low-level primitives, not upper-layer tools.**
  - **Primitive batch (added 2026-07-16)** — a gap-analysis pass (vs the wigolo
    MCP) added the low-level primitives we still lacked; all are content-script /
    executeScript only (NO CDP, NO new manifest permissions), so all ship to
    WebCLI too. Cookies/downloads were deferred precisely because they'd need new
    permissions.
    - **`fetch_url`** — the RAW (non-rendering) half of fetch: SW-side
      `fetch(credentials:'include')`, cookie-authenticated + CORS-free via
      `<all_urls>`, returns `{status, headers, body|json}`. For JSON APIs, RSS,
      sitemap.xml/robots.txt, status/redirect checks, POSTing an endpoint —
      complements get_page_text (which renders). `runFetch`/`parseHeaders`
      exported + unit-tested.
    - **`handle_dialog`** — pre-arm auto-accept/dismiss for native
      alert/confirm/prompt (they BLOCK the page loop → deadlock automation).
      MAIN-world override of window.alert/confirm/prompt, logs what it answered.
      `installDialogHandler` exported + jsdom-tested.
    - **`file_upload`** — set a File into `<input type=file>` from
      agent-provided content (text / base64), via DataTransfer→input.files in the
      MAIN world (the non-CDP path). Content the agent HAS, not a disk path.
    - **`drag_and_drop`** — synthesize pointer + HTML5 DnD chain from→to
      (best-effort; synthetic DnD can't satisfy every library).
    - **`click` +`button`/`count`** — right-click (contextmenu) / middle /
      double-click; the default left single-click keeps native `el.click()`.
    - **`manage_tabs` +`back`/`forward`** — history nav (drill into a detail page,
      then go back) instead of re-open_url.
    Explicitly NOT added (would need new permissions — deferred): `get_cookies`
    (`cookies`), downloads (`downloads`). crawl/research/etc. stay agent-orchestrated.
- **Explore-only (8)** — moved to `src/tools/explore/` (+ `_all.ts`). They REQUIRE
  a live session (`session.newPage()` on the explore tab, or the trace store):
  `eval_js`, `find_structured_data`, `get_a11y_tree`, `list_network`,
  `read_network`, `list_trace`, `find_in_network`, `capture_submission`. Full only.
- **Full-only (3)** — stay in `generic/` but register ONLY via `_all.ts`, not
  `_generic.ts`: `find_adapters`, `load_adapter` (marketplace), `get_highlights`
  (selection).

`tools/generic/_all.ts` = `_generic` + `../explore/_all` + the 3 full-only.
Imported by BOTH the full SW and the SidePanel; WebCLI imports `_generic` directly.

> **Refinement vs the original plan:** the plan expected to move 5 explore tools
> and classify 9 as "gate-only". Implementation found **8** explore-only tools
> (eval_js / find_structured_data / get_a11y_tree also require a session) and only
> **6** genuinely-standalone gate tools. All 8 were relocated.

## 3. Why no dispatcher changes

The plan proposed `registerExploreRecorder` / `registerAdapterHintProvider` hooks
in `tools/dispatcher.ts`. **Unnecessary**: WebCLI never imports the dispatcher (it
uses `executeGenericTool`), so the dispatcher's full-shell imports never reach the
WebCLI bundle. The dispatcher is untouched — zero risk to the shipping hot path.

## 4. Two build targets (`vite.config.ts`)

One mode-driven config:

- `npm run build` → `dist/` (full: `manifest.json`, `sandboxPagePlugin()` on).
- `npm run build:webcli` → `dist-webcli/` (WebCLI: `manifest.webcli.json`,
  `sandboxPagePlugin()` OFF — no adapter sandbox / offscreen / userScript-runner).
  `npm run build:all` does both.

Fully separate output dirs. The two tiny `public/` stubs (`marketplace-index.json`
3B, `userscript-runner.js` 78B) copy through to `dist-webcli/` harmlessly.

## 5. WebCLI manifest + SW + popup

`manifest.webcli.json` (name "WebCLI - Browser Control for Agents" since 0.1.0
— the store shows the manifest name, so it carries the pitch; `controlled-tabs.ts`
cuts it at the dash so the tab group stays "WebCLI", see §13):

- **own `key`** → stable ID **`jnhfdhpafndcbppkphhfpecflhogngge`**, so both
  extensions install side by side. Since the first Web Store publish this is the
  **store's** public key, not our self-generated one — an unpacked dev load now
  gets the same id the store hands out. `extension-key-webcli.pem` is dead for
  this item; see [webcli-releases.md](./webcli-releases.md) §1 for why, and for
  how the store's public key was recovered from the published CRX.
- **KEEP** perms: `debugger`, `tabs`, `tabGroups`, `scripting`, `storage`,
  `cookies`, `downloads` (last two used in the shared `runtime/page.ts` CDP layer),
  **`alarms`** (redial safety net, §6), `host_permissions:["<all_urls>"]`,
  `action.default_popup` = the status page. **`externally_connectable` was
  DROPPED in 0.2.0** — web apps now come in through the user-configured relay
  (§15), so no origin is baked into the manifest.
- **DROP**: `sidePanel`, `userScripts`, `offscreen`, `notifications`, and the
  `side_panel` / `sandbox` / `web_accessible_resources` blocks.

`src/background/webcli-service-worker.ts` wires ONLY: register `_generic` tools →
`createBridge({execute: executeGenericTool, controlTools: {}})` → `createWsBridge`
(ON by default, port from `storage.local.bridgePort`, client name `webcli`) → a
1-minute `alarms` redial → `createExternalMcpHandler` (`onConnectExternal`,
`webTask: undefined`) → a `WEBCLI_STATUS` message handler for the popup. Busy hooks
reuse `runtime-state`'s keepalive (F-8). It does NOT wire sessions, adapters,
marketplace, explore, site-scripts, page-llm, schedules, message-router, or
`driveApiSession`.

**Status popup** (`src/webcli/popup.html` + `popup.ts`): the toolbar icon opens a
small page (no SidePanel) showing daemon connect state (polls `WEBCLI_STATUS`
every 2s), the tool-set profile and the web-app origin list (§14.4, §15), a
one-line intro, and a Documentation link. Plain HTML/TS — no Preact, so it adds
~3 KB, not the UI framework.

## 6. Reconnect safety net (the `alarms` redial)

A disconnected SW has no heartbeat to keep it warm, so if the **daemon starts after
the extension**, MV3 recycles the idle SW before its backoff retry fires and it
never redials (observed on the first real-machine test — a reload was needed).
Fix: WebCLI keeps the `alarms` perm and registers a **1-minute `webcli-redial`
alarm**; its handler calls `wsBridge.poke()` (idempotent — a no-op when already
connected), and the alarm firing also wakes a recycled SW so its top-level
`start()` redials. So WebCLI reconnects within ~1 min of the daemon coming up, no
reload needed.

## 7. Verification

**Automated (all green):** `npm run typecheck`, `eslint src/` (0 errors),
`npm run test` (1890 pass — incl. the 33 bridge tests through all three transport
extractions + 8 `ws-bridge` cases), `npm run build` (full), `npm run build:webcli`.

**Bundle-level decoupling (grep of the built WebCLI SW):** ABSENT — `SiteTabPool`,
`ExploreSession`, `fetchMarketIndex`, `driveApiSession`, `installMarketplaceAdapter`,
`runInstalledFuncAdapter`, `loadLlmConfig`, `armAgentMask`, `recordRunTab`,
`web_task`, and every explore-only tool name. PRESENT — `executeGenericTool`,
`createWsBridge`, `createExternalMcpHandler`, the generic tool names.

**Real-machine WS test — PASSED (2026-07-15).** WebCLI loaded alongside the full
extension (distinct IDs), `node bridge/server.mjs`:

- `/guide` reports `client: webcli`; `/status` `tools: 23`; catalog = exactly the
  23 `generic__*` tools, **0 site adapters**. _(As of 2026-07-16, `web_search`
  brings this to 24 — the WS test above predates it; re-verify the count on the
  next real-machine run.)_
- Live: `list_tabs`, `open_url`, `get_page_text {url}` ("Example Domain"),
  `get_text_from_tab {tab_id}`, `screenshot` (valid 56 KB PNG dataUrl),
  `get_interactives` (structured), `click {ref}` → real navigation
  example.com → iana.org, `close_tab` — all ✅.
- Negatives (decoupling proof): `save_memory` (full-shell control tool) → "tool
  not found"; `xiaohongshu__user_profile` (site adapter) → "tool not found". ✅

(Tested BEFORE the rename/alarms/popup, when the client name was `web-agent-bridge`
and the SW was `lite-service-worker.ts`; re-verify the popup + redial after the
rename.)

**Superseded (0.2.0):** the localmd.app `externally_connectable` Port path below
was replaced by the relay (§15), which is verified in tests/platform.md §6b. Kept
for the record of what 0.1.0-era testing covered:
`tools/list` should omit `web_task`, a direct `generic__*` call should work, and
`web_task` → `-32602`.

## 8. Build & use

```bash
npm run build:all          # dist/ (full) + dist-webcli/ (WebCLI)
# Load unpacked dist-webcli/ at chrome://extensions (ID hjdccc…)
npx -y github:whitefoxx/web-tools   # the WebCLI daemon on 9376 (WebCLI dials it)
```

WebCLI defaults to port **9376** (a distinct port from the full bridge's 8787, so both can run
at once). It is ON by default (the popup is status-only, not an enable switch). To
change the port or disable it, set `chrome.storage.local` `bridgePort` /
`bridgeEnabled`.

## 9. Dedicated WebCLI skills repo + own port (done)

WebCLI has its **own** public skills repo — **[`whitefoxx/web-tools`](https://github.com/whitefoxx/web-tools)**
— mirroring `web-agent-skills`, but generic-only: a slim daemon (`server.mjs`,
default port **9376**, `GET /ping /status /tools` + `POST /command`, no adapter/
explore "control tools") + a `webcli` skill teaching the generic-tool loop. Install
with `npx skills add whitefoxx/web-tools -g`; run the daemon with
`npx -y github:whitefoxx/web-tools`. The popup's Documentation link points
there. The separate port lets WebCLI and the full Web Agent bridge run
simultaneously without competing for a daemon's single connection.

Mounted here as a **git submodule at `bridge/`** (same pattern as `bridge/`
/ `marketplace/`). To change the WebCLI daemon or skill: edit inside
`bridge/`, commit + push to the public repo, then bump the submodule
pointer here. For local dev you can run the daemon straight from the submodule:
`node bridge/server.mjs`.

## 10. Tab lifecycle in WebCLI — nobody reaps for you

The full shell runs generic tools through `tools/dispatcher.ts`, which records
every tab a run creates (`created_tab: true` in the result) into the **run-tab
janitor** (`background/run-tabs.ts`) and closes them when the agent run ends.
**WebCLI has none of that**: it dispatches through `core/execute-generic.ts`,
which deliberately imports no janitor — and there is no "run end" to hang one on,
because an external agent's session has no boundary the extension can see.

Consequences, all of them intentional but easy to trip over:

- **A `tabId` handed to an external agent stays valid** until that agent calls
  `close_tab`, or the user closes the tab. Tabs also pile up forever if the agent
  forgets — hence "close background tabs when done" in `WEBCLI_INSTRUCTIONS` and
  the `webcli` skill.
- **Tool descriptions must not promise reaping.** `open_url` used to say "tabs are
  reaped automatically … recycled at the end of this task" — true only in the full
  shell, and in direct contradiction with the WebCLI instructions telling the agent
  to clean up after itself. The lifecycle promise now lives in the full shell's
  system prompt; the shared tool description says nothing about it. Same trap for
  any future description: it is read by BOTH shells.
- **The one thing that does close tabs in WebCLI** is a tool disposing of a tab it
  opened itself — `get_page_text` / `get_html` / `get_dom_outline` / `screenshot`
  in `url` mode. Those results carry `tab_closed: true` and **no tab id** (see
  `docs/adapter-hot-plug.md` §10.47: returning the id of a tab you just closed
  invites `scroll_page` on a dead tab). Pass `keep_open: true` to `get_page_text`
  when you want the text *and* a live tab back — the one-call replacement for
  `open_url` → `get_page_text`.
- **The agent window / tab group is per-shell.** The group title is the
  extension's own manifest name (`Web Agent` vs `WebCLI`) because tab groups are
  browser-global: with a shared title each shell's `reapOrphanAgentWindows` closed
  the other shell's agent window out from under it (§10.47). Never reintroduce a
  shared, hardcoded group title.

## 11. Catalog sweep — what an agent-free shell may say (2026-07-26)

After the `open_url` / `get_page_text` findings (§10) the whole 26-tool set was
swept for the same two failure classes. What the sweep is looking for, and what it
found:

| Class | What it looks like | Found |
| --- | --- | --- |
| **Dead handle** | a tool returns an id for a resource it destroyed | `get_page_text{url}`, `screenshot{url}` (fixed, §10) — `get_html` / `get_dom_outline` / `list_links` / `web_search` also close their tab but never reported an id, so they were already correct |
| **False promise** | a description asserts full-shell behavior | `close_tab` ("at task end the system auto-reaps … so no explicit cleanup is needed" — exactly backwards here), `open_url`'s `active` arg ("auto-reaped at task end … kept until the next task starts") |
| **Unreachable mode** | a documented fallback that cannot happen | `get_html` / `query_dom` / `get_dom_outline` / `wait_for_selector` / `list_links` all said "omit `tab_id` to use the Explore session tab" — the explore gate is null in WebCLI, so omitting it can only error. Reworded to "required unless an Explore session is running", true in both shells |
| **Dead tool** | listed but cannot succeed | `read_more` pages through the oversize stash, which only `agent/engine-history.ts` writes. No agent loop ⇒ no stash ⇒ every call fails; the Port-MCP transport truncates without a stash id anyway. Moved to `_all.ts` (full only) — WebCLI is now **25 tools** |
| **Stale provenance** | "the tabId from `open_url`" | `scroll_page` / `get_interactives` / `find_in_page` / `get_html` / `list_links` now also name `get_page_text {url, keep_open:true}`, so the one-call path is discoverable from wherever the agent happens to be reading |

The first three classes are invisible to `tsc` and to every behavioral test — they
are wording, and wording is this shell's entire interface. They are pinned by
**`tests/webcli-tool-surface.test.ts`**, which asserts over the live `_generic`
registry: no reap/task-lifecycle promises, no Explore-as-default phrasing, no
reference to a tool the shell doesn't register, the exact membership, and the
tool count. The regexes were checked against the pre-fix strings — they catch all
five. Reword freely; if that test goes red, the wording is what's wrong.

## 12. `fetch_url {format:"markdown"}` — reading a page with no tab at all (2026-07-26)

There are now three ways to read a page, in ascending cost:

| | Tab? | Sees JS-built content? | Cost |
| --- | --- | --- | --- |
| `fetch_url {url, format:"markdown"}` | no | **no** — only what the server sent | one HTTP request |
| `get_page_text {url}` | throwaway | yes | tab create + settle + close |
| `open_url` → `get_page_text {tab_id}` | kept | yes | two calls, and you own the tab |

`fetch_url` already existed as the raw-bytes half of "web fetch". What it lacked
was the thing that makes a fetch *readable*: HTML → Markdown. Guidance everywhere
now says: **server-rendered content (articles, docs, blogs, READMEs, news) →
`fetch_url` markdown first; fall back to `get_page_text` when the result comes
back empty or is missing the JS-built parts.**

**Why it is not a second converter.** MV3 service workers have no DOM and no
`DOMParser` — that is exactly why the Markdown walker (`extractPageMarkdown`)
runs *inside the page* via `executeScript`. The obvious move, writing a
string-based converter for the SW, would have produced two Markdown dialects that
drift apart forever. Instead:

- `extractPageMarkdown` gained ONE parameter — `doc`, defaulting to the live
  `document`. In a tab the default is evaluated *in the page*, after
  serialization, so the in-page path is byte-for-byte unchanged.
- `_mini-dom.ts` parses fetched bytes into the **smallest tree that satisfies the
  DOM surface that walker touches** (`nodeType` / `tagName` / `childNodes` /
  `children` / `textContent` / `getAttribute` / `closest` / `querySelector[All]`),
  plus a documented selector subset (comma groups of `tag#id.class[attr]`
  compounds with descendant combinators — no child/sibling combinators, no
  pseudo-classes; an unsupported selector matches nothing rather than throwing).
- The same walker then runs over it. One dialect, one set of bugs.

**The test that makes this safe is differential**: `tests/mini-dom-parity.test.ts`
feeds identical HTML to jsdom and to `parseHtml`, runs the same walker over both,
and demands byte-identical Markdown. It earned its keep immediately — it caught
that implied end tags need SCOPE: `<li>two<ul><li>inner</li></ul></li>` closed the
outer `<li>` when the inner one opened, so the nested list became a sibling. A
"does it produce plausible Markdown?" test would have sailed past that. The
`fetch_url` tests also run in the **node** environment (no jsdom, no `document`),
which is what proves the conversion never touches a DOM.

**Cookies are now a parameter.** `fetch_url` always sent `credentials:'include'`
— right by default (fetching from the user's browser is the whole point: paywalled
and logged-in pages just work), but not always wanted. `with_cookies:false` fetches
as an anonymous visitor — to see the signed-out version of a page, or to keep the
user's account out of a request. The result echoes `with_cookies` so a login wall
in the body explains itself instead of looking like a bug.

**Not done: proxy.** An extension's `fetch()` has no per-request proxy option;
Chrome offers only `chrome.proxy`, which is browser-wide, needs a new permission,
and would route the user's other tabs through it mid-call. A URL-rewriting relay
(`https://relay/?url={url}`) is the per-request-shaped alternative and needs no
platform support at all — deferred until there is a concrete use for it.

## 13. Running the dev build next to the store install (2026-07-27)

Pinning `manifest.webcli.json`'s `key` to the store's public key
([webcli-releases.md](./webcli-releases.md) §1) bought one identity everywhere —
and cost the ability to have a dev build and the store install in the same Chrome
profile. An id is unique per profile: same id, one extension. Disabling one does
not help, because a disabled extension is still installed and still holds its id;
the collision is at load time, not at enable time.

Two ways out, and the tradeoff is which fidelity you give up:

| | Same profile? | Artifact tested is the one shipped? |
| --- | --- | --- |
| Second Chrome profile | no — one build per profile | **yes**, byte-identical |
| `--mode webcli-dev` | **yes**, side by side | no — key/name/port differ |

`npm run build:webcli:dev` → `dist-webcli-dev/`, differing from the shipped build
in exactly three places, each one there to stop a collision:

- **`key`** → the self-generated key (private half `extension-key-webcli.pem`),
  id `hjdcccloaonnfpojpiaadabkhjggilha`. So that pem is NOT dead after the store
  migration — it moved from being the product identity to being the dev identity.
- **`name`** → `WebCLI (dev) - …`, derived from the store name by inserting the
  marker after the leading token (never spelled out, so editing the store name
  cannot leave the dev build advertising the old one). This is not cosmetic:
  `groupTitle()` derives the tab-group title from the manifest name (§10), so the
  dev build groups its tabs under `WebCLI (dev)` and the two installs' orphan
  reapers stay out of each other's windows — the §10.47 cross-shell bug, which
  applies just as much to two builds of the SAME shell. The marker goes BEFORE the
  dash on purpose: `shortLabel()` cuts there, and a marker after the cut would
  leave both builds labeled `WebCLI` and put the bug straight back.
- **default port** → 9377 instead of 9376, via the `__WEBCLI_DEV__` build flag, so
  the two don't fight over one daemon's single connection. The dev build also
  announces itself as client `webcli-dev`, so the daemon log says which install
  answered.

`__WEBCLI_DEV__` is a Vite `define` (declared in `src/build-flags.d.ts`), so it is
statically replaced: the shipped bundles contain a literal `false` and the dev
branch is dropped entirely — verified by grepping `dist-webcli/` for the
identifier (0 hits) and for `9377` (absent). **`vitest.config.ts` mirrors the
define**; without it, the first test to import a module reading the flag would
throw `ReferenceError`.

Two things it does NOT solve:

- **Web apps had to whitelist the dev id** — and as of 0.2.0 they no longer do.
  Under `externally_connectable` a page called `chrome.runtime.connect(<id>)`, so a
  hardcoded published id could not reach the dev build. The relay (§15) hands the
  page the id of whichever install injected it (`data-webcli-relay`), so the dev
  build works with no page-side change. The WS bridge was never affected — it dials
  out to a port and never names an id.
- **The dev build is not the upload artifact.** Before shipping, smoke-test
  `dist-webcli/` itself (second profile, or temporarily remove the store install)
  — that is step 5 of the release checklist, not something the dev variant covers.

## 14. The chrome-devtools-mcp borrows (2026-07-29)

Five items from [devtools-mcp-comparison.md](./devtools-mcp-comparison.md) §2,
implemented on `feat/webcli-devtools-borrows`. What they have in common: all are
content-script / `executeScript` / config level — **no CDP beyond what screenshot
already used, no new manifest permission** — so every one of them ships to WebCLI,
which is the shell that needed them.

### 14.1 Screenshot cost controls — `format` / `quality` / `max_width` (§2①)

A screenshot is the most expensive thing an agent can put in its context, and the
tool had exactly zero knobs: one raw PNG `dataUrl`, 56 KB for `example.com` and far
worse for a dense page. Now:

- `format` — `png` (default, unchanged) / `jpeg` / `webp`; `quality` 1-100 for the
  lossy pair (default 80); `max_width` downscales, preserving aspect ratio.
- **The default did not move**, and the instinct behind that turned out to be
  the important part. Real-machine measurement ([findings F-44](./tests/findings.md)):

  | page | png | jpeg q80 | webp q80 | jpeg + `max_width` |
  | --- | --- | --- | --- | --- |
  | flat-colour app UI (a fixture form) | 141 KB | **157 KB — bigger** | 63 KB | — |
  | photo-heavy (a Wikipedia article) | 985 KB | 574 KB | 357 KB | 134 KB @ 1024 |

  JPEG's worst case is large flat areas plus sharp text edges, which is *exactly*
  what an app-UI screenshot is — and app UI, not photography, is the dominant
  agent workload. So the guidance everywhere now reads **`max_width` first, and
  `webp` when you want a lossy codec; do not reach for jpeg by reflex.** The
  biggest lever is not the encoder at all: halving the width quarters the pixels.
  The first version of this section recommended jpeg, extrapolated from their
  `--screenshotFormat` flag; it was wrong in the common case, and wrong guidance
  read by every agent is more expensive than none.
- An unsupported `format` is an **error naming the legal values** — the same rule
  as `web_search`'s `engine` (§2), for the same reason: a pin that is silently
  ignored teaches the caller a lie about what it captured.
- Encoding happens **once**. Where CDP can do it (no resize), the format goes
  straight to `Page.captureScreenshot` and no canvas is involved. Where a canvas
  pass is needed (any `max_width`, and the full-page stitch), chunks are captured
  **lossless** and the lossy encode happens once at the end — otherwise a tall page
  would stack jpeg artefacts chunk by chunk before the stitch even ran.
- `resolveShotEncoding` is exported + unit-tested; the canvas half needs a real
  browser and belongs to `docs/tests/platform.md`.

### 14.2 `fill_form` — N fields, one call (§2②)

`type_into` is one field per round-trip, so a login costs 2 LLM turns and a checkout
6, for what is mechanically a single DOM pass. `fill_form {tab_id, fields}` takes a
JSON array of `{ref|selector, value, append?}`.

- **It covers the element kinds a real form has**, not just text: `<select>`
  (matched by option value, then exact label, then case-insensitive, then
  substring), and checkbox/radio (by truthiness, via `.click()` first so bound
  handlers run). Without those, a batch fill would send the agent back out to
  `select_option` halfway through and undo the point of the tool.
- Text fields reuse `type_into`'s hard-won paths: the **prototype value setter**
  (React's dirty-value tracking swallows a plain `el.value =`), and for
  contenteditable the cancel-aware `beforeinput` plan.
- **Per-field results.** One bad selector reports itself and the other five still
  land — a batch tool that fails atomically on a stale ref would be worse than the
  loop it replaces.
- `fields` travels as a **JSON string**, following `manage_tabs`' `tab_ids`
  convention: the registry's arg types are scalar-only (`TYPE_MAP` in
  `tools/manifest.ts`) and three transports render that schema, so a real array
  type would be a change to all of them for one tool.
- Fields are **grouped by frame** — one injection per distinct iframe, not per
  field, reusing the `f<id>` ref semantics.

### 14.3 `wait_for_selector` also takes `text` (§2③)

Waiting for "Order confirmed" is what an agent wants after a click, and it needs no
DOM probe first. Rather than add a 29th tool, the existing waiter grew a `text` arg
(exactly one of `selector` / `text`); text mode matches a case-insensitive substring
of `document.body.innerText`, which is by definition only what is rendered — so
`visible` is moot there. **The name is now slightly narrow for what it does**; that
is the deliberate price of not growing the catalog (§14.4 is about exactly that
cost), and renaming would break every skill and cached catalog naming it.

### 14.4 Tool-set profiles (§2④)

`core/tool-profile.ts`: `chrome.storage.local.toolProfile = 'core'` narrows the
advertised catalog to the 13 tools that drive the actual loop; `'full'` (default,
and anything unrecognized) advertises all 28. Wired into **both** transports — the
WS `buildCatalog` and a new optional `toolFilter` on `createExternalMcpHandler`.

**It also needed a way to reach it.** As first built, the only setter was that
storage key, and WebCLI has no options page — so the actual instructions would
have been "open the service worker's devtools console and run
`chrome.storage.local.set(...)`". The user this saves tokens for is never going to
do that, which makes it a dead feature in the same sense as §11's dead tools. The
popup now carries a **Tools** dropdown, and the count beside it comes from the
SW's live registry over `WEBCLI_STATUS` (`13/28`) rather than a constant in the
popup that would quietly go stale.

Two calls worth keeping:

- **Hidden ≠ disabled.** A profile filters what is *advertised*; every registered
  tool stays callable. An agent on a cached catalog, a skill that names a tool, or a
  user following the docs must not hit "tool not found" because of a display
  setting — that would turn a token optimization into a capability cliff, and it is
  the same class of surprise as §11's dead tools.
- The profile is read **before** the first catalog push, and a change re-pushes
  (`refreshCatalog`) so a connected agent sees the new surface without reconnecting.

### 14.5 WebMCP — `list_webmcp_tools` / `call_webmcp_tool` (§2⑨)

Pages are starting to declare their own agent-callable tools via
`navigator.modelContext`. Reading that registry is one `executeScript`, so this is a
cheap option on a standard that may or may not land — and the honest framing is that
it is an option, not a feature with a proven counterparty.

- **MAIN world is mandatory.** `navigator` is per-world; an ISOLATED-world probe
  sees its own bare navigator and would report "not supported" on every page.
- The probe is **defensive on purpose**: the draft dropped
  `provideContext`/`clearContext` in March 2026, and enumerability of registrations
  is not guaranteed at all. It tries the known accessors in order, reports which one
  answered (`source`) and every one it looked at (`probed`), and — the distinction
  that matters — separates **"no WebMCP here"** from **"the API object exists but
  exposed no readable list"**. Those need different follow-ups, and folding them
  together would be the §10.47 silent-substitution class again.
- `call_webmcp_tool` is the one generic tool marked **`access:'write'`**: a page
  tool can post, buy, or delete. In the full shell it meets the normal confirmation
  gate; in WebCLI the write gate is open by contract (no UI to approve against), so
  the comment in `webcli-service-worker.ts` claiming "generic tools carry no
  `access:'write'`" was updated rather than left to rot.
- Two real-machine findings: `source` was computed and then **dropped by the
  tool's hand-written field forwarding** ([F-42](./tests/findings.md)) — the
  documented "we tell you which accessor answered" was false until fixed; and the
  Chrome tested on has **no native `navigator.modelContext` at all**, so the pass
  is against the fixture's shim (`webmcp.html` reports `impl=shim` on purpose, so
  a run can never quietly claim it tested the real API).
- Known follow-up if the ecosystem lands: tools registered *after* our probe are
  invisible. Catching those needs a `document_start` MAIN-world recorder wrapping
  `registerTool` — deliberately NOT shipped, because an always-on `<all_urls>`
  injection is a real cost to pay for a feature with no users yet.

### 14.6 Cost

WebCLI SW bundle **242.3 KB → 267.7 KB** (+25.4 KB, +10.5%; gzip 67.5 → 74.4 KB) for
three new tools, the encoding path and the profile seam. Typecheck, `eslint src/`
(the one `_mini-dom.ts` error predates this branch), and the full suite
(**2018 passing**, incl. 29 new cases in `tests/devtools-borrows.test.ts`) are green;
both builds succeed.

**Not yet verified on a real browser** — the in-page halves (canvas re-encode, the
DOM fill, the MAIN-world probe) cannot be covered by vitest. Rows are queued in
[docs/tests/platform.md](./tests/platform.md).

## 15. Web-app access is user-configured — the relay (2026-07-30) — **SUPERSEDED in 0.3.0**

> **0.3.0 (2026-08-06): web-app access was REMOVED from WebCLI entirely.** The
> use case moved to the localmd Connect shell, which carries the same relay
> protocol (marker `data-localmd-connect`) plus the adapter/site-script surface
> web apps actually want — see [localmd-connect.md](./localmd-connect.md) §8,
> now the canonical home of the page protocol. `core/web-origins.ts` and
> `core/external-mcp-core.ts` are unchanged; WebCLI just no longer wires them,
> ships no `web-relay.js`, and its popup lost the "Web app access" section. An
> `onInstalled` sweep removes 0.2.0 leftovers. Everything below is kept as the
> design record of the mechanism (it still describes localmd Connect's live
> behavior).
>
> **0.2.0 IS PUBLISHED**, so this removal takes a working feature away from
> installed copies — it is not the tidying-away of an unreleased experiment,
> which is how the 2026-08-06 work described it while
> [webcli-releases.md](./webcli-releases.md) still had 0.2.0 mislabelled
> PREPARED. That correction constrains the release order (localmd Connect must
> be installable first) — see the 0.3.0 entry there.

The Port-MCP transport used to be reachable only from origins hardcoded in
`manifest.webcli.json`'s `externally_connectable.matches` (localmd.app + the
Vite dev port). That field turned out to be a dead end for "let the user add a
site": Chrome reads it **once at install time** (no runtime API touches it), and
it refuses wildcard-TLD patterns, so user-chosen origins cannot be expressed in
it at all. It is now GONE from the manifest — no site, localmd.app included, has
built-in access.

The replacement path (`core/web-origins.ts`, popup "Web app access"):

1. The popup edits `chrome.storage.local.webOrigins` — exact origins only,
   normalized from whatever the user typed (`localmd.app` → `https://localmd.app`;
   bare loopback hosts get `http`; wildcards and non-loopback `http` are refused
   with the rule named).
2. The SW mirrors that list into `chrome.scripting.registerContentScripts` —
   which, unlike `externally_connectable`, happily takes runtime patterns under
   the `<all_urls>` host permission we already hold. Registered per host at
   `document_start`, reconciled (not re-created) on boot and on every list
   change; boot matters because an extension update clears dynamic scripts.
3. The injected script is `src/webcli/web-relay.ts` (~1 KB, emitted as a plain
   IIFE by `webcliRelayPlugin`): a dumb pipe between the page
   (`window.postMessage`) and an internal Port named `webcli-web-mcp`, which the
   SW routes into the SAME `createExternalMcpHandler` the old path used.

**Two-layer gate, on purpose.** Match patterns cannot carry a port (invalid in
the scripting API — `externally_connectable` was the one place they ever
worked), so the *injection* is host-scoped (`http://localhost/*`) and the
*service* check is the exact origin, port included: `allowedOrigins` on the
handler reads the stored list per connect. A page on the right host but the
wrong port gets a relay that connects to a wall. The handler-side check also
had to become **async** (a relay connect is often the event that wakes a cold
SW, and the list lives behind a storage read) — frames arriving before the
verdict are buffered, not raced; a failed storage read fails CLOSED. Pinned by
`tests/web-origins.test.ts`; the full shell's manifest-derived sync path is
byte-identical to before (pinned by `tests/external-mcp.test.ts`).

**Page protocol** (documented for integrators in this repo's README):

```
detect     : document.documentElement.dataset.webcliRelay === <ext id>   (sync, race-free)
page → ext : postMessage({ webcli:'mcp', dir:'to-ext', ext?, msg:<jsonrpc> })
ext → page : postMessage({ webcli:'mcp', dir:'to-page', ext, msg:<jsonrpc> })
on attach  : postMessage({ webcli:'mcp', dir:'to-page', ext, ready:true })   (best-effort — see F-46)
```

The DOM marker is the detection mechanism, not the `ready` frame: real-machine
testing showed `ready` reliably dispatching BEFORE the page's listener existed
([findings F-46](./tests/findings.md)) — document_start wins the race against
the page's own scripts, and postMessage delivery is a later task.

`msg` is the same JSON-RPC/MCP the Port spoke before (initialize / tools/list /
tools/call). Pages SHOULD echo the `ext` id from `ready`: a dev build and the
store build can coexist (§13), an untargeted frame would be executed by BOTH,
and twice matters the moment a write tool is involved — the relay drops frames
addressed to the other install.

What the switch bought and cost:

- **Bought**: any site the user trusts can integrate (was: two hardcoded ones);
  integrators no longer need the extension ID at all (the popup's ID row is
  gone); default is **empty = nobody**, where the old manifest granted localmd
  standing access to every install on earth.
- **Cost**: localmd.app loses its built-in path — it must adopt the postMessage
  protocol (its `chrome.runtime.connect(id)` no longer reaches WebCLI) *and*
  the user must add it. That is the intended trade: the trust decision moved
  from our manifest to the user's list.
- **Unchanged**: the WS daemon transport, which never involved a web page.

Real-machine rows live in [tests/platform.md](./tests/platform.md) §6 (fixture:
`relay-client.html`).

## 16. `fetch_url {stream_stop}` — carrying MCP Streamable HTTP (2026-07-31)

### Why this landed here

A browser-only app that speaks MCP can only reach servers that opt into CORS.
Measured against the 320 remote servers listed on mcp.so, **60% send no CORS
headers at all** — a page cannot talk to them, at all, ever. WebCLI's
`fetch_url` runs in the service worker under `<all_urls>`, so it is CORS-free by
construction; a browser app that routes its MCP traffic through the bridge gets
the other 60% back. Two response headers make that work, and both already
survived the trip intact:

- **`Mcp-Session-Id`** — the whole session lives in this response header.
- **`WWW-Authenticate`** — the head of the OAuth discovery chain (401 →
  protected-resource metadata → AS metadata → token endpoint). Note that a page
  fetching *directly* usually cannot read it: without
  `Access-Control-Expose-Headers` the browser hides it, and of the 103 servers
  that require auth only 15 expose it. Through the SW there is no CORS layer to
  hide anything, so all 103 are readable. That is not a side benefit of this
  route — for OAuth it is the route.

### The defect

`runFetch` read the body with `await res.text()`, which resolves when the server
**closes** the body. MCP's Streamable HTTP transport answers a POST with
`text/event-stream` and is explicitly allowed to hold that stream open after the
response message, so the read could only ever end in `timeout_ms`. The reply was
sitting in the buffer; nothing could get at it.

The split is exactly "does the body end?", not "is it SSE":

| server | content-type | ends? | buffered read |
| --- | --- | --- | --- |
| `mcp.platform.opentargets.org/mcp` | `text/event-stream` | no (`x-accel-buffering: no`, no length) | ❌ timeout |
| `mcp.mermaid.ai/mcp` | `text/event-stream` | yes (`content-length: 245`) | ✅ |
| `knowledge-mcp.global.api.aws` | `application/json` | yes | ✅ |

### The fix — an opt-in early stop

`stream_stop` selects a reader loop that may end before the body does:

| value | ends the read when | bounded by |
| --- | --- | --- |
| `"none"` (default) | the server closes the body | `timeout_ms` |
| `"first_event"` | the first complete SSE event carrying a `data:` field has arrived | `timeout_ms` |
| `"idle"` | nothing has arrived for `idle_timeout_ms` (default 5000) | `timeout_ms` |

`first_message` and `first` are accepted as aliases of `first_event` (MCP says
message, SSE says event); an unrecognized value **throws** rather than falling
back to `"none"`, because silently ignoring it reinstates the exact hang the
caller was trying to avoid. `idle_timeout_ms` deliberately does NOT apply to
`first_event`: a `tools/call` that thinks for 30 seconds before emitting its
event is normal, and an idle watchdog would cut it off holding nothing.

Three properties keep it honest:

- **`stream_open: true`** says *we stopped before the body ended*, so treat the
  body as a prefix. It does NOT claim the server had more to send — we cancelled
  without reading to `done`, so that is unknowable (real-machine: `mcp.mermaid.ai`
  under `first_event` returns `stream_open:true` with all 245 bytes, because its
  one event *is* the whole body). `stream_stop` is echoed next to it (the
  `with_cookies` precedent), and `note` says which rule fired.
- **`first_event` loses whatever the server sends next, and the event it keeps
  is not guaranteed to be the one you wanted.** Two separate spec sentences bite
  here. "After all JSON-RPC responses have been sent, the server SHOULD close
  the SSE stream" is the defect above — SHOULD, so holding it open is
  conformant. But also: "The server MAY send JSON-RPC requests and notifications
  **before** sending a JSON-RPC response." So on a server that reports progress,
  the first `data:` event is the progress notification and the reply is the one
  we just cancelled. `initialize` / `tools/list` have nothing to report and are
  safe; a long `tools/call` is exactly where this bites.

  We deliberately do NOT fix that by parsing the payloads and stopping at the
  event whose `id` matches — `fetch_url` is a generic HTTP primitive and must
  not learn JSON-RPC. The layering-correct answer is to state the limit and let
  the caller choose: `first_event` when the server sends one message,
  **`"idle"`** when notifications may interleave (it returns every event up to
  the quiet point, and the client picks its own message out).
- **`bytes` changes meaning** in stream mode: it counts what was *read*, because
  what the server still had to send is unknowable by construction.

Two smaller decisions:

- **Cancelling the reader is what releases the connection.** Per the fetch spec,
  cancelling a response's body stream terminates the ongoing fetch — so an SSE
  stream we walk away from does not stay open behind us. That is also why the
  request keeps using `AbortSignal.timeout` untouched: the default path needed
  no new machinery.
- **A mid-stream failure keeps the bytes already received** (with
  `stream_open:true` + a note) instead of throwing them away — but only if there
  are any. Zero bytes plus a timeout is just a timeout, and is reported as one.

**Backward compatibility is structural, not tested-into-place**: `"none"` runs
the original `res.text()` lines, and `stream_stop` / `stream_open` are absent
from the result object unless the streaming path ran. `tests/generic-fetch-url.test.ts`
pins that (`'stream_open' in r === false`) alongside SSE framing, cancellation,
the max_bytes cap, and header survival.

### Real-machine verification (2026-07-31, dev build on 9377)

| check | result |
| --- | --- |
| `opentargets` + `first_event` | **2.32s** (was: timeout), `stream_open:true`, body parses to `result.protocolVersion`. Its framing is CRLF (`\r\n\r\n`) — the reason `firstDataEventEnd` accepts all three line terminators rather than just `\n\n` |
| `mermaid` / `aws`, no new args | 245 / 171 bytes — matching their `content-length` exactly, i.e. the old whole-body read, and neither `stream_stop` nor `stream_open` present in the result |
| `notion` headers | `www-authenticate: Bearer realm="OAuth", resource_metadata=…` fully readable |
| `mcp-session-id` on the **streaming** path | `aws` + `first_event` → `3b62ddcf-…` (mermaid turns out not to issue one; aws and scite do) |

### Why not a streaming tool

The alternative — a new tool that pushes increments back as multiple `to-page` /
WS frames — is more general (it would support server-initiated pushes) but
requires changing the relay from its id-matched request/response shape (§15).
No current client needs server pushes: a JSON-RPC client sends a request and
reads one response. Deferred until something actually needs a feed.

### Open: `api.scite.ai/mcp` hangs and is not SSE

`Content-Type: application/json`, `Content-Length: 3039`, curl returns 200 in
1.6s — yet it times out through `fetch_url`. Ruled out by the reporter:
concurrency, cookies (`with_cookies:false` hangs too), `Origin`, and User-Agent.
Ruled out here: content encoding (it answers `content-encoding: gzip` +
`Transfer-Encoding: chunked` to a Chrome-shaped `Accept-Encoding` and still
completes in 1.3s), HTTP version, and the `Sec-Fetch-*` header set. It also
sends `Access-Control-Allow-Origin: *`, so it is not a CORS-layer stall.

The leading hypothesis was that the bytes arrive but the connection is never
*terminated* (chunked response through Kong + CloudFront, `server: uvicorn`), so
only the close is missing — which `stream_stop:"idle"` would both diagnose and
work around.

**It did not reproduce.** Real-machine, 2026-07-31, dev build on 9377: 8/8
successes, `default` 1.44 / 3.45 / 3.52 / 4.27s against `idle` 3.27 / 3.28 /
3.16 / 3.57s, every one of them 3128 bytes. The buffered read is *not* slower
than the incremental one here, and `idle` reports `stream_open:false` every time
— the watchdog never fires because the stream ends on its own. So the hypothesis
above is disproved on this machine: nothing is holding the connection open.

That leaves the hang as environment-specific (network path / CloudFront PoP /
a since-fixed server bug). Two things to carry forward if it returns:

- **The decisive test still stands.** `stream_stop:"idle"` returning the full 3KB
  means the body arrived and only the close was missing (and is the workaround);
  returning **empty** means Chrome never received a body byte, which puts the
  problem below the tool, where no `fetch_url` change can reach it.
- **Check "hung" vs "merely slow" first.** scite runs slower through the SW than
  through curl (1.6s) and varies up to 4.3s. On a worse path it can plausibly
  cross the default `timeout_ms` of 20000, which presents as a reliable timeout
  rather than as latency. Re-run with a large `timeout_ms` before concluding it
  hangs.

## 17. The shared primitive base grows — eval_js, recon, site scripts (2026-09)

WebCLI stopped being "the 28 generic browser tools" and became the shared
**primitive base** the three shells agree on (`docs/architecture.md` §A.2). Four
groups now, registered by `tools/generic/_generic.ts`:

1. the 28 generic browser tools;
2. **`eval_js`** — page-context JavaScript (MAIN world over CDP);
3. **recon primitives** — `find_in_dom`, `find_structured_data`, `get_a11y_tree`,
   `capture_network` (tab-addressed; the explore-only versions still live in
   `tools/explore/`, but these base ones take a `tab_id` and reach an explore
   session, when one exists, only through the `core/explore-gate` seam);
4. **site scripts** — `create_site_script` / `preview_site_script` /
   `list_site_scripts` / `set_site_script_enabled` / `delete_site_script`.

Surface: 28 → **38** tools. Pinned by `tests/webcli-tool-surface.test.ts`.

### 17.1 The site-script confirm contract in WebCLI

Site scripts inject persistent CSS/JS into the user's pages on every visit — a
high-trust capability. The other shells confirm it through a UI they own (the
full shell's write-confirm; localmd's card). WebCLI has no such UI and, by its
whole contract, an external CLI agent drives it. So the contract is:

- **The calling agent confirms.** `create_site_script` carries `access: 'write'`
  and, for css/js, is the agent's to spell out to its user before calling —
  exactly as the agent is accountable for every other write here (the WS bridge's
  write gate is open by construction). This mirrors localmd delegating the
  confirm to its app; WebCLI delegates it to the CLI agent.
- **The popup is the standing control** (the "user disposes" half). WebCLI's
  toolbar popup lists every installed site script with a pause toggle and a
  delete button, and warns when "Allow user scripts" is off. It reads and mutates
  the store directly (the popup holds the `userScripts` permission) and
  re-registers via `refreshSiteScript`, so a pause/delete takes effect at once.
  `src/background/webcli-service-worker.ts` calls `syncSiteScriptsOnBoot()` on
  boot, like the other shells, so enabled rules survive an SW recycle.
- **The manifest** gains `userScripts`; until the user flips "Allow user scripts"
  the tools report they cannot run (they do not fail silently).

`npm run build:webcli:dev` → `dist-webcli-dev/` carries all of the above; verify
the popup management + the toggle on a real load (docs/webcli.md §13).
