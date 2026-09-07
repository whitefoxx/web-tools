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

Browser tools and ~300 site adapters for localmd.app — the AI knowledge base that runs in your browser, driving your real Chrome.

## Description

> **Do not list site names here.** The first submission was rejected for keyword
> spam over exactly that (localmd-connect-releases.md §5, 0.1.0): a sentence
> naming fourteen sites the adapters cover. Sell the catalogue by category and
> let the public repo hold the list — and keep the screenshots clean too, since
> the policy counts them as metadata as well.

localmd Connect gives the AI agent in **localmd.app** a pair of hands in your
own browser.

**localmd.app** is a knowledge base that runs entirely in your browser, over a
folder of plain Markdown files on your own disk. This extension is its
companion, and the two are meant to be used together: it lets that agent reach
the live web the way you do — signed in, in your real Chrome.

**30+ browser tools.** The low-level primitives an agent actually needs: open a
page and read it as clean text or Markdown, list what is clickable, click, type,
fill a whole form in one call, scroll, screenshot, manage tabs, and fetch any URL
with your own cookies past the CORS wall that stops a web page calling most APIs.
They work on any site, including the ones that need you signed in — no cookie
pasting, no second browser, no scraping code to maintain.

**~300 ready-made site adapters (experimental).** On top of the primitives, purpose-built tools
for around thirty of the sites people research on — social feeds, video, forums
and Q&A, reading and book notes, academic and reference sources. Ask for
something from one of them and the agent looks up the right adapter and runs it
in a single call: structured results instead of guesswork against a page that
changes every month. Adapters load on demand, verified by checksum. Nothing is
installed and nothing is left behind. The catalogue is public and browsable at
github.com/whitefoxx/web-agent-marketplace.

**And persistent page fixes (experimental).** Site scripts let you fix a page once and keep it
fixed: hide the ad rails and the "people also viewed" clutter, restyle a site you
read daily, or run a small script on pages you choose. The rule applies on every
visit until you remove it.

━━━ WHAT YOU CAN DO ━━━

• Research a login-only site straight into your knowledge base at localmd.app
• Read any page as clean Markdown, or fetch JSON/RSS with your own session
• Pull structured results from a supported site instead of a wall of raw text
• Have the agent browse, click, fill forms and take screenshots for you
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
• Nothing is sent to any server of ours — there is no server; the whole thing
runs in your browser and on your machine

━━━ BEFORE YOU INSTALL ━━━

• This is a **companion extension**. On its own it does nothing — it needs
localmd.app, and using it there is part of localmd.app's paid tier.
• Adapters and site scripts need Chrome's **"Allow user scripts"** switch, on
this extension's details page. It takes one click and the popup walks you
through it.
• It runs headless: no window, no sidebar, just a small toolbar popup showing
status, the adapter catalogue, and your site scripts.

━━━ GET STARTED ━━━

1. Install localmd Connect.
2. Turn on "Allow user scripts" in the extension's details page.
3. Open localmd.app — it is allowed by default. Settings → Tools will say
   Connected, and your agent has the tools.

The knowledge base itself: https://localmd.app

## Dashboard fields — the Privacy form, ready to paste

**Category:** Productivity (secondary: Developer Tools)

Three things differ from WebCLI's form and are the easy ones to get wrong:
this shell requests `userScripts` and `offscreen` which WebCLI does not, it
does **not** request `alarms` (the shipping build has no daemon to redial —
if the dashboard shows an alarms box, the manifest is wrong), and **remote
code must be answered YES** where WebCLI answers no.

### Single purpose description

> localmd Connect is a companion extension for the web app localmd.app — an AI
> knowledge base that runs entirely in the user's browser over their own local
> Markdown files. It gives that app's agent a fixed set of actions on the user's
> own Chrome: open a URL, read and extract page content, click, type, scroll,
> take screenshots, and manage tabs; run ready-made site adapters from a public
> catalogue; and apply page rules the user has approved. Only localmd.app can
> reach it — that list is compiled into the extension — and it acts only when
> that app sends a command. It has no AI of its own.

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
> read page structure (links, buttons, inputs, text) and perform the requested
> interactions (click, type, select, scroll). Injection happens only into tabs
> involved in a command from localmd.app.

**userScripts**

> Two features need scripts that are not bundled with the extension. Site
> adapters are small per-site modules from a public catalogue, and site scripts
> are page rules the user has explicitly approved (hide these elements, apply
> this CSS). Both run in Chrome's isolated USER_SCRIPT world rather than the
> extension's own context. Chrome additionally gates this API behind a switch the
> user turns on themselves, so nothing runs until they do.

**offscreen**

> Used to sandbox untrusted code. Before a site adapter can run, its source is
> evaluated in an offscreen document to extract its definition. Doing that there
> rather than in the service worker means third-party adapter code never executes
> with extension privileges or access to extension APIs.

**storage**

> Stores only the extension's own data in chrome.storage.local and IndexedDB: the
> site-script rules the user approved, and a cached copy of the public adapter
> catalogue. No browsing data or personal information is stored, and the list of
> sites allowed to use the extension is compiled in, not stored.

**cookies**

> The extension automates the user's own logged-in session. The cookies
> permission lets the browser-automation layer read the active tab's cookies so
> requests it makes on the user's behalf stay within that existing session.
> Cookies are never collected or sent to the developer or any third party.

**downloads**

> Automated navigation can trigger a file download. The downloads permission lets
> the extension manage download behavior during automation so a download prompt
> doesn't stall a task the agent is running. The extension does not initiate
> downloads on its own and sends nothing to the developer.

**Host permission (`<all_urls>`)**

> The user decides which website to work with, so the target can be any site.
> Broad host access is required to open, read, and interact with whatever page the
> user directs the agent to, and to apply the page rules the user approved. The
> extension touches a site only when localmd.app issues a command for it; it does
> not run in the background across sites.

### Remote code — **YES**

> Site adapters are small JavaScript modules fetched at runtime from a public
> GitHub repository (github.com/whitefoxx/web-agent-marketplace) when the user's
> agent asks for a specific site's tool. Each one is pinned by a SHA-256 hash
> recorded in the catalogue index and is refused if the hash does not match. They
> are evaluated in a sandboxed offscreen document, never in the extension's own
> context, so they cannot reach extension APIs. Loading them at runtime is what
> lets a site-specific tool be corrected when that site changes its markup,
> without shipping an extension update for every site.

### Data usage

Tick **Website content** — and nothing else. The extension reads page text,
structure and screenshots in order to hand them back to the localmd.app tab in
the same browser. Nothing is transmitted off the user's device by the
extension: there is no server on our side to send it to. What localmd.app then
does with it (e.g. sending it to the model provider the user configured) is
disclosed by localmd.app under its own policy.

Do not tick the others: the extension does not read or collect credentials,
personal communications, location, financial or health data, and it does not
log user activity — it performs actions, it does not record the user's.

All three certifications apply: no selling or transferring user data, no use
unrelated to the single purpose, no creditworthiness or lending use.

### Privacy policy URL

Required for this permission set. Point it at localmd.app's policy, which must
cover the extension too — at minimum: the extension transmits nothing to the
developer; page content it reads is returned to the localmd.app tab in the same
browser; site scripts and the cached adapter catalogue are stored locally.

## Assets

`images/` (generated — see `render.mjs`, and regenerate with `raster.mjs`):

| File                         | Use                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `screenshot-1-hero.jpg`      | 1280×800 — what it is, and that it is a companion to localmd.app               |
| `screenshot-2-tools.jpg`     | 1280×800 — the whole toolbelt; adapters and site scripts are the two blue rows |
| `screenshot-3-adapters.jpg`  | 1280×800 — the adapter story, with the two real calls                          |
| `screenshot-4-how.jpg`       | 1280×800 — localmd.app → extension → your Chrome                               |
| `screenshot-5-start.jpg`     | 1280×800 — the three setup steps                                               |
| `promo-marquee-1400x560.jpg` | marquee tile                                                                   |
| `promo-small-440x280.jpg`    | small tile                                                                     |

Site scripts deliberately have **no screenshot of their own**. The pitch is that
the agent in localmd.app gets real browser tools that work everywhere, plus
purpose-built ones on the sites people research; page fixes are the third thing,
not the headline. They appear as a row in the toolbelt and a paragraph in the
description — the weight they actually carry.
