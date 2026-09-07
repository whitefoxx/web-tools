---
name: webcli
description: Use to drive the user's real, logged-in Chrome through the WebCLI extension — a headless, agent-free browser bridge. Open pages, read/extract content (get_page_text / get_html / get_dom_outline), see and operate the page (get_interactives → click / type_into / fill_form / select_option / press_key / scroll_page), take screenshots, and manage tabs. GENERIC browser tools only (no site adapters, no in-browser LLM). Talk to it over plain HTTP (curl) — no MCP setup. Reach for this on any "use my browser", "read this page while I'm logged in", "scrape/automate this page", or "click/fill this form for me" request.
---

# WebCLI

**The user's logged-in browser, as your tools — generic and headless.** WebCLI is a
Chrome extension with NO in-browser agent and NO site adapters: just the generic
browser primitives, exposed to you over a local bridge you talk to with `curl`.
Everything runs on the user's machine, in their real Chrome session (no re-auth).

## 1. Start the bridge

The WebCLI extension dials OUT to a local daemon (default port **9376**). Start it:

```bash
npx -y github:whitefoxx/web-tools-skills            # runs the bridge on 9376
# or a specific port:  BRIDGE_PORT=9376 npx -y github:whitefoxx/web-tools-skills
```

Then check it's connected (the extension auto-connects within ~1 min; the user may
need to load/enable the **WebCLI** extension once):

```bash
curl -s http://127.0.0.1:9376/status
# → {"ok":true,"connected":true,"port":9376,"client":"webcli","tools":28}
```

If `connected:false`, ask the user to open `chrome://extensions`, confirm **WebCLI**
is loaded/enabled, and (if it just started) reload it once. It reconnects on its own
after that.

## 2. Drive it (all over HTTP)

- **List the exact tools + their args:** `curl -s http://127.0.0.1:9376/tools`
  (this is the source of truth — tool names are `generic__<name>`).
- **Call a tool:**

  ```bash
  curl -s http://127.0.0.1:9376/command \
    -d '{"tool":"generic__get_page_text","args":{"url":"https://example.com"}}'
  # → {"ok":true,"result":{"title":"Example Domain","text":"…","tab_closed":true}}
  ```

## 3. The core loop

**Reading a page is ONE call — don't `open_url` first.** Two one-call readers;
pick by whether the page needs a browser to render:

```bash
# CHEAPEST: no tab at all. Fetches with the user's cookies, returns Markdown.
# Use this FIRST for server-rendered pages: articles, docs, blogs, READMEs, news.
curl -s .../command -d '{"tool":"generic__fetch_url","args":{"url":"https://…","format":"markdown"}}'
# → {"ok":true,"result":{"markdown":"# Title…","title":"…","with_cookies":true,"status":200}}
#   with_cookies:false fetches signed-out; selector:"#main" scopes the conversion;
#   a non-HTML response comes back as text with a `note` saying so.

# Empty or missing the content? The page is JS-rendered — render it in a real tab:
curl -s .../command -d '{"tool":"generic__get_page_text","args":{"url":"https://…","format":"markdown"}}'
# → {"ok":true,"result":{"markdown":"…","tab_closed":true}}   ← no tab id: the tab is gone

# Read AND keep the page, for when you may act on it next (one call, not two):
curl -s .../command -d '{"tool":"generic__get_page_text","args":{"url":"https://…","keep_open":true}}'
# → {"ok":true,"result":{"text":"…","tabId":123,"created_tab":true}}

# Read an already-open tab in place (keeps its scroll / SPA route / popup state):
curl -s .../command -d '{"tool":"generic__get_page_text","args":{"tab_id":123,"format":"markdown"}}'
```

`get_html` / `get_dom_outline` / `screenshot` take `url` the same way (one-shot;
they close their tab too). A result with `"tab_closed": true` has **no tab left**
— there is no id to follow up on.

Use `open_url` on its own only when you want the tab **without** its text: going
straight to interaction, or putting a page in front of the user (`active:true`).

Operate a page (perceive → act → verify):

```bash
get_page_text {url, keep_open:true} → {text, tabId}   # or open_url {url} → {tabId}
get_interactives {tab_id} → {links,buttons,inputs,…} each with a `ref`
click {tab_id, ref}       # locate by ref | selector | text; type_into / select_option / press_key
fill_form {tab_id, fields:[{ref,value},…]}   # MORE THAN ONE box → one call, not N
scroll_page {tab_id}      # lazy-loading feeds; `ref` scrolls an inner container
wait_for_selector {tab_id, text:"Order confirmed"}   # or selector: — wait, don't sleep
get_page_text {tab_id}    # verify the result (cheap); screenshot {tab_id} only for visual checks
close_tab {tab_id}        # clean up background tabs you opened
```

**Filling a form is one call.** `fill_form` sets every field in a single DOM pass
and handles the kinds a real form has — text / textarea / rich-text, `<select>`
(match the option's value **or** its visible label), and checkbox/radio (`"true"` /
`"false"`). Results come back per field, so one stale ref doesn't lose the rest:

```bash
curl -s .../command -d '{"tool":"generic__fill_form","args":{"tab_id":123,
  "fields":"[{\"ref\":\"r3\",\"value\":\"alice@example.com\"},{\"selector\":\"#pw\",\"value\":\"hunter2\"},{\"ref\":\"r9\",\"value\":\"true\"}]",
  "submit":true}}'
# → {"ok":true,"result":{"filled":3,"total":3,"results":[…],"url_changed":true}}
```

**Tabs are yours.** WebCLI never reaps them (there is no agent run to end), so a
`tabId` stays valid until you `close_tab` it or the user closes the tab.

**Prefer text over screenshots.** `get_page_text` is cheap and usually enough;
`screenshot` returns a base64 image that costs many tokens — use it only for
visual/layout/non-text tasks or to eyeball a result. **When you do take one, size
it**: `{"format":"jpeg","max_width":1024}` typically cuts the bytes several-fold
and still answers any layout or "did that work?" question. Keep the default png
only when you must read fine print — a captcha, chart labels, a dense table.

## 4. The tool surface (generic only)

Read without a tab: `fetch_url` (raw | json | `format:"markdown"`, `with_cookies`).
Navigation/content: `open_url`, `get_page_text` (url [+`keep_open`] | tab_id),
`get_html` (url|tab_id), `get_dom_outline` (url|tab_id), `list_links` (url|tab_id),
`screenshot` (url|tab_id, `format`/`quality`/`max_width`), `scroll_page`,
`close_tab`. Tabs: `list_tabs`, `get_active_tab`, `manage_tabs`.
Perceive+interact: `get_interactives`, `click` (ref|selector|text), `type_into`,
`fill_form` (many fields at once), `select_option`, `press_key`, `hover`,
`drag_and_drop`, `file_upload`, `handle_dialog`. Search/scan: `web_search`,
`find_in_page` (visible text), `query_dom` (CSS selector), `wait_for_selector`
(`selector` or `text`). Page-declared tools: `list_webmcp_tools`,
`call_webmcp_tool`.

28 tools in total (`read_more` is NOT one of them — it belongs to the full
extension's agent loop). `GET /tools` is always the authority.

**Page-declared tools (WebMCP).** A few sites now register their own
agent-callable tools via `navigator.modelContext`. On a page you are about to
automate it costs one call to check — `list_webmcp_tools {tab_id}` — and when a
site does offer them, calling one beats driving its UI, because you are using the
interface it meant for you rather than its buttons. Most pages declare nothing;
that is the expected answer, not an error, and you just fall back to
`get_interactives` + `click`. `call_webmcp_tool {tab_id, name, input}` performs a
real action on the site — treat it as seriously as clicking the button it replaces.

That's the whole surface — there are **no** site-specific adapters and **no**
`web_task`/agent tool. If a call returns "tool not found", it's not part of WebCLI
(you may be thinking of the full Web Agent extension). Always trust `GET /tools`.

## Notes

- Writes/interactions (click/type/submit) act on the user's real session — be
  deliberate; don't batch destructive actions.
- Tabs you open in the background pile up; close them when done.
- From 0.3.0 the daemon is the only way in: WebCLI no longer exposes the tools
  to web pages (0.2.0 shipped a relay for that; 0.3.0 removed it), so nothing
  reaches these tools except an agent driving `POST /command`.
