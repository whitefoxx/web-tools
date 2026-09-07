# localmd Connect — release log & release process

The Chrome Web Store history of the **localmd Connect** shell
(`manifest.localmd.json` → `dist-localmd/`), plus the checklist for cutting the
next one. WebCLI and the full Web Agent extension are separate store items with
their own version lines — [webcli-releases.md](./webcli-releases.md) owns
WebCLI's, and nothing here applies to either.

- Store item id: **`bgennbocoapjiiolmmlcbfingimhmchh`** — 0.1.0 live since
  2026-08-12. `manifest.localmd.json`'s `key` holds this item's public key
  (recovered from the CRX), so an unpacked shipping build resolves to it too
- Dev-load id: `enodecpmlecfpmofogpmbagdcfheamgf`, from `LOCALMD_DEV_KEY` in
  `vite.config.ts` (private half `extension-key-localmd.pem`, gitignored) —
  `--mode localmd-dev` only, so it can sit beside the store install
- Listing copy + promo assets: `store/localmd-connect/`
- Architecture: [localmd-connect.md](./localmd-connect.md)

## 1. Identity — settled at first publish, kept here for the reasoning

WebCLI learned this the expensive way ([webcli-releases.md](./webcli-releases.md)
§1). localmd Connect walked the same doorway and is now through it — the swap
below was done 2026-08-18. Kept because the reasoning is what makes the current
state legible, and because the full Web Agent shell has yet to go through it:

**The store ignores `key` on upload and assigns its own id.** Chrome derives an
extension id from a PUBLIC key — from the manifest's `key` for an unpacked load,
from the CRX signature for a store install. Our `key` therefore controlled only
the DEV id, and the published id came out as `bgennb…`, not the `enodec…` the
self-generated key produced.

Two consequences, both now handled:

1. ✅ **The store's public key is in `manifest.localmd.json`'s `key`** (recipe in
   webcli-releases.md §1), so an unpacked shipping build resolves to the
   published id. For the six days before that, an unpacked build and the store
   install were two different extensions to Chrome, both writing
   `data-localmd-connect` and both answering localmd, last writer winning —
   exactly the double-execution the relay's `ext` targeting exists to prevent.
   Anyone who had both installed in that window was driving whichever one won
   the attribute.
2. **Nothing in the product hardcodes the id, and it must stay that way.**
   localmd detects the extension through the DOM marker
   (`data-localmd-connect`, whose value is `chrome.runtime.id` at runtime), so
   the client adapts by itself. The places that DO name the dev id are docs and
   localmd's store link — update those, and never let an id into code.

## 2. Versioning

`manifest.localmd.json`'s `version` is the only source of truth; Vite copies it
into `dist-localmd/manifest.json` verbatim. It is independent of WebCLI's line
and of `package.json`. The store requires a strictly increasing version and
never allows one to be reused — not even after a rejected upload.

## 3. What every release must touch

Same shape as WebCLI's table, with this shell's specifics. `npm run check`
catches code drift; nothing catches the rest.

| Changed?                                          | Then update                                                                                                                                                            | Why it rots silently                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| always                                            | `manifest.localmd.json` → `version`                                                                                                                                    | the store rejects a reused version                                                                                       |
| always                                            | `description` ≤132 chars and `name` ≤45 — both pinned by `tests/localmd-tool-surface.test.ts`                                                                          | the dashboard rejects the upload outright                                                                                |
| always                                            | §5 below — a new entry, **PUBLISHED** only after the CRX check confirms it                                                                                             | WebCLI's log carried a PREPARED entry for a week after it went live, and a later decision was made on that false premise |
| tool added / removed                              | `tests/localmd-tool-surface.test.ts` (count + membership), `store/localmd-connect/store-listing.md`, and `render.mjs` if a screenshot names it → re-render + re-raster | the screenshots are IMAGES; nothing type-checks them                                                                     |
| the confirm contract (§7 of the architecture doc) | `store-listing.md`'s "YOU DECIDE, ALWAYS" block, and localmd's own UI — they are one promise made in two places                                                        | the listing is what a user reads before trusting it                                                                      |
| adapter/site-script behavior                      | `LOCALMD_CONNECT_INSTRUCTIONS` in the SW, and the tool descriptions                                                                                                    | they ARE the interface for a shell with no agent of its own                                                              |
| permissions                                       | the per-permission justification table in `store-listing.md`; expect a slow review on `userScripts` / `debugger`                                                       | a silent permission delta is the #1 review stall                                                                         |
| the popup                                         | nothing in the assets today — no screenshot depicts it. If you add one, it will rot fastest                                                                            |
| anything user-visible                             | `docs/localmd-connect.md` + `docs/tests/platform.md`                                                                                                                   | the next session starts from the docs                                                                                    |

## 4. Release checklist

1. **Pre-flight.** Clean tree, `npm run check` green — especially
   `tests/localmd-tool-surface.test.ts` (36 tools, membership, manifest limits).
2. **Bump** `manifest.localmd.json` → `version`.
3. **Sweep `store/localmd-connect/`**: `store-listing.md` (tool/adapter counts,
   the feature bullets, the setup steps) and `render.mjs` (the same facts, baked
   into images). Then:
   ```bash
   node store/localmd-connect/render.mjs        # svg/ + promo.html, pure Node
   # raster.mjs needs sharp, which is NOT a repo dep, and ESM ignores NODE_PATH:
   ln -sfn ~/code/ai-image/node_modules/sharp node_modules/sharp   # from the REPO ROOT
   node store/localmd-connect/raster.mjs && rm node_modules/sharp  # → images/*.jpg
   ```
   **Then look at every regenerated image.** Not ceremony: the first render put
   a chip flush against a brace and left a void under the panel, and WebCLI's
   set once shipped a label overflowing its card. Mono text in a card fits about
   15 chars; a tool name at size 26 is ~200px wide.

   **And never enumerate site names.** Not in the description, not as chips in a
   screenshot, not in a promo tile — a list of third-party brands is keyword
   spam under the store's metadata policy, and it is what got 0.1.0 rejected
   (§5). Describe the catalogue by category and let the public repo hold the
   list. One site name inside a runnable API example is fine; a row of them is
   not.
4. **Build.** `npm run build:localmd` (or `npm run build:all`).
5. **Verify the artifact:**

   ```bash
   node -e "const m=require('./dist-localmd/manifest.json');console.log(m.version,m.name)"
   # Since 0.2.0 only these two are emitted (the adapter-eval trio went with the
   # adapters):
   for f in web-relay.js page-tools.js; do
     ls dist-localmd/$f >/dev/null || echo "MISSING $f"
   done
   # …and these must NOT be there, nor a sandbox/WAR entry in the manifest:
   for f in sandbox.html offscreen.html offscreen.js; do
     [ -e dist-localmd/$f ] && echo "STALE $f — adapter-eval artifact, rebuild clean"
   done
   node -e "const m=require('./dist-localmd/manifest.json');console.log('sandbox:',m.sandbox,'| WAR:',m.web_accessible_resources,'| offscreen perm:',m.permissions.includes('offscreen'))"

   # The dev-only capability must NOT be in the upload. All of these must be 0,
   # and `alarms` must be absent — the shipping build has no daemon to redial.
   SW=$(ls dist-localmd/assets/localmd-connect-service-worker.ts-*.js)
   for s in createWsBridge localhost:8123 REDIAL bridgePort; do
     echo "$s $(grep -c "$s" "$SW")"
   done
   node -e "const m=require('./dist-localmd/manifest.json');console.log('alarms:',m.permissions.includes('alarms'))"
   ```

   All three of the last line should print `undefined | undefined | false`. The
   adapter runtime used to be the part that failed silently; since 0.2.0 the risk
   is the opposite — a stale `dist-localmd/` still carrying those artifacts means
   you are about to upload the pre-0.2.0 build.

   Then smoke-test **`dist-localmd/`, not `dist-localmd-dev/`**. The dev build
   is not a stand-in here the way a dev-identity build usually is: it carries a
   whole extra transport and two extra allowed origins
   ([localmd-connect.md](./localmd-connect.md) §12), so testing it proves
   nothing about the artifact you are uploading. With "Allow user scripts" on,
   cover at minimum a capture landing in the inbox, a highlight surviving a
   reload, one recon tool, and a site script surviving a page reload — driven
   from localmd.app itself, since the store build has no daemon to drive it
   with. (This line used to name a pipeline adapter and a func adapter; 0.2.0
   removed both, which made the checklist ask for a test that cannot be run.)

6. **Package it** — `npm run pack:localmd`. Never hand-zip `dist-localmd/`: the
   dashboard rejects a manifest carrying `key` ("key field is not allowed in
   manifest"), and ours has one deliberately (§1). The script strips it on a
   staged copy — leaving the build itself loadable unpacked at its stable id —
   puts `manifest.json` at the zip root, and verifies both before printing the
   path:
   ```bash
   npm run pack:localmd    # → /tmp/localmd-connect-<version>.zip
   ```
7. **Upload / create the item.** A first submission needs more than an update:
   category, language, a privacy policy URL, the single-purpose statement, the
   per-permission justifications, and the **remote-code disclosure** — adapters
   are fetched from a public GitHub repo at runtime and evaluated in the
   sandboxed offscreen document. All of that text lives in `store-listing.md`.
8. **Submit for review.** Budget for a slow one: `userScripts` + `debugger` +
   `<all_urls>` on a brand-new item is the profile reviewers look hardest at.
9. **After it goes live:** run the CRX check to confirm the version, recover the
   store's public key and swap it into `manifest.localmd.json` `key` (§1), fix
   the store link in localmd's catalogue entry, and flip the §5 entry to
   **PUBLISHED** with the id and date.

## 5. Version history

Marked **PUBLISHED** only after the CRX download confirms it — never from
intent, and never inferred from this file.

### 0.1.0 — submitted 2026-08-07 · rejected 2026-08-10 · **PUBLISHED 2026-08-12**

Item id **`bgennbocoapjiiolmmlcbfingimhmchh`**, confirmed 2026-08-18 by downloading
the live CRX: manifest inside reads `version: 0.1.0`, carries no `key`, has
gained `update_url`, and its service worker contains no `createWsBridge` and no
redial alarm — the dev-only capability is genuinely absent from what shipped.

First release. The shell itself landed 2026-08-06 (`d0063e8`) and is documented
in [localmd-connect.md](./localmd-connect.md); this entry covers only what
shipping it involves.

- 36 tools: the 28 generic browser tools, plus `find_adapters` / `run_adapter`,
  `find_in_dom`, and the five site-script tools.
- Dedicated icon (localmd's brackets, centre dot replaced by a bolt), and store
  assets in this shell's own blue — WebCLI owns blue→purple, this is
  blue→blue on localmd's #58A6FF.
- Verified end to end against localmd.app on a real browser before packaging:
  36 tools listed, an adapter run inside one localmd turn, and both write gates
  holding (docs/tests/platform.md §7b).

**Submitted 2026-08-07.** Two things bit on the way in, both now fixed and
both worth knowing before the next one: the store REJECTS a manifest carrying
`key` (findings.md F-49), so packaging goes through `npm run pack:localmd`; and
the first corrected zip was uploaded from the wrong path because the script
wrote to `os.tmpdir()` while a stale same-named file sat in `/tmp`.

**Rejected 2026-08-10 — keyword spam** (violation ref "Yellow Argon", routing
FZSL). Nothing about the package, the permissions or the remote-code disclosure
was questioned; the whole finding was one sentence of listing copy.

- **Symptom.** Review quoted `Twitter/X, Zhihu, Reddit, YouTube, Bilibili,
  Xiaohongshu, Weibo, LinkedIn,` out of the description and called it
  "excessive and / or irrelevant keywords".
- **Root cause.** The adapters paragraph sold the catalogue by listing the
  brands in it — fourteen names in one sentence. Truthful (every one of them
  has adapters) but structurally indistinguishable from SEO stuffing, and the
  metadata policy names the description explicitly. `screenshot-3-adapters`
  carried the same list as sixteen chips, so the surviving copy would have
  re-tripped it on the next pass even though only the text was cited.
- **Fix.** `store-listing.md` now describes the catalogue by category and
  points at github.com/whitefoxx/web-agent-marketplace for the actual list;
  `render.mjs` S3 swaps the brand chips for category chips with counts
  (`Social feeds · 103`, `Forums & Q&A · 64`, … summing to 294), and the
  `find_adapters` example queries by intent instead of by site name. One site
  name survives, as the value `run_adapter` gets back — that is an API example,
  not a list. Re-rendered and re-rastered; only S3 and promo.html changed.
- **Resubmission is listing-only.** The zip is untouched, so there is no
  version bump and no new upload: edit the description and replace screenshot 3
  in the dashboard's Store listing tab, then submit for review. §2's
  no-reused-version rule binds packages, not listing text — bumping to 0.1.1
  here would only cost a rebuild and desynchronise the log.
- **Lesson.** Store metadata is not documentation. Anything that reads as a
  list of other companies' products is a spam signal regardless of accuracy,
  and it must be scrubbed from the images in the same pass as the text —
  screenshots and promo tiles are metadata too, per the policy paragraph the
  rejection quotes.

Post-publication follow-ups, done 2026-08-18 (six days late — the log said
"when it goes live" and nothing watched for the moment it did):

1. ✅ CRX check run, this entry flipped to PUBLISHED with the confirmed date.
2. ✅ The store's public key recovered from the CRX into `manifest.localmd.json`'s
   `key`. Until this was done, an unpacked build and the store install were two
   extensions to Chrome — both writing `data-localmd-connect`, both answering
   localmd, last writer winning. `LOCALMD_DEV_KEY` in `vite.config.ts` keeps the
   old self-generated key, so `--mode localmd-dev` still coexists with the store
   copy; `--mode localmd` no longer can, by design.
3. ✅ localmd's catalogue entry already carries the store URL
   (`src/lib/toolCatalog.ts`), and `localmd-connect-handoff.md` now names the
   store link with the dev id demoted to a parenthetical — checked, not assumed:
   the item had been sitting here as "it currently has none" while the localmd
   side had done it.
4. ✅ WebCLI 0.3.0 went live 2026-08-09 and localmd's deprecated `webcli`
   catalogue row is already gone; only the relay's `webcli:` envelope tag
   remains, which is a wire-format constant and not a product reference.

### 0.2.0 — 2026-09-07 · **PREPARED** (not yet uploaded)

Supersedes the 0.1.1 plan below, which was never submitted — its tab-lifecycle
fix ships inside this release. The first release cut from **`web-tools`** rather
than `web-agent`. The tool surface went **36 → 58**, one permission was
**removed**, and the remote-code answer flips from **YES to NO**.

**Site adapters are gone.** `find_adapters` and `run_adapter` are no longer
registered, and the ~294-entry marketplace is not consulted by this shell at
all. They were labelled experimental on 2026-09-05 and retired on 2026-09-06:
a per-site catalogue rots (every entry needs a checksum rotation and a
real-browser re-verify when a site changes its markup), and most of it was not
knowledge-base work. What replaces them is capability, not a catalogue — see the
recon tools below and `docs/localmd-connect.md` §15.

Three consequences that matter to the store:

- **Remote code: NO.** Nothing is fetched from GitHub at runtime any more.
  This is the single biggest review-surface improvement in the release.
- **The `offscreen` permission is removed** — it existed to evaluate adapter
  source in a sandboxed document. With it went the emitted `sandbox.html`,
  `offscreen.html/js` and the `userscript-runner.js` web-accessible resource,
  which had kept shipping as dead weight after the tools were gone (and
  `offscreen.js` was pulling full-shell UI code into this bundle).
- **The listing had to be rewritten**, not swept: adapters were its second
  headline, one of its three value chips, and an entire screenshot.
- **No paid tier any more, and a new icon.** localmd.app became free and open
  source on 2026-09-07, so every "part of the paid tier" line came out of the
  listing, the hero image, the README and the service worker's header — and the
  licence gate the handoff doc told localmd to build was never implemented, so
  nothing functional changed. The icon's lightning bolt became a **mouse
  cursor**: the extension clicks for you, it is not a speed boost.
  `public/icons/localmd-connect.svg` is the source, but `store/…/render.mjs`
  carries its own copy of the glyph path — **change both**, then regenerate the
  four PNGs (sharp, never qlmanage: it bakes a white background) and re-run
  `render.mjs` + `raster.mjs`. Changing the icon changes the uploaded artifact,
  so the zip must be repacked.

**What the shell gained instead.**

- **Capture, the everyday path** — `clip_page` (whole page / selection, with a
  TextQuote anchor to cite back), the browser-side capture inbox (`list_inbox`,
  `ack_inbox`), region screenshot with annotation, a PDF in a tab filed as the
  file, and "save every tab in this window". Context menu + keyboard shortcuts,
  so capturing costs a keystroke.
- **Highlights** — mark passages in any page, write a note on one, they survive
  the next visit; `get_highlights` / `delete_highlights` let the agent read back
  what the user marked by hand. `clip_page` carries a page's highlights with it.
- **The in-page toolbar's prompts** — translate / explain / a prompt the user
  wrote, answered in a popover by localmd's own model over MCP sampling (this
  shell holds no API key).
- **The browser's own data behind OPTIONAL permissions** — bookmarks, history,
  reading list, recently-closed. Granted per-switch in the popup, revocable,
  and absent from the install prompt.
- **Recon + `eval_js`** — `find_structured_data`, `get_a11y_tree`,
  `capture_network`, `find_in_dom`, and page-origin JavaScript. This is how a
  site with no ready-made tool gets reached now: the agent works it out live and
  the user saves the recipe as a skill of their own.
- **`get_site_script`** — a saved site script's full source. A rule the user
  cannot read back is one they cannot audit; the options page grew a
  tap-to-expand view of the same.
- **A write gate on the generic tools.** `click` and `press_key` recognise a
  write control (a submit button, a post/send/delete label, Cmd/Ctrl+Enter) and
  refuse it unless the call carries `allow_write`, so localmd's confirmation
  card cannot be bypassed by driving the page's own UI by hand. This closed a
  real hole: a tweet was posted during testing with no confirmation.
- The 0.1.1 tab-lifecycle fix (pool tabs reaped, agent window closes when only
  its placeholder is left).

**Listing + assets rewritten** (`store/localmd-connect/`): summary and value
chips lead with browser tools + one-key capture; the adapter section is replaced
by capture / highlights / recon; `screenshot-3-adapters` is replaced by
`screenshot-3-capture`; the toolbelt screenshot gained capture, highlights,
recon and browser-data rows (re-measured to clear the 800px edge); the Dashboard
fields drop the `offscreen` justification, gain `contextMenus` and the optional
browser-data permissions, and answer remote code **NO**. Still no site names
anywhere — the 0.1.0 rejection stands as the rule.

**Before uploading:** §6's runbook, with one amendment — step 5's artifact check
lists `sandbox.html`, `offscreen.html`, `offscreen.js` and `userscript-runner.js`
as must-exist. As of this release they must be **ABSENT**; only `web-relay.js`
and `page-tools.js` are expected. Step 6's smoke test should cover capture,
highlights, a site script surviving a reload, and the write gate — not adapters.

### 0.1.1 — PLANNED (tab lifecycle)

Not yet submitted. One code change since 0.1.0 (`ff1d6bb`), and it touches
nothing the store cares about: no tool added or removed (still 36), no
permission delta, no change to the confirm contract. **The listing and the
screenshots therefore do not need a pass** — this is a package-only update,
which is the cheap kind.

- **Site-pool tabs are reaped.** `run_adapter` leases a tab per site from a pool
  whose ids never leave the executor, so the calling agent could not close them
  if it tried — and this shell, unlike the full one, never armed the idle pass
  that closes them. They accumulated until the browser did.
- **The agent window closes when only its `about:blank` placeholder is left.**
  The placeholder exists to stop the window churning per task, which is right in
  a shell with a SidePanel and wrong in a headless one that goes quiet for hours.
- `LOCALMD_CONNECT_INSTRUCTIONS` reworded: it claimed "nothing here reaps them",
  which is no longer literally true. What the caller is promised is unchanged —
  a tabId it holds stays valid until it calls `close_tab`.
- Verified on a real browser before this entry was written: a `search.douban.com`
  pool tab present while `run_adapter` runs, gone ten quiet seconds later,
  agent window with it. See docs/tests/platform.md §1.

Follow §6's runbook to ship it.

## 6. Runbook — shipping an UPDATE, step by step

§4 is the checklist that covers the first submission too, and most of it is
first-submission work you will never do again. This is the version you actually
follow now: one item already exists in the store, and every future release is a
package update against it. Run it top to bottom; each step says what "good"
looks like, so you can tell a pass from a silence.

Two facts to hold on to before starting:

- **Versions are one-way.** The store rejects a reused version even after a
  rejected upload. If you burn 0.1.1, the next attempt is 0.1.2.
- **`manifest.localmd.json` now carries the STORE's public key**, so an unpacked
  `dist-localmd/` resolves to the SAME id as the store install
  (`bgennbocoapjiiolmmlcbfingimhmchh`). Chrome allows one id per profile — see
  step 6, which is where that bites.

### 0. Decide the version number

Patch (`0.1.x`) for fixes and internals. Minor (`0.x.0`) when the tool surface,
the permissions, or the confirm contract move — those also drag the store
listing and screenshots along (§3's table).

### 1. Pre-flight

```bash
cd ~/code/web-agent
git status --short          # must be empty; a release is cut from a clean tree
npm run typecheck
npx vitest run
```

Those two are the gate. `tests/localmd-tool-surface.test.ts` is the one that
matters most here: it pins the 36-tool membership and the store's `name` ≤45 /
`description` ≤132 limits, which the dashboard rejects outright.

`npm run check` also runs lint + format, and as of 2026-08-18 **lint is red on
this tree for reasons that predate any release** — 26 errors in `_mini-dom.ts`
and a handful of adapter test helpers. Run it if you like, but do not read a red
`check` as "this release is broken"; read the file list, and only stop if a file
YOU touched is in it.

### 2. Walk §3's table

Read it and answer honestly for this release. Tools added or removed, a
permission delta, or a change to the confirm contract each drag extra work
(listing copy, screenshots, the justification table) — and a permission delta is
the single biggest cause of a slow review. If none of them moved, this is a
package-only update and steps 3–9 are the whole job.

### 3. Bump the version

```bash
# edit manifest.localmd.json → "version"
node -e "console.log(require('./manifest.localmd.json').version)"
```

### 4. Build

```bash
npm run build:localmd       # → dist-localmd/
```

### 5. Verify the artifact

Paste the whole block. Everything must print what the comments say.

```bash
node -e "const m=require('./dist-localmd/manifest.json');console.log(m.version, '|', m.name)"

# Since 0.2.0 the adapter-eval trio is NOT emitted. web-relay.js and
# page-tools.js are; the rest must be absent (a stale dist means a stale upload).
for f in web-relay.js page-tools.js; do
  ls dist-localmd/$f >/dev/null || echo "MISSING $f"
done
for f in sandbox.html offscreen.html offscreen.js userscript-runner.js; do
  [ -e dist-localmd/$f ] && echo "STALE $f — pre-0.2.0 adapter-eval artifact"
done
node -e "const m=require('./dist-localmd/manifest.json');console.log('sandbox:', m.sandbox, '| WAR:', m.web_accessible_resources, '| offscreen perm:', m.permissions.includes('offscreen'))"

# Dev-only capability must NOT be in the upload. All three counts must be 0, and
# alarms must be false — the shipping build has no daemon to redial.
# (Do NOT grep localhost:5173: it appears once inside an error-message string,
# so a non-zero count there is a false alarm. localhost:8123 is the real probe.)
SW=$(ls dist-localmd/assets/localmd-connect-service-worker.ts-*.js)
for s in createWsBridge localhost:8123 REDIAL; do echo "$s: $(grep -c "$s" "$SW")"; done
node -e "const m=require('./dist-localmd/manifest.json');console.log('alarms:', m.permissions.includes('alarms'))"

# The zip must not carry `key` — but the BUILD should, so it loads unpacked at
# the published id. pack:localmd strips it on a staged copy (step 7).
node -e "const m=require('./dist-localmd/manifest.json');console.log('key in build:', 'key' in m)"
```

### 6. Smoke-test `dist-localmd/` — not the dev build

The dev build is not a stand-in here the way a dev-identity build usually is: it
carries a whole extra transport and two extra allowed origins (§12 of
[localmd-connect.md](./localmd-connect.md)), so testing it proves nothing about
the artifact you are uploading.

**One id per profile.** `dist-localmd/` now resolves to the published id, so
Chrome will refuse to load it while the store copy is installed. Either:

- remove the store install for the duration of the test (simplest — you can
  reinstall from the store afterwards), or
- do it in a separate Chrome profile that has no store install.

Then, driven from `https://localmd.app` (the store build has no daemon to drive
it with), cover at minimum:

1. **capture** — clip a page and a selection, a region screenshot, and check they
   land in the inbox and get written up,
2. **highlights** — mark a passage, reload the page, it is still there; the agent
   can read it back with `get_highlights`,
3. **the write gate** — ask for something that posts on a real site: the
   confirmation card must appear, naming the control, and Skip must actually stop
   it (this is the hole 0.2.0 closed),
4. **a site script** surviving a page reload (needs **"Allow user scripts" ON**;
   everything else works without it), and `get_site_script` reading its source
   back,
5. **tab hygiene**: ten quiet seconds after a task should leave no stray tab and
   no agent window (docs/tests/platform.md §1).

### 7. Package

```bash
npm run pack:localmd        # → /tmp/localmd-connect-<version>.zip
```

Never hand-zip `dist-localmd/`. The dashboard refuses a manifest carrying `key`
("key field is not allowed in manifest"), and ours has one deliberately. The
script strips it on a staged copy, puts `manifest.json` at the zip root, and
verifies both before printing the path — trust the printed path, not your memory
of where it wrote (a stale same-named file in `/tmp` once got uploaded instead).

### 8. Upload and submit

Chrome Web Store dashboard → the localmd Connect item → **Package** → upload the
zip from step 7 → **Submit for review**. An update needs no listing work unless
step 2 said otherwise.

If you DID change the listing, re-read §5's 0.1.0 rejection first: **never
enumerate site names** — not in the description, not as chips in a screenshot,
not in a promo tile. That is what got 0.1.0 rejected, and screenshots count as
metadata too.

### 9. After it goes live

Do not write the log entry from intent — confirm with the CRX:

```bash
ID=bgennbocoapjiiolmmlcbfingimhmchh
cd /tmp && curl -sL -o localmd.crx "https://clients2.google.com/service/update2/crx\
?response=redirect&acceptformat=crx2,crx3&prodversion=138&x=id%3D$ID%26uc"
# (behind the Clash proxy if the plain curl hangs: -x http://127.0.0.1:7890)
node -e "
const fs=require('fs');const b=fs.readFileSync('/tmp/localmd.crx');
fs.writeFileSync('/tmp/localmd-live.zip', b.slice(12+b.readUInt32LE(8)));
" && rm -rf /tmp/live && unzip -q /tmp/localmd-live.zip -d /tmp/live \
  && node -e "console.log(require('/tmp/live/manifest.json').version)"
```

The version it prints is what is actually live. Then add a §5 entry marked
**PUBLISHED** with that date, and say what changed.

The key swap (§1) is done once and is already done — a later release does not
repeat it, because the item id never changes again.

### When it goes wrong

| symptom | what it is |
| --- | --- |
| "key field is not allowed in manifest" | you hand-zipped instead of `npm run pack:localmd` |
| "version already exists" | that number is burnt; bump again, there is no reuse |
| Chrome refuses to load `dist-localmd/` unpacked | the store copy holds that id — step 6 |
| func adapters die, generic tools fine | a missing sandbox/offscreen/runner artifact — step 5 |
| review stalls for weeks | expected on `userScripts` + `debugger` + `<all_urls>`; a permission delta makes it worse |
