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
Let CLI AI agents like Claude Code & Codex drive your real, logged-in Chrome — a headless bridge with 35+ tools, no in-page agent.

## Description

WebCLI turns your Chrome into a tool your AI agent can operate.

It's a headless browser-control bridge: a lightweight extension that exposes 35+ low-level browser tools — open a URL, read a page, click, type, search the web, screenshot, manage tabs, run your own JavaScript in the page — to external AI agents through a small daemon on your own machine, driven over plain HTTP. No MCP server to configure, no keys to paste. There's no agent inside the browser and no UI to babysit. You bring the model; WebCLI is the hands.

Because it drives YOUR real, logged-in Chrome session, your agent works pages exactly as you do — already signed in, human-like, and sailing past the bot walls that block headless scrapers.

**Reach a site nobody wrote support for.** On top of the primitives there are reconnaissance tools that answer "where does this value actually come from" — the page's structured data, its accessibility tree, and the requests it makes — plus eval_js to run your own JavaScript in the page's own origin. That is how an agent works out how to read an unfamiliar site in one session, instead of you writing and maintaining a scraper.

**And page rules that stick.** Site scripts let your agent apply a change you approved — hide the clutter, restyle a page, run a small script — on every visit to a matching site, until you remove it. Every one is listed in the popup, where you can pause or delete it.

━━━ WHAT YOU CAN DO ━━━

• Let Claude Code, Codex, or any agent that can run a shell command browse, read, and act on the web for you
• Automate logged-in sites without pasting cookies or re-authenticating
• Pull clean page text, search results, and link frontiers for research and crawling loops
• Read any article as clean Markdown in a single call — no tab, no rendering, no scraping code
• Fill a whole form in one call, click through flows, upload files, and drive multi-tab tasks
• Work out how an unfamiliar site serves its data, then read it directly
• Drive LLM-written browser tests against your real session
• Fetch JSON APIs, RSS, and sitemaps straight from your session (CORS-free, cookie-authed)
• Keep a page fix applied on every visit

━━━ THE TOOLBELT (35+ primitives) ━━━

• Navigate & read — open_url, get_page_text, fetch_url, get_html, screenshot, scroll_page
• Search & crawl — web_search, list_links
• Interact — click, type_into, fill_form, press_key, select_option, hover, drag_and_drop, file_upload, handle_dialog
• Perceive the DOM — get_interactives, get_dom_outline, query_dom, find_in_page, find_in_dom, wait_for_selector
• Reconnaissance — find_structured_data, get_a11y_tree, capture_network
• Your own JavaScript — eval_js
• Persistent page rules — create_site_script, preview_site_script, list_site_scripts, get_site_script, set_site_script_enabled, delete_site_script
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

━━━ BEFORE YOU INSTALL ━━━

• It runs headless: no window, no sidebar — just a small toolbar popup showing connection status, the tool catalog, and your site scripts.
• Site scripts need Chrome's "Allow user scripts" switch on this extension's details page. It takes one click, the popup walks you through it, and every other tool works without it.

━━━ GET STARTED ━━━

1. Install WebCLI from the Chrome Web Store (it runs headless — only a small status popup).
2. Ask your agent to run:  npx skills add whitefoxx/web-tools -g
3. Then ask your agent to use the browser. The skill knows the rest — including starting the local daemon on port 9376, which WebCLI connects to automatically.

Docs & the daemon: https://github.com/whitefoxx/web-tools

WebCLI is the "pure provider" sibling of the Web Agent extension: the same battle-tested browser tools, packaged headless for external agents.

## Dashboard fields — the Privacy form, ready to paste

**Category:** Developer Tools (secondary: Productivity)

Two things differ from localmd Connect's form: this shell requests `alarms`
(it re-dials the daemon) and does **not** request `offscreen` or `contextMenus`,
and **remote code is answered NO** where that shell used to answer yes.

### Single purpose description

> WebCLI is a headless browser-control bridge. It exposes a fixed set of browser
> actions — open a URL, read and extract page content, click, type, scroll, take
> screenshots, manage tabs, and apply page rules the user has approved — to an AI
> agent the user runs on their own machine, over a local daemon on 127.0.0.1 that
> the extension dials out to. It has no AI of its own, no interface beyond a
> status popup, and no web page can reach it.

### Permission justifications

**debugger**

> This is the core automation engine. The extension uses the Chrome DevTools
> Protocol (chrome.debugger) to reliably drive the tabs the agent targets —
> navigating, reading the DOM and accessibility tree, dispatching clicks and
> keystrokes, capturing screenshots, and observing the requests a page makes when
> the agent needs to find where a value came from. It attaches only to tabs
> involved in a command from the local daemon.

**tabs**

> Used to open, query, switch, and close tabs while carrying out browser actions
> (open a URL, list open tabs, close a tab it opened). Used only to perform the
> actions the agent requests.

**tabGroups**

> When the agent opens several tabs for a task, the extension groups them under
> "WebCLI" to keep them organized and visually separated from the user's own tabs.
> Used only for tabs the extension itself creates.

**scripting**

> Used to read and act on pages. The extension injects its own bundled scripts to
> read page structure (links, buttons, inputs, text) and perform the requested
> interactions (click, type, select, scroll). Injection happens only into tabs
> involved in a command from the agent.

**userScripts** — NEW in 0.4.0, expect the review to focus here

> Site scripts are page rules the user has explicitly approved — hide these
> elements, apply this CSS, run this small script on this site. They are not
> bundled with the extension (the user's own agent writes them and the user
> approves them), so they run in Chrome's isolated USER_SCRIPT world rather than
> the extension's own context. Chrome additionally gates this API behind a switch
> the user turns on themselves, so nothing runs until they do, and every script is
> listed in the extension popup where the user can pause or delete it.

**storage**

> Stores only the extension's own data in chrome.storage.local and IndexedDB: the
> site-script rules the user approved, the daemon port, and the user's
> tool-catalog preference. No browsing data or personal information is stored.

**cookies**

> The extension automates the user's own logged-in session. The cookies permission
> lets the browser-automation layer read the active tab's cookies so requests it
> makes on the user's behalf stay within that existing session. Cookies are never
> collected or sent to the developer or any third party.

**downloads**

> Automated navigation can trigger a file download. The downloads permission lets
> the extension manage download behavior during automation so a download prompt
> doesn't stall a task the agent is running. The extension does not initiate
> downloads on its own and sends nothing to the developer.

**alarms**

> A one-minute alarm re-dials the local daemon, so the extension reconnects on its
> own within a minute of the user starting it instead of needing a reload.

**Host permission (`<all_urls>`)**

> The user decides which website to work with, so the target can be any site.
> Broad host access is required to open, read, and interact with whatever page the
> user directs their agent to, and to apply the page rules the user approved. The
> extension touches a site only when the agent issues a command for it; it does
> not run in the background across sites.

### Remote code — **NO**

> The extension executes no remote code: everything it runs is bundled in the
> package. Site scripts are written by the user's own agent, approved by the user,
> and stored locally — never fetched from a server. `eval_js` runs JavaScript the
> user's own agent supplies over the local daemon on 127.0.0.1: the user
> instructing their own browser, not code fetched from the internet.

### Data usage

Tick **Website content** — and nothing else. The extension reads page text,
structure and screenshots in order to hand them back to the agent running on the
user's own machine. Nothing is transmitted off the user's device by the
extension: there is no server on our side to send it to. What the user's agent
then does with it (e.g. sending it to the model provider they configured) is
governed by that agent, not by this extension.

Do not tick the others: the extension does not read or collect credentials,
personal communications, location, financial or health data, and it does not log
user activity — it performs actions, it does not record the user's.

All three certifications apply: no selling or transferring user data, no use
unrelated to the single purpose, no creditworthiness or lending use.
