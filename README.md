# web-tools

The **open base** for the agent-free browser shells, and the two extensions
built from it:

- **WebCLI** (`manifest.webcli.json` → `dist-webcli/`) — the shared primitive
  base (the generic browser tools, `eval_js`, the recon primitives, persistent
  site scripts) exposed to CLI agents over a WS-daemon transport.
- **localmd Connect** (`manifest.localmd.json` → `dist-localmd/`) — the paid
  companion for localmd.app: the same base plus knowledge-base capture tools and
  the browser's own data behind optional permissions.

The **full extension** ("Web Agent" — the in-extension agent, adapters,
SidePanel) is not here. It lives in the private `web-agent` repo, which depends
on this one as a git submodule.

Both shells ride the user's real, signed-in Chrome. Reading is free; a WRITE
(post, send, delete…) always pauses on a confirmation in the calling app —
see `docs/webcli.md` and `docs/localmd-connect.md`.

## Layout

- `src/core/` — the shell-agnostic base: generic executor, transport
  factories (WS bridge, external MCP), the explore-gate seam, web origins.
- `src/tools/generic/` — the generic tools; `_generic.ts` registers the shared
  set, `_localmd.ts` the localmd Connect additions.
- `src/runtime/` — the tool registry + page shim the tools run on.
- `src/site-scripts/`, `src/selection/`, `src/capture/` — persistent site
  scripts, the in-page highlighter's stores, region capture.
- `src/background/` — the two service workers + the shared keep-alive.
- `src/webcli/`, `src/localmd-connect/` — each shell's popup / options / relay.
- `bridge/`, `skills/` — the WS daemon and the agent skills (see below).
- `store/<shell>/` — Web Store listing copy; `docs/*-releases.md` — the
  per-shell release checklists and history.

## Build / test

```sh
pnpm install
pnpm run build:webcli      # → dist-webcli/       (published identity)
pnpm run build:localmd     # → dist-localmd/      (published identity)
pnpm run build:webcli:dev  # → dist-webcli-dev/   (dev identity — coexists with the store install)
pnpm run build:localmd:dev # → dist-localmd-dev/  (dev identity + the WS daemon behind __LOCALMD_DEV__)
pnpm test && pnpm run typecheck
pnpm run pack:webcli | pack:localmd   # zip the CONTENTS of a dist for upload
```

The manifests carry the store's **public** keys, so an unpacked build takes the
published id. The private `.pem` halves (dev ids) are gitignored and stay local.

## Skills + bridge daemon

The daemon a CLI agent talks to, and the skills that teach it how, live here
too (they used to be the separate `web-tools-skills` repo):

- `bridge/server.mjs` — the WS bridge daemon (`web-tools-bridge` bin). Default
  port 9376 (WebCLI); `BRIDGE_PORT=9378` drives a localmd Connect dev build,
  `BRIDGE_PORT=8787` the full Web Agent. Transport only — it knows nothing
  about any shell.
- `skills/webcli/SKILL.md` — how a CLI agent drives WebCLI.
- `skills/adapters/README.md` — the method for reaching a site with the base
  primitives (the robustness ladder). No per-site recipes are maintained here;
  the agent builds them live and the user keeps their own.
- `skills/web-agent/SKILL.md` — what the full Web Agent adds on top (`web_task`).

```sh
npx skills add whitefoxx/web-tools -g       # install the skills (auto-detects Claude Code / Cursor / Codex)
npx -y github:whitefoxx/web-tools           # run the daemon — a git install pulls only the runtime deps
BRIDGE_PORT=9378 npx -y github:whitefoxx/web-tools
```
