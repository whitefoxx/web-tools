# web-tools — working rules

## Language: English in the repo, Chinese in chat (standing rule)

Everything written into this repository is English — code, comments,
identifiers, `docs/*.md`, tests, commit messages, strings shipped to users.
Replies to the user are in Chinese where it reads naturally; keep code,
identifiers, paths, tool names and quoted repo content verbatim.

## What this repo is

The OPEN base + two agent-free shells (WebCLI, localmd Connect). The full
"Web Agent" extension is the private `web-agent` repo, which mounts this repo
as a git submodule — so **nothing here may import or assume the full shell**
(no agent / sidepanel / explore / adapters / userscript). If a change needs one
of those, it belongs in `web-agent`. System architecture + the split's
reasoning: `web-agent/docs/architecture.md` §A.

## Tool descriptions are read by every shell that registers them

A shared tool's description (`src/tools/generic/_generic.ts` set) must not
promise a shell-specific behaviour or name a tool the other shell does not
register. Pinned by `tests/webcli-tool-surface.test.ts` and
`tests/localmd-tool-surface.test.ts` — when one fails, fix the wording or the
placement, not the assertion. Shell-specific wording goes in a shell-only
registration file (registry `cli()` is last-write-wins on (site, name)).

## Two shells, own identities, own daemons

- WebCLI: store id `jnhfdhpafndcbppkphhfpecflhogngge`; dev id via
  `--mode webcli-dev` (port 9377 vs 9376). Daemon + skills live in the
  `webcli-bridge/` submodule (`whitefoxx/web-tools-skills`): edit there, push,
  then bump the submodule pointer here.
- localmd Connect: store id `bgennbocoapjiiolmmlcbfingimhmchh`; dev id via
  `--mode localmd-dev` (WS daemon on 9378 exists ONLY in the dev build — a dev
  build is not a valid smoke test of the upload artifact). The shipping build's
  only way in is a page on `https://localmd.app`.
- `pnpm run build:all` covers the SHIPPING targets only. After changing anything
  a dev build exercises, rebuild the dev variant too, and reload both the
  extension and the page (a content-script change never reaches an open tab).

## Releasing

Follow the shell's own release doc — `docs/webcli-releases.md`,
`docs/localmd-connect-releases.md` (bump → sweep `store/<shell>/` → build →
`pack:<shell>` → upload). Add a section per release; mark it PUBLISHED only
after the CRX download confirms it.

## Record findings in docs (standing rule)

Bug fixes get a Symptom / Root cause / Fix / Lesson post-mortem in the relevant
doc before the fix is committed; audits record method, findings and what was
deferred. Real-machine test findings for these shells accumulate in
`web-agent/docs/tests/findings.md` (cross-shell log) until this repo grows its
own.

## Commit / push

Do not commit or push automatically — ask first, except when the user says
"commit" / "push" for that turn. Bug fixes are not committed until the user has
confirmed the fix end-to-end on a real machine, even if asked to commit.
