# WebCLI — release log & release process

The Chrome Web Store history of the **WebCLI** shell (`manifest.webcli.json` →
`dist-webcli/`), plus the checklist for cutting the next one. The full "Web Agent"
extension is a separate store item with its own version line — nothing here
applies to it.

- Store item id: **`jnhfdhpafndcbppkphhfpecflhogngge`**
- Dashboard: <https://chrome.google.com/webstore/devconsole> → WebCLI
- Listing copy + promo assets: `store/webcli/` (see §3 step 3)
- Architecture: [webcli.md](./webcli.md) · Post-mortems: [adapter-hot-plug.md](./adapter-hot-plug.md) §10.x

## 1. Identity — the id, the key, and what the store does to them

Two different keys have been in `manifest.webcli.json`, and the difference matters
enough that getting it wrong splits the extension in two.

**Chrome derives the extension id from a PUBLIC key**: `id = sha256(DER public
key)`, first 16 bytes, hex digits remapped `0-9a-f → a-p`. For an unpacked load it
takes that key from the manifest's `key` field; for a store install it takes it
from the CRX signature. So the `key` field only ever sets the _dev_ id.

**The store ignores `key` on upload — and REJECTS a zip that contains one.**
Verified by unpacking the published CRX: the manifest inside has **no `key`** and
has gained an `update_url`, so the store rewrites both. The item id was assigned
at item-creation time from a key pair Google holds; nothing we put in `key` can
change a published id.

> **Corrected 2026-08-07.** This paragraph used to end "and leaving `key` in the
> uploaded zip is harmless." That was inferred from "the store ignores it" and is
> false: the dashboard refuses the upload with _"There was a problem uploading
> your file… key field is not allowed in manifest."_ It cost more than one
> release attempt, which is why stripping it is now a SCRIPT
> (`npm run pack:webcli`) and not a line in a checklist — see §4 step 6 and
> [findings.md](./tests/findings.md) F-49.

**Which is why the original setup was wrong.** WebCLI shipped with a self-generated
key (private half `extension-key-webcli.pem`) that resolved to
`hjdcccloaonnfpojpiaadabkhjggilha`, while the store published it as
`jnhfdhpafndcbppkphhfpecflhogngge`. Two ids for one extension: a dev load and a
store install were different extensions to Chrome, so anything that names an id —
`externally_connectable` clients like localmd.app, an MCP config, a bug report —
was right for exactly one of them.

**Fixed by pointing `key` at the store's public key.** The `key` field holds only
the _public_ half, and a published item's public key is recoverable from its CRX,
so a dev load can be made to resolve to the published id without holding the
store's private key. Since 0.1.0 that is what `manifest.webcli.json` carries — the
store, not `extension-key-webcli.pem`, owns WebCLI's product identity, and that
file must never be restored into `manifest.webcli.json`.

**The old key did not become garbage, though — it became the DEV identity.** One
id per profile means the published-id build cannot sit alongside the store install
while you work; `npm run build:webcli:dev` therefore swaps that key back in (plus a
distinct name and port) so the two coexist. See [webcli.md](./webcli.md) §13 — and
note the dev build is consequently NOT the artifact you upload, which is why step 5
below smoke-tests `dist-webcli/` itself.

Recompute the id from the current manifest (do this after any `key` edit):

```bash
node -e "
const fs=require('fs'),c=require('crypto');
const k=JSON.parse(fs.readFileSync('manifest.webcli.json','utf8')).key;
const h=c.createHash('sha256').update(Buffer.from(k,'base64')).digest('hex').slice(0,32);
console.log([...h].map(x=>String.fromCharCode(97+parseInt(x,16))).join(''));
"   # → jnhfdhpafndcbppkphhfpecflhogngge
```

Recover a published item's public key from its CRX (how 0.1.0's key was obtained —
also the way to audit what is actually live in the store):

```bash
ID=jnhfdhpafndcbppkphhfpecflhogngge
curl -sL -o webcli.crx "https://clients2.google.com/service/update2/crx\
?response=redirect&acceptformat=crx2,crx3&prodversion=138&x=id%3D$ID%26uc"
# CRX3 = "Cr24" | version | header_size | CrxFileHeader protobuf | zip payload.
# The public keys live in field 2 (sha256_with_rsa), sub-field 1. Two proofs come
# back: Google's publisher key, and the item's — take the one whose sha256 hashes
# to $ID. The zip payload (bytes after 12 + header_size) unzips to the LIVE
# package, which is how §4's "what is actually published" claims are checked.
```

## 2. Versioning

`manifest.webcli.json`'s `version` is the **only** source of truth — Vite copies it
into `dist-webcli/manifest.json` verbatim. `package.json`'s `version` and the full
extension's `manifest.json` are unrelated; do not touch them for a WebCLI release.

The store requires a strictly increasing version, and a version can never be
reused — not even for a rejected or immediately-unpublished upload. Bump the minor
for a release with new tool behavior, the patch for wording/asset/bugfix-only ones.

## 3. What every release must touch (the one-glance list)

`npm run check` catches code drift. Nothing catches the rest — a listing that lies
still uploads fine — so walk this table every time. "Changed?" is the question to
ask; if yes, the file is not optional.

| Changed?                                                               | Then update                                                                                                                                                                                                                                                                    | Why it rots silently                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| always                                                                 | `manifest.webcli.json` → `version`                                                                                                                                                                                                                                             | the store rejects a reused version, and this is the only source of truth (§2)                                          |
| always                                                                 | `manifest.webcli.json` → `description` if touched — **≤132 chars**, and `name` ≤45                                                                                                                                                                                             | the dashboard REJECTS the upload; a 0.2.0 attempt died on 134 chars. Now pinned by `tests/webcli-tool-surface.test.ts` |
| always                                                                 | §4 below — a new entry, marked **PUBLISHED** only after §5 step 10                                                                                                                                                                                                             | 0.1.0 sat here labelled as shipped while the store served 0.0.1 (§4)                                                   |
| tool added / removed / renamed                                         | `tests/webcli-tool-surface.test.ts` (count + membership), `store/webcli/store-listing.md` (the enumerated toolbelt), `store/webcli/render.mjs` (screenshot 3 chips) → re-render + re-raster                                                                                    | the store screenshots are IMAGES; nothing type-checks them                                                             |
| tool surface or guidance                                               | `webcli-bridge/` submodule (SKILL.md + README) → **push first** (§5 step 9)                                                                                                                                                                                                    | the skill reaches users instantly, the extension waits on review                                                       |
| a tool's args                                                          | that tool's description string, and `WEBCLI_INSTRUCTIONS` if it changes the recommended loop                                                                                                                                                                                   | descriptions ARE the interface in an agent-free shell (§11)                                                            |
| manifest `permissions` / `host_permissions` / `externally_connectable` | prepare the dashboard justification text; expect a slower review                                                                                                                                                                                                               | a silent permission delta is the #1 review stall                                                                       |
| `name`                                                                 | `controlled-tabs.ts` `LEGACY_TITLES` if the part BEFORE the dash changed                                                                                                                                                                                                       | the name is the tab-group title; changing it orphans existing groups (§13 of webcli.md)                                |
| popup UI                                                               | nothing today — **no screenshot depicts the popup** (they are Hero / How it works / Toolbelt / Why / Get started). Corrected 2026-08-07: this row used to say "screenshot 5 if it depicts the popup", which reads as if it does, and cost a wrong entry in a release checklist | if you ever add one, it rots fastest — the popup changed in both 0.2.0 and 0.3.0                                       |
| bundle size claim                                                      | `store-listing.md` + `render.mjs` — or better, phrase it open-ended                                                                                                                                                                                                            | it moves every release; 185 KB survived two releases as a lie                                                          |
| anything user-visible                                                  | `docs/webcli.md` (the architecture section that owns it) + `docs/tests/platform.md` rows                                                                                                                                                                                       | the next session starts from the docs, not from the diff                                                               |

## 4. Release checklist

1. **Pre-flight.** Working tree clean, on the release branch. `npm run check`
   (typecheck + lint + format + tests) must be green — in particular
   `tests/webcli-tool-surface.test.ts`, which pins the tool membership and count
   that the store copy claims.
2. **Bump** `manifest.webcli.json` → `version`. Nothing else in that file should
   change for a routine release; if `permissions` / `host_permissions` /
   `externally_connectable` DID change, expect a slower review and prepare the
   justification text the dashboard will ask for. Touching `name` is never routine
   either: it is the tab-group title too, and changing the part BEFORE the dash
   orphans every existing group unless you add a `LEGACY_TITLES` entry in
   `controlled-tabs.ts` ([webcli.md](./webcli.md) §13).
3. **Sweep the store copy for drift** (`store/webcli/`, and §3's table) — this is the step that
   silently rots, because nothing fails when the listing lies:
   - `store-listing.md` — tool count, the toolbelt list, the bundle-size claim,
     the feature bullets, the daemon install command.
   - `render.mjs` — the same facts, baked into the screenshots. Then regenerate:
     ```bash
     cd store/webcli && node render.mjs          # svg/ + promo.html, pure Node
     # raster.mjs needs sharp, which is NOT a repo dep. ESM ignores NODE_PATH, so
     # symlink it in rather than setting an env var:
     cd /Users/cyb/code/web-agent
     ln -s /private/tmp/webcli-promo/node_modules/sharp node_modules/sharp
     node store/webcli/raster.mjs && rm node_modules/sharp   # → images/*.jpg
     ```
   - Eyeball the regenerated `images/screenshot-*.jpg` before shipping — the chip
     flow reflows, and a dropped tool can leave a ragged row.
   - Prefer **open-ended counts** ("20+ browser primitives") in headline copy and
     in the screenshots: the exact number moves with every tool added or retired,
     and each change otherwise means re-rendering and re-uploading five images.
     Keep the enumerated lists exact.
4. **Build.** `npm run build:webcli` (or `npm run build:all` if the full extension
   also needs rebuilding — see the "rebuild after asset change" rule).
5. **Verify the artifact** before uploading:
   ```bash
   node -e "const m=require('./dist-webcli/manifest.json');console.log(m.version,m.name)"
   # id check: same snippet as §1, against dist-webcli/manifest.json
   grep -c read_more dist-webcli/assets/*.js      # spot-check a removed string
   ```
   Confirm the release's headline feature strings are actually in the bundle —
   a stale `dist-webcli/` looks identical from the outside.
   Then **smoke-test `dist-webcli/` itself**, not `dist-webcli-dev/`: the dev
   variant differs in key, name and port ([webcli.md](./webcli.md) §13), so it is
   never proof that the uploaded package works. Because it carries the published
   id, loading it means temporarily removing the store install, or using a second
   Chrome profile.
6. **Package it** — `npm run pack:webcli`. Do NOT hand-zip `dist-webcli/`: the
   dashboard rejects a manifest containing `key` ("key field is not allowed in
   manifest"), and ours has one on purpose (§1). The script stages a copy,
   strips `key` there — never in `dist-webcli/`, which must stay loadable
   unpacked at its stable id — zips the CONTENTS so `manifest.json` lands at
   the root, and verifies both of those before printing the path:
   ```bash
   npm run pack:webcli    # → /tmp/webcli-<version>.zip, outside the repo
   ```
7. **Upload** in the dashboard → Package → Upload new package. Then update, in the
   same draft, anything §3 changed: description, screenshots, promo tiles.
8. **Submit for review.** Publishing is manual — the draft sits until submitted.
9. **Ship the skills side.** The daemon + skills live in the `webcli-bridge/`
   submodule (public repo `whitefoxx/web-tools-skills`) and users install them
   separately with `npx`. If the release changes the tool surface or the guidance
   the skill teaches, **push that submodule first** — the skill text reaches users
   the moment it is pushed, whereas the extension waits on review, and a skill that
   names a tool the installed extension lacks is worse than a stale one.
10. **After it goes live**, re-download the CRX (§1) and confirm the version and
    the headline strings, then add the §6 entry below and flip it to **PUBLISHED**.

## 5. Version history

Each entry is marked **PUBLISHED** (confirmed live via the §1 CRX download) or
**SUBMITTED** (uploaded, review pending) or **PREPARED** (built and documented,
never submitted or never approved). Do not
write PUBLISHED from intent — run the check:

```bash
ID=jnhfdhpafndcbppkphhfpecflhogngge
curl -sL -o /tmp/webcli-live.crx "https://clients2.google.com/service/update2/crx\
?response=redirect&acceptformat=crx2,crx3&prodversion=138&x=id%3D$ID%26uc"
python3 -c "
import struct,zipfile,io,json
b=open('/tmp/webcli-live.crx','rb').read(); assert b[:4]==b'Cr24'
_,hs=struct.unpack('<II', b[4:12])
m=json.loads(zipfile.ZipFile(io.BytesIO(b[12+hs:])).read('manifest.json'))
print(m['version'], m['name'])"
```

### 0.3.0 — 2026-08-06 · **SUBMITTED 2026-08-07**, awaiting review

**Web-app access REMOVED** — the whole 0.2.0 headline reversed, deliberately.
The "call the tools from your own web app" use case moved wholesale to the new
**localmd Connect** shell (`docs/localmd-connect.md`), which serves it with the
adapter/site-script surface a web app actually wants; WebCLI goes back to one
job: the WS daemon for CLI agents. Removed from this shell (all machinery stays
in `core/` — localmd Connect wires it):

- the runtime-registered relay content script + its build artifact
  (`web-relay.js` no longer emitted for webcli modes; `src/webcli/web-relay.ts`
  deleted — localmd Connect has its own entry with a distinct DOM marker);
- the Port-MCP handler wiring + `WEBCLI_INSTRUCTIONS` (were relay-only);
- the popup's "Web app access" section;
- `onInstalled` now sweeps 0.2.0 leftovers (stored `webOrigins`, any stale
  relay content-script registrations — belt-and-braces, updates clear them).

Tool surface unchanged (28); no permission changes; manifest description
reworded to drop "your web apps" (still ≤132). Store listing swept the same way
(summary, WHAT YOU CAN DO, WHY WEBCLI). `docs/webcli.md` §15 marked superseded.

#### This TAKES A SHIPPED FEATURE AWAY FROM LIVE USERS (corrected 2026-08-07)

The 2026-08-06 work was done believing 0.2.0 had never been submitted — this
file said PREPARED. It is live, and has been since ~2026-07-30. So the relay is
not an unreleased experiment being tidied away: **it is running in installed
copies right now**, and 0.3.0 removes it. Every "nothing shipped is being taken
away" statement from that day is wrong (commit `bd17539`'s message, the
`webcli-skills` README + SKILL.md as first pushed, the handoff brief's
catalogue advice). The docs are corrected; the commit message cannot be.

What that changes about this release — none of it optional:

- **Ordering is now load-bearing.** The only web app using this path is
  localmd.app, and its replacement (localmd Connect) **is not on the store
  yet**. Shipping 0.3.0 first leaves those users with the feature gone and
  nothing to install. Publish localmd Connect first; ship 0.3.0 after.
- **localmd deploys in the middle**, and its client change REPLACES the webcli
  catalogue row (`docs/localmd-connect-handoff.md` step 2). That advice was
  written under the same false premise: replacing the row breaks a working
  WebCLI 0.2.0 setup the moment localmd deploys, before this release even
  ships. During the migration window the row should stay as a deprecated
  fallback, and only disappear once 0.3.0 is live.
- **Say it in the listing.** A removed capability that users are actively
  relying on belongs in the release notes and the "what's new" field, not only
  in a diff. The store shows the description, not the changelog, so the
  description doing the work is the whole notice most users get.
- The `onInstalled` sweep that clears `webOrigins` is no longer belt-and-braces
  cleanup of a test artifact — it deletes a real user's configured allowlist.
  Correct (the feature is gone; a stale allowlist grants nothing), but it means
  **the removal is irreversible for them**: rolling back to 0.2.0 would not
  restore the origins they had added.

#### Release checklist for THIS release (tick as you go)

Done already (2026-08-06, pushed on `product`):

- [x] version → `0.3.0`; description reworded, 109 chars (≤132)
- [x] `permissions` / `host_permissions` unchanged from live 0.2.0 — **verified
      against the published CRX, not against this file**: same 8 permissions,
      `<all_urls>`, no `externally_connectable` either side. No permission
      delta ⇒ no dashboard justification, no slower review
- [x] tool surface unchanged at 28 ⇒ `tests/webcli-tool-surface.test.ts` needs
      no edit (it stayed green throughout)
- [x] `store/webcli/store-listing.md` swept (no "web app" mentions remain)
- [x] `docs/webcli.md` §15 marked SUPERSEDED; `docs/localmd-connect.md` §8 is
      now the protocol's home
- [x] `webcli-bridge/` submodule pushed (`d4627fd`) — **but its wording was
      written from the false premise; re-push the correction before release**
- [x] `name` unchanged ⇒ no `LEGACY_TITLES` entry needed

Remaining:

- [ ] **Publish localmd Connect first** (see the ordering point above). Until it
      is installable, 0.3.0 must not ship.
- [x] `webcli-bridge/` re-pushed with the corrected wording (`5b50802`) —
      it had told the public the relay "never reached a published build".
      Submodule pointer bumped here.
- [x] `store/webcli/render.mjs` rewritten, re-rendered and re-rastered
      (2026-08-07). It turned out to be worse than "drop the web-app chip":
      **after this release WebCLI has no MCP surface at all**, so every "MCP"
      claim in the copy was false. The daemon (`webcli-bridge/server.mjs`)
      speaks plain HTTP — no `jsonrpc`, no MCP server — and the skill says so
      outright ("Talk to it over plain HTTP (curl) — no MCP setup"). The only
      MCP WebCLI ever had was the Port-MCP relay this release deletes. So
      "any MCP client", "MCP + WebSocket", "Two transports" and (a line written
      2026-08-06) the listing's "spoken as MCP by the bundled skill" all went.
      The copy now sells what is true and is arguably a better pitch: one
      daemon on 127.0.0.1, plain HTTP, nothing to configure. `WebMCP`
      (`list_webmcp_tools` / `call_webmcp_tool`) stays — unrelated: tools a
      PAGE declares. The chip list is now one `AGENT_CHIPS` const, because its
      two copies (labels + centring width) are exactly what drifted before.
- [x] Eyeballed all 7 regenerated images — and needed to: `anything that curls`
      **overflowed its 250px node card** in screenshot 2, spilling over the
      accent bar. Mono subs there fit ~15 chars (`localhost :9376` is the
      ceiling); shortened to `any CLI agent` and re-rendered. This is the step
      §4 warns about, earning its place.
- [ ] `npm run check` green, then `npm run build:webcli`
- [ ] Verify the artifact per §4 step 5, including that the removal really
      landed in the bundle:
      `bash
  SW=$(ls dist-webcli/assets/webcli-service-worker.ts-*.js)
  grep -c "createExternalMcpHandler\|WEBCLI_INSTRUCTIONS\|RELAY_PORT_NAME" "$SW"  # → 0
  ls dist-webcli/web-relay.js 2>/dev/null && echo "STALE BUILD"                   # → absent
  `
- [ ] Smoke-test `dist-webcli/` itself (published id ⇒ remove the store install
      or use a second profile), **including that an existing 0.2.0 profile
      upgrades cleanly**: the `onInstalled` sweep should clear `webOrigins` and
      unregister any relay content scripts without erroring
- [ ] Zip the CONTENTS → upload → fill the "what's new" with the removal notice
      → submit
- [ ] After it goes live: re-run the §1 CRX check, then flip this entry to
      **PUBLISHED** with the confirmed date

Note on §4 step 3's raster command: the documented symlink target
`/private/tmp/webcli-promo/node_modules/sharp` is **broken** (no `package.json`
— a partial install). A working sharp lives at
`~/code/ai-image/node_modules/sharp` (0.34.5); symlink that one instead, or
`npm i sharp` into a scratch dir and point at it.

### 0.2.0 — 2026-07-30 · **PUBLISHED** (confirmed live 2026-08-07 via the §1 CRX check: `0.2.0`, no `externally_connectable`)

Baseline `88c9235..HEAD` on `feat/webcli-devtools-borrows`. **Carries the 0.1.0
work too**, since that release never reached users. No permissions added;
`externally_connectable` REMOVED.

> **Corrected 2026-08-07.** This entry sat here labelled PREPARED for a week
> after it went live — the same failure §3 warns about, in the opposite
> direction (0.1.0 was marked shipped while the store served 0.0.1). The cost
> was not cosmetic: work done on 2026-08-06 reasoned from "0.2.0 never reached
> users" and concluded that removing web-app access in 0.3.0 took nothing away
> from anyone. It does. Commit `bd17539`'s message states the wrong version of
> this and cannot be edited; §0.3.0 below carries the correction. **Run the §1
> CRX check before writing a status here — never infer it from this file.**

**Web-app access is now the user's call** ([webcli.md](./webcli.md) §15).
`externally_connectable` is gone from the manifest — with it, localmd.app's
built-in access. A web app reaches the tools only from an origin the user adds in
the popup, over a relay content script registered at runtime. Default: empty list,
nobody. Page-side protocol in the `webcli-skills` README; **localmd.app requires a
code change** (`chrome.runtime.connect(id)` no longer reaches WebCLI) and the page
no longer needs the extension id at all — the relay hands it over via
`<html data-webcli-relay>`.

**Tool surface: 25 → 28.** `fill_form` (set N fields in one DOM pass — text,
textarea, rich-text, `<select>` by value or visible label, checkbox/radio; per-field
results so one stale ref doesn't lose the rest), plus `list_webmcp_tools` /
`call_webmcp_tool` for tools a page declares via `navigator.modelContext` — a cheap
option on an emerging standard, no CDP and no new permission.

**Screenshots got cost controls.** `format` (png/jpeg/webp), `quality`, `max_width`.
Measured, because the obvious advice was wrong ([F-44](./tests/findings.md)): on a
flat-colour app UI — the dominant agent workload — **jpeg comes out BIGGER than
png** (157 KB vs 141 KB); webp wins on both UI and photo pages (~0.4x), and
`max_width` is the real lever (~4x). Guidance everywhere now says max_width first,
webp for lossy, never jpeg by reflex.

**`wait_for_selector` also takes `text`** — wait for what the page will _say_
("Order confirmed") with no DOM probe first.

**Tool-set profiles.** The popup's Tools switch trims the advertised catalog to 13
core tools; hidden tools stay callable by name, so this is a prompt-size setting,
not a capability cliff.

**Popup rebuilt** as the extension's only UI: the pitch and use cases moved up
beside the title, setup collapsed to ONE command (`npx skills add
whitefoxx/web-tools-skills -g`), and two controls added (tool profile, web-app
origins) — counts come from the SW's live registry rather than constants.

**Fixed, all found on the real machine:** `list_webmcp_tools` computed `source` and
never forwarded it (F-42); `fill_form {submit}` silently did nothing when the last
field was a contenteditable — `.form` exists only on form controls (F-43); the
relay's `ready` frame reliably dispatched before the page's listener existed, so
detection moved to a synchronous DOM marker (F-46).

### 0.1.0 — 2026-07-26 (baseline `7b539cb..37d86ec`) · **PREPARED, NEVER PUBLISHED**

Built, documented and rolled into 0.2.0 instead. Confirmed 2026-07-30 by
downloading the live CRX: the store was still serving **0.0.1** (name `WebCLI`,
`externally_connectable` still present). Everything below shipped to users only
as part of 0.2.0 — treat it as that release's first half, not as a version anyone
ran. This entry is why §5 now demands the CRX check before writing PUBLISHED.

No permission changes.

**Renamed** `WebCLI` → **`WebCLI - Browser Control for Agents`** (35 chars, under
the store's 45-char safe limit). The store displays the manifest name, and a bare
"WebCLI" says nothing to someone seeing it for the first time. The name is also the
tab-group title, so `controlled-tabs.ts` now cuts the label at the first dash — the
strip still reads "WebCLI", and because that leading token is unchanged, every tab
group created by 0.0.1 is still recognized and adopted. No migration.

**Identity fix (§1):** `key` switched to the store's public key, so an unpacked
dev load and a store install are finally the same extension
(`jnhfdhpafndcbppkphhfpecflhogngge`).

**Tool surface: 26 → 25.** `read_more` moved to the full shell only — it pages
through an oversize stash that only the in-extension agent loop writes, so in an
agent-free shell every call was guaranteed to fail.

**New — read a page with no tab at all.** `fetch_url` gained
`format:"markdown"`: server-rendered pages come back as clean Markdown from a
single HTTP request, no tab created. It reuses `get_page_text`'s walker verbatim
over a `MiniDocument` parsed from the response bytes (`_mini-dom.ts`), so the
fetched and the rendered paths emit one Markdown dialect instead of two that
drift; `tests/mini-dom-parity.test.ts` holds them byte-identical against jsdom.
Also gained `selector` and `with_cookies` (default true; false fetches as an
anonymous visitor, and the result echoes the flag so a login wall explains
itself).

**New — read-then-act in one call.** `get_page_text {url, keep_open:true}`
returns the text _and_ a live `tabId`, replacing the `open_url` → `get_page_text`
round trip that external agents were making for every page.

**Fixed — tabs vanishing under a running agent** (`adapter-hot-plug.md` §10.47),
three independent causes:

- Both shells hardcoded the tab-group title `"Web Agent"`, but tab groups are
  **browser-global** — so each shell's orphan reaper closed the other's agent
  window, killing tabs an external session was mid-task on. The title is now the
  extension's own manifest name (WebCLI's group is `WebCLI`).
- `get_page_text {url}` and `screenshot {url}` returned the `tabId` of a tab they
  had just closed, inviting a follow-up `scroll_page` on a dead tab. They now
  report `tab_closed: true` and no id.
- `'webmcp'` was missing from the dispatcher's external-origin exclusion list, so
  Port-MCP tabs were recorded by the run-tab janitor and swept by its 6-hour
  stale pass.

**Changed — `web_search` requires `engine`** (breaking for callers that omitted
it). `"auto"` asks for the google → bing → duckduckgo cascade; an unsupported
value (`"baidu"`) is now an error naming the legal ones instead of silently
searching Google and reporting success.

**Tool descriptions swept** for promises that only hold in the full shell —
`open_url` no longer claims tabs are auto-reaped, `close_tab` no longer says
cleanup is unnecessary, and five tools no longer offer an Explore-tab fallback
that WebCLI cannot reach. `WEBCLI_INSTRUCTIONS` rewritten around the cheapest
read. Pinned by `tests/webcli-tool-surface.test.ts`; rationale in
[webcli.md](./webcli.md) §10–§12.

### 0.0.1 — 2026-07-23 (`7b539cb`) · **PUBLISHED** (verified live 2026-07-30)

Initial Chrome Web Store release. Headless bridge, 26 generic tools, WS + Port-MCP
transports, status popup, default port 9376. Store assets authored in
`store/webcli/`; published id assigned by the store as
`jnhfdhpafndcbppkphhfpecflhogngge` (the manifest's self-generated `key` claimed
`hjdcccloaonnfpojpiaadabkhjggilha` — see §1).
