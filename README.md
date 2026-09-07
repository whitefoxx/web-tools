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
- `webcli-bridge/` — git submodule: the WS daemon + agent skills for WebCLI
  (`whitefoxx/web-tools-skills`, installed by users with `npx skills add`).
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
