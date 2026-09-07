# WebCLI — Chrome Web Store listing copy

## Store name (shipping since 0.2.0 — the 0.1.0 draft was never published, see docs/webcli-releases.md §4)
WebCLI - Browser Control for Agents

> This IS `manifest.webcli.json`'s `name` — the store displays the manifest name,
> so the recommendation above was adopted rather than left as listing-only copy.
> 35 chars, within the 45-char safe limit. An ASCII hyphen, not an en-dash.
>
> The name doubles as the **tab-group title**, which is why the separator matters:
> `controlled-tabs.ts` cuts the label at the first dash, so the tab strip reads
> "WebCLI" while the store reads the full line. Keep "WebCLI" as the leading token
> — changing it would orphan every existing tab group (see docs/webcli.md §13).

## Summary (single line, ≤132 chars)
Let CLI AI agents like Claude Code & Codex drive your real, logged-in Chrome — a headless bridge with 20+ tools, no in-page agent.

## Description

WebCLI turns your Chrome into a tool your AI agent can operate.

It's a headless browser-control bridge: a lightweight extension that exposes 20+ low-level browser tools — open a URL, read a page, click, type, search the web, screenshot, manage tabs — to external AI agents through a small daemon on your own machine, driven over plain HTTP. No MCP server to configure, no keys to paste. There's no agent inside the browser and no UI to babysit. You bring the model; WebCLI is the hands.

Because it drives YOUR real, logged-in Chrome session, your agent works pages exactly as you do — already signed in, human-like, and sailing past the bot walls that block headless scrapers.

━━━ WHAT YOU CAN DO ━━━

• Let Claude Code, Codex, or any agent that can run a shell command browse, read, and act on the web for you
• Automate logged-in sites without pasting cookies or re-authenticating
• Pull clean page text, search results, and link frontiers for research and crawling loops
• Read any article as clean Markdown in a single call — no tab, no rendering, no scraping code
• Fill a whole form in one call, click through flows, upload files, and drive multi-tab tasks
• Drive LLM-written browser tests against your real session
• Fetch JSON APIs, RSS, and sitemaps straight from your session (CORS-free, cookie-authed)

━━━ THE TOOLBELT (20+ primitives) ━━━

• Navigate & read — open_url, get_page_text, fetch_url, screenshot, scroll_page
• Search & crawl — web_search, list_links
• Interact — click, type_into, fill_form, press_key, select_option, hover, drag_and_drop, file_upload, handle_dialog
• Perceive the DOM — get_interactives, get_html, query_dom, get_dom_outline, wait_for_selector, find_in_page
• Tabs — list_tabs, get_active_tab, manage_tabs, close_tab
• Page-declared tools (WebMCP) — list_webmcp_tools, call_webmcp_tool

━━━ WHY WEBCLI ━━━

• Your real Chrome session — logged-in and human-like, not a throwaway headless browser
• No in-browser agent — a pure browser-control provider; bring your own model and orchestration
• One way in, zero config — a daemon bound to 127.0.0.1 that your agent's skill starts for you; plain HTTP, no MCP server to set up
• Tiny & focused — well under a megabyte, generic tools only; runs side-by-side with the full Web Agent extension
• Auto-reconnect — a 1-minute alarm redial connects within a minute of your daemon starting
• Local & private — everything runs on your machine; WebCLI itself sends nothing to a third-party server (your agent, of course, sends what it reads to its own model provider) — and no web page can ever reach the tools
• You hold the keys — the tool catalog can be trimmed to a core set in the popup to keep your agent's prompt small

━━━ GET STARTED ━━━

1. Install WebCLI from the Chrome Web Store (it runs headless — only a small status popup).
2. Ask your agent to run:  npx skills add whitefoxx/webcli-skills -g
3. Then ask your agent to use the browser. The skill knows the rest — including starting the local daemon on port 9376, which WebCLI connects to automatically.

Docs & the daemon: https://github.com/whitefoxx/webcli-skills

WebCLI is the "pure provider" sibling of the Web Agent extension: the same battle-tested browser tools, packaged headless for external agents.
