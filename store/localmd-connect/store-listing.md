# localmd Connect — Chrome Web Store listing copy

## Store name (≤45 chars)

localmd Connect - Browser Superpowers

> This IS `manifest.localmd.json`'s `name` — the store displays the manifest
> name. 37 chars. An ASCII hyphen, not an en-dash.
>
> The name doubles as the **tab-group title**: `controlled-tabs.ts` cuts at the
> first dash, so tabs the agent opens are grouped under "localmd Connect" while
> the store shows the full line. Keep "localmd Connect" as the leading token —
> changing it orphans existing groups (see docs/webcli.md §13).

## Summary (single line, ≤132 chars)

Browser tools and one-key capture for localmd.app — the AI knowledge base that runs in your browser, driving your real Chrome.

## Description

> **Do not list site names here.** The first submission was rejected for keyword
> spam over exactly that (localmd-connect-releases.md §5, 0.1.0): a sentence
> naming fourteen sites. Describe capability by category and let nothing in the
> copy or the screenshots read as a list of third-party brands.

localmd Connect gives the AI agent in **localmd.app** a pair of hands in your
own browser — and gives you a one-key way to put what you are reading into your
knowledge base.

**localmd.app** is a free, open-source knowledge base that runs entirely in your
browser, over a folder of plain Markdown files on your own disk. This extension
is its companion, and the two are meant to be used together: it lets that agent
reach the live web the way you do — signed in, in your real Chrome.

**50+ browser tools.** The low-level primitives an agent actually needs: open a
page and read it as clean text or Markdown, list what is clickable, click, type,
fill a whole form in one call, scroll, screenshot, manage tabs, and fetch any URL
with your own cookies past the CORS wall that stops a web page calling most APIs.
They work on any site, including the ones that need you signed in — no cookie
pasting, no second browser, no scraping code to maintain.

**Capture what you are reading, in one key.** Clip the page you are on into your
knowledge base as clean Markdown with its title, author and dates — or clip just
the passage you selected, anchored so you can cite back to it. Drag a rectangle
to screenshot part of a page and annotate it before it lands. A PDF open in a tab
is filed as the file itself. Everything you capture goes into an inbox your agent
writes up for you, so capturing costs you a keystroke and nothing more.

**Highlight while you read.** Mark passages in any page in the colour you want,
write a note on one, and they are still there on your next visit. Your agent can
read them back, so what you marked by hand becomes the strongest signal of what
mattered on that page. Select any text and the toolbar can also translate it,
explain it, or run a prompt you wrote yourself — answered by the model you
configured in localmd.app, right there over the paragraph.

**Reach a site nobody wrote support for.** Reconnaissance tools answer "where
does this value actually come from" — the page's structured data, its
accessibility tree, the requests it makes — and `eval_js` runs JavaScript in the
page's own origin. Your agent works out how to read an unfamiliar site during the
conversation, and you can have it save that recipe as a skill to reuse. Nothing
site-specific is shipped or maintained here.

**And persistent page fixes (experimental).** Site scripts let you fix a page
once and keep it fixed: hide the ad rails and the "people also viewed" clutter,
restyle a site you read daily, or run a small script on pages you choose. The
rule applies on every visit until you remove it.

**Your browser's own memory, if you let it.** Bookmarks, history, reading list
and recently-closed tabs are each behind a switch you flip in the popup — off
until they buy you something, and then your agent can find the page you know you
read without you hunting for it.

━━━ WHAT YOU CAN DO ━━━

• Research a login-only site straight into your knowledge base at localmd.app
• Clip a page, a selection, a region screenshot or a PDF with one keystroke
• Highlight as you read, and have your agent write up what you marked
• Translate or explain a passage in place, or run a prompt you wrote yourself
• Read any page as clean Markdown, or fetch JSON/RSS with your own session
• Have the agent browse, click, fill forms and take screenshots for you
• Work out how an unfamiliar site serves its data, and save the recipe as a skill
• Drive a multi-step task across tabs while you watch it happen
• Strip the noise from a site you read daily, permanently

━━━ YOU DECIDE, ALWAYS ━━━

• Exactly one site can reach the tools — localmd.app, and nothing else. The
list is built into the extension; there is no setting that widens it, so no
page can talk you into granting itself access
• Nothing outside your browser can reach it either: no local server, no port,
no daemon
• Anything that posts or changes something on a real site pauses for your
confirmation first, in localmd.app, showing exactly what it will do
• Anything that injects code into your pages does the same
• Every site script is listed in the toolbar popup, where you can pause or
delete it at any time
• Your bookmarks, history and reading list stay unreadable until you switch
each one on yourself
• Nothing is sent to any server of ours — there is no server; the whole thing
runs in your browser and on your machine

━━━ BEFORE YOU INSTALL ━━━

• This is a **companion extension**. On its own it does nothing — it needs
localmd.app, which is free and open source.
• Site scripts need Chrome's **"Allow user scripts"** switch, on this
extension's details page. It takes one click, the popup walks you through it,
and everything else works without it.
• It runs headless: no window, no sidebar, just a small toolbar popup showing
status, what you captured, and your site scripts.

━━━ GET STARTED ━━━

1. Install localmd Connect.
2. Open localmd.app — it is allowed by default. Settings → Tools will say
   Connected, and your agent has the tools.
3. Turn on "Allow user scripts" in the extension's details page if you want
   persistent page fixes.

The knowledge base itself: https://localmd.app

## Dashboard fields — the Privacy form, ready to paste

**Category:** Productivity (secondary: Developer Tools)

Three things differ from WebCLI's form and are the easy ones to get wrong: this
shell requests `contextMenus` (the capture menu) which WebCLI does not, it does
**not** request `alarms` (the shipping build has no daemon to redial — if the
dashboard shows an alarms box, the manifest is wrong), and as of 0.2.0 **remote
code is answered NO** — it was YES while site adapters were fetched at runtime,
and they are gone.

### Single purpose description

> localmd Connect is a companion extension for the web app localmd.app — an AI
> knowledge base that runs entirely in the user's browser over their own local
> Markdown files. It gives that app's agent a fixed set of actions on the user's
> own Chrome: open a URL, read and extract page content, click, type, scroll,
> take screenshots, and manage tabs; capture pages, selections and screenshots
> into the user's knowledge base; and apply page rules the user has approved.
> Only localmd.app can reach it — that list is compiled into the extension — and
> it acts only when that app sends a command. It has no AI of its own.

### Permission justifications

**debugger**

> This is the core automation engine. The extension uses the Chrome DevTools
> Protocol (chrome.debugger) to reliably drive the tabs the agent targets —
> navigating, reading the DOM and accessibility tree, dispatching clicks and
> keystrokes, and capturing screenshots. It attaches only to tabs involved in a
> command from localmd.app.

**tabs**

> Used to open, query, switch, and close tabs while carrying out browser actions
> (for example, open a URL, list open tabs, or close a tab it opened). Used only
> to perform the actions localmd.app requests.

**tabGroups**

> When the agent opens several tabs for a task, the extension groups them under
> "localmd Connect" to keep them organized and visually separated from the
> user's own tabs. Used only for tabs the extension itself creates.

**scripting**

> Used to read and act on pages. The extension injects its own bundled scripts to
> read page structure (links, buttons, inputs, text), perform the requested
> interactions (click, type, select, scroll), and show the in-page highlighter
> and capture toolbar. Injection happens only into tabs involved in a command
> from localmd.app, or into the page the user invoked a capture on.

**userScripts**

> Site scripts are page rules the user has explicitly approved — hide these
> elements, apply this CSS, run this small script on this site. They are written
> by the user's own agent and approved by the user rather than bundled with the
> extension, so they run in Chrome's isolated USER_SCRIPT world rather than the
> extension's own context. Chrome additionally gates this API behind a switch the
> user turns on themselves, so nothing runs until they do, and every script is
> listed in the popup where the user can pause or delete it.

**contextMenus**

> Adds the extension's own right-click entries for capturing — clip this page,
> clip this selection, screenshot a region — so the user can send what they are
> reading to their knowledge base without leaving the page.

**storage**

> Stores only the extension's own data in chrome.storage.local and IndexedDB: the
> site-script rules the user approved, the highlights the user made, and the
> queue of items they captured but the app has not written up yet. No browsing
> data or personal information is collected, and the list of sites allowed to use
> the extension is compiled in, not stored.

**cookies**

> The extension automates the user's own logged-in session. The cookies
> permission lets the browser-automation layer read the active tab's cookies so
> requests it makes on the user's behalf stay within that existing session.
> Cookies are never collected or sent to the developer or any third party.

**downloads**

> Automated navigation can trigger a file download, and clipping a PDF the user
> has open needs to read that file. The downloads permission lets the extension
> manage download behavior during automation so a prompt doesn't stall a task.
> The extension sends nothing to the developer.

**Optional: bookmarks, history, readingList, sessions**

> Requested only when the user switches each one on in the popup — the extension
> ships with none of them granted. They let the agent find a page the user
> already saved or read (search their bookmarks, their history, their reading
> list, or the tabs they just closed) instead of asking them to hunt for it, and
> to add a page to their bookmarks or reading list when they ask. Each is
> independently revocable, and the extension works without any of them.

**Host permission (`<all_urls>`)**

> The user decides which website to work with, so the target can be any site.
> Broad host access is required to open, read, and interact with whatever page
> the user directs the agent to, to capture the page they are reading, and to
> apply the page rules the user approved. The extension touches a site only when
> localmd.app issues a command for it or the user invokes a capture there; it
> does not run in the background across sites.

### Remote code — **NO** (changed in 0.2.0)

> The extension executes no remote code: everything it runs is bundled in the
> package. Until 0.2.0 it fetched site-adapter modules from a public GitHub
> repository at runtime and answered YES here; those were removed in 0.2.0 and
> nothing replaces them. Site scripts are written by the user's own agent,
> approved by the user, and stored locally — never fetched from a server.
> `eval_js` runs JavaScript the user's own agent supplies through localmd.app:
> the user instructing their own browser, not code fetched from the internet.

### Data usage

Tick **Website content** — and nothing else. The extension reads page text,
structure and screenshots in order to hand them back to the localmd.app tab in
the same browser. Nothing is transmitted off the user's device by the
extension: there is no server on our side to send it to. What localmd.app then
does with it (e.g. sending it to the model provider the user configured) is
disclosed by localmd.app under its own policy.

Do not tick the others: the extension does not read or collect credentials,
personal communications, location, financial or health data, and it does not
log user activity — it performs actions, it does not record the user's. The
optional bookmarks / history / reading-list permissions read that data only to
answer the user's own request, in their own browser, and it is never sent
anywhere by the extension.

All three certifications apply: no selling or transferring user data, no use
unrelated to the single purpose, no creditworthiness or lending use.

### Privacy policy URL

Required for this permission set. Point it at localmd.app's policy, which must
cover the extension too — at minimum: the extension transmits nothing to the
developer; page content it reads is returned to the localmd.app tab in the same
browser; site scripts, highlights and pending captures are stored locally.

## Assets

`images/` (generated — see `render.mjs`, and regenerate with `raster.mjs`):

| File                         | Use                                                                       |
| ---------------------------- | ------------------------------------------------------------------------- |
| `screenshot-1-hero.jpg`      | 1280×800 — what it is, and that it is a companion to localmd.app          |
| `screenshot-2-tools.jpg`     | 1280×800 — the whole toolbelt                                             |
| `screenshot-3-capture.jpg`   | 1280×800 — capture + highlight: the one-key path into the knowledge base  |
| `screenshot-4-how.jpg`       | 1280×800 — localmd.app → extension → your Chrome                          |
| `screenshot-5-start.jpg`     | 1280×800 — the setup steps                                                |

Site scripts deliberately have **no screenshot of their own**. The pitch is that
the agent in localmd.app gets real browser tools that work everywhere, plus a
one-key way to capture what you are reading; page fixes are the third thing, not
the headline. They appear as a row in the toolbelt and a paragraph in the
description — the weight they actually carry.

> **0.2.0 asset note.** `screenshot-3-adapters.jpg` was the adapter story and is
> replaced by `screenshot-3-capture.jpg`; the promo tiles and the hero no longer
> say "~300 site adapters". Re-render and re-raster before uploading, and look at
> every image (§4 step 3 — a chip once shipped flush against a brace).
