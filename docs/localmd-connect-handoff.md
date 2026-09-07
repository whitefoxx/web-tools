# localmd-side integration — handoff prompt

> Paste everything below the line into a Claude Code session in `~/code/localmd`
> to implement the client side of localmd Connect. The extension side is done in
> `web-agent` (see `docs/localmd-connect.md`, the contract source). Keep the two
> docs in sync if the contract moves.

---

Integrate a NEW companion extension, **localmd Connect**, as a first-class tool
source next to the existing WebCLI integration. localmd Connect is built from
the same codebase as WebCLI by the same author and speaks the SAME postMessage
relay protocol — it is WebCLI's 28 generic browser tools PLUS marketplace site
adapters and persistent site scripts, made for localmd specifically. Everything
you know about the WebCLI relay applies; the deltas are listed below.

## The contract (extension side is already shipped)

- **Detection marker**: `document.documentElement.dataset.localmdConnect`
  (attribute `data-localmd-connect`) holds the extension id. WebCLI's marker
  (`dataset.webcliRelay`) is untouched — a page can carry both, and each is
  detected independently.
- **Envelope**: identical to WebCLI — `{ webcli:'mcp', dir:'to-ext'|'to-page',
ext, msg:<jsonrpc> }` over `window.postMessage`, `ready` frame on attach,
  MCP 2025-03-26 (`initialize` → `notifications/initialized` → `tools/list` →
  `tools/call`), 1 MB frame cap, no `web_task`.
- **`ext` is now a MUST, not a SHOULD**: both extensions listen for the same
  envelope, so every `to-ext` frame MUST carry the target extension's id (read
  from the marker). An untargeted frame would be executed by BOTH extensions —
  twice — which matters the moment a write tool is involved. Audit the existing
  WebCLI client for this too.
- **Origin**: the allowlist is **compiled into the extension** and cannot be
  edited. The store build allows exactly `https://localmd.app`, so production
  works with zero setup beyond installing. `http://localhost:5173` is allowed
  only in the extension's DEV build (`npm run build:localmd:dev` in the
  web-agent repo, loaded unpacked) — so when you develop localmd against a dev
  server, load that build; there is no popup setting to add an origin.
- **Tool surface**: the 28 WebCLI generic tools plus:
  - `find_adapters {query}` (read) — searches ~300 marketplace site adapters
    (twitter/zhihu/reddit/youtube/…; CN↔EN aliases). Rows include `access`
    (read/write), `type` (pipeline/func), `status`.
  - `run_adapter {site, name, args}` (write) — loads the adapter on demand
    (sha256-verified, per-session) AND executes it, in one call. `args` is a
    JSON object (string or object both accepted). There is NO load_adapter and
    the catalog never changes size — this design exists precisely because your
    AI-SDK runtime cannot grow its tool set mid-turn.
  - `create_site_script {matches, hide_selectors, css, js, label, run_at}`
    (write), `list_site_scripts` (read), `set_site_script_enabled` (write),
    `delete_site_script` (write), `preview_site_script {tab_id,
hide_selectors, css, highlight, dry_run_js}` (read) — persistent
    hide/CSS/JS rules that run on matching page loads (ad removal, page
    enhancement). They require the user's one-time "Allow user scripts" toggle;
    tools report `runnable: false` until it is on.
  - `find_in_dom {text, tab_id}` (read) — value→selector reverse lookup, the
    discovery step for site-script selectors.
- **CONFIRM CONTRACT (normative, you own this)**: the extension does NOT gate
  writes — it trusts localmd's UI, per your "agent proposes, user disposes"
  doctrine. localmd MUST get explicit user confirmation BEFORE the agent calls:
  1. `run_adapter` on an adapter whose `find_adapters.access` is `write`
     (posting, messaging, deleting on real sites);
  2. `create_site_script` with `css` and/or `js` (persistent code injected into
     the user's pages) — show the match patterns and the exact css/js;
     hide-only (`hide_selectors`) may go through with lighter confirmation at
     your discretion. Encourage the agent (via tool-source prompt copy) to
     `preview_site_script` first so the confirm can show real effects
     (`highlight: true` outlines what would be hidden; `dry_run_js` runs the JS
     once, non-persistently, and returns console output/errors).
     The user's standing fallback lives in the extension popup (pause/delete any
     script), so your confirm is the front line, not the only line.

## Implementation outline (your codebase)

1. **Relay client** (`src/lib/webcliRelay.ts`): generalize the marker read —
   `relayExtensionId(markerAttr)` — and make `McpRelayClient` take the marker
   (dataset key) as config. Verify every outgoing frame sets `ext`. The rest
   (handshake, timeouts, `flattenToolResult`) is shared as-is.
2. **Catalog** (`src/lib/toolCatalog.ts`): **REPLACE the `webcli` entry with a
   `localmd-connect` entry** — `kind: 'extension'`, featured, paid; its own
   sentinel URL (e.g. `localmd-connect://relay`) resolved in `stores/mcp.ts`
   `clientFor()` to a relay client with the `localmdConnect` marker.
   **Corrected 2026-08-07 — do NOT simply replace the webcli row yet.** The
   original advice here said replace-don't-add, reasoning that WebCLI's relay
   had never shipped. It did: **0.2.0 is live and users are on it today**, so
   the webcli row works right now, and removing it strands anyone who has not
   installed localmd Connect (which is not on the store yet either). Keep both
   rows through the migration: webcli marked deprecated, with copy pointing at
   localmd Connect ("WebCLI drops web-app access in its next update — install
   localmd Connect to keep these tools"), and prefer localmd Connect whenever
   both are detected. Drop the webcli row once WebCLI 0.3.0 is live. The 28
   generic tools are identical either way, so nothing is lost in the interim.
3. **Presence / reconnect** (`src/stores/mcp.ts`): reuse the relayExt polling
   (focus/visibility/5s-while-waiting) per marker.
4. **Licence**: ~~gate exactly like the WebCLI row — connect and callTool
   blocked when `restricted` (`stores/licence.ts`). It is part of the paid
   tier;~~ **superseded 2026-09-07** — localmd.app is free and open source, and
   no licence gate was ever implemented (`stores/licence.ts` does not exist).
   Nothing to gate. `BUNDLED_TOOL_SOURCES` unchanged.
5. **Naming**: tools surface as `mcp__<sanitized-server>__generic__run_adapter`
   etc. — 36 tools will trip the defer threshold like WebCLI's 28 already do;
   the existing `enable_tools` deferred flow handles it. Consider keeping
   `generic__find_adapters` + `generic__run_adapter` + `generic__fetch_url` in
   the always-active set for this server: they are the workhorse trio.
6. **Prompt copy** (`src/agent/prompt.ts` + tool-source description): teach the
   agent the flow — find_adapters BEFORE scraping a mainstream site;
   run_adapter for hits; write-access adapters and css/js site scripts need the
   user's confirmation (your setup-card / confirm primitives); site scripts are
   for recurring page problems ("remove ads on X" → create once, works every
   visit).
7. **UI** (`src/components/settings/ToolsSection.vue` + i18n en/zh +
   `docs/app/tools.md`): a detail pane mirroring WebCLI's — install link
   (https://chromewebstore.google.com/detail/localmd-connect-browser-s/bgennbocoapjiiolmmlcbfingimhmchh,
   live since 2026-08-12; for dev, load `dist-localmd-dev/` unpacked from the
   web-agent repo, id `enodecpmlecfpmofogpmbagdcfheamgf`), the "Allow user scripts"
   toggle step (needed for func adapters + site scripts; pipeline adapters work
   without it), the localhost-origin step for dev, and the note that
   localmd.app itself needs no origin setup.
8. **Confirm UX**: implement the confirm contract from above wherever tool
   calls are dispatched (the same seam that gates licence at callTool is a
   candidate) — a write-adapter run_adapter call and a css/js
   create_site_script call must not reach the extension without user approval
   recorded.

## Verify end-to-end

Dev: build the extension in ~/code/web-agent (`npm run build:localmd`), load
`dist-localmd/` unpacked, enable "Allow user scripts", add your dev origin in
the popup, reload localmd. Then: detect marker → connect → 36 tools listed →
`find_adapters {query:"hackernews"}` → `run_adapter {site:"hackernews",
name:"top"}` returns rows (no toggle needed, pipeline) → a func adapter (e.g.
zhihu) exercises the toggle path → create a hide-only site script on a test
site, see it apply on reload, pause/delete it from the extension popup → a
css/js create runs through your confirm UI. With WebCLI also installed, verify
both rows connect and no call executes twice (the `ext` targeting).

---

## Phase 1 addendum — knowledge-base capture (2026-09-03)

The extension now also carries the web clipper and a browser-side capture
inbox: `clip_page` / `list_inbox` / `ack_inbox` (39 tools), the server→client
notification `notifications/localmd/inbox {count}`, a 16MB outbound frame
ceiling (inbound unchanged), a context menu + `Alt+Shift+S` / `Alt+Shift+L`

- popup buttons on the user's side. The client-side checklist — handle the
  notification, write the clip note, keep MCP image blocks, attach the tab on an
  `ask`, prompt copy — is `docs/localmd-connect.md` §14.5; the design is §14.
