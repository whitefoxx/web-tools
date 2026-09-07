---
name: web-agent
description: Use to drive the user's real, logged-in Chrome through the full Web Agent browser extension — open pages, read/extract content, click/type/scroll, manage tabs, and manage the extension itself (工作流/prompt recipes, long-term memory, LLM model). Covers starting the local bridge yourself and talking to it over plain HTTP (curl). Reach for this on any "use my browser", "read this site while I'm logged in", "scrape/automate this page", or "save this as a 工作流/memory" request. For the agent-free WebCLI extension use the `webcli` skill instead.
---

# web-agent

**The user's logged-in browser, as your tools.** Drive the user's real Chrome
through the **Web Agent** extension — locally, over plain HTTP (`curl`). The
same bridge daemon serves the agent-free **WebCLI** (skill: `webcli`); this
extension adds its own management tools on top (工作流 / prompt recipes /
memory / LLM).

Don't rely on a static tool list — read `/tools` (§2) for the live set. Reaching
a mainstream site is something you BUILD from the base primitives (`eval_js` and
friends), not a catalog you look up: see `skills/adapters/README.md` for the
method.

## 1. Connect (once per session)

The bridge is a local daemon the extension dials into. You start it; the user
flips one switch in the extension.

1. **User enables the bridge** — extension side panel → menu → **外部接入** → set
   the port (default **8787**) → **启用**. You can't do this (it's a browser UI
   toggle); ask them to if step 3 shows not-connected.
2. **Start the bridge** in the background and leave it running. The **first**
   `npx` run clones + installs (~10–30s) before it listens — don't assume it's
   up; poll (step 3):
   ```bash
   BRIDGE_PORT=8787 npx -y github:whitefoxx/web-tools &
   # reliable alternative: git clone https://github.com/whitefoxx/web-tools
   #   && cd web-tools && pnpm install && BRIDGE_PORT=8787 pnpm run bridge
   ```
3. **Wait, then verify** (poll — don't just `sleep`):
   ```bash
   until curl -s localhost:8787/status >/dev/null 2>&1; do sleep 2; done
   curl -s localhost:8787/status     # {"ok":true,"connected":true,"tools":N}
   ```
   - `connected:false` → the extension isn't enabled on this port (step 1).
   - `curl` exit code **7** = nothing listening yet → still starting; keep polling.

## 2. Use it — HTTP

1. **Live tool list** (the source of truth — never guess from a static list):
   ```bash
   curl -s localhost:8787/tools        # [{ function:{ name, description, parameters } }, ...]
   ```
2. **Run a tool** — POST `{ "tool", "args" }`; reply is `{"ok":true,"result":…}`
   or `{"ok":false,"error":…}`:
   ```bash
   # Cheapest read — no tab at all, fetched with the user's cookies, returns Markdown.
   # Use it first for server-rendered pages (articles, docs, blogs, READMEs, news):
   curl -s localhost:8787/command -d '{"tool":"generic__fetch_url","args":{"url":"https://example.com","format":"markdown"}}'
   # Empty / missing content means the page is JS-rendered — render it in a tab.
   # Reading a page is still ONE call: get_page_text opens, waits, reads, closes:
   curl -s localhost:8787/command -d '{"tool":"generic__get_page_text","args":{"url":"https://example.com"}}'
   # …add keep_open:true when you may click/scroll on it next (returns a live tabId):
   curl -s localhost:8787/command -d '{"tool":"generic__get_page_text","args":{"url":"https://example.com","keep_open":true}}'
   # open_url is for a tab you want WITHOUT its text (straight to interaction, or active:true to show the user):
   curl -s localhost:8787/command -d '{"tool":"generic__open_url","args":{"url":"https://example.com"}}'
   ```

Hit a login wall / captcha / a step only the user can do?
`await_user_action {objective, tab_id}` hands off to the user and resumes.

## Boundaries

- **Local-only** (`127.0.0.1`); run **one** bridge instance per port.
- **Writes** (post / comment / like; `create_*` / `save_memory` / `set_llm`)
  run only if the user ticked **允许外部写操作** in 外部接入; reads always work.
- **LLM API keys** are never exposed or accepted over the bridge (read is
  redacted; adding a backend with a key stays a UI action).
- **Load saved memories first** — call `list_memories` once at the start and
  honor them; driving over the bridge does NOT auto-inject the user's stored
  preferences.
