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

A pair of hands for the agent in localmd.app: read and act on pages in your own signed-in browser, and clip them into your folder.

## Description

> **Do not list site names, and never count SITES.** The first submission was
> rejected for keyword spam over a sentence naming fourteen sites
> (localmd-connect-releases.md §5, 0.1.0), and "300 ready-made actions for 30+
> sites" fails the same way one abstraction up: it sells a catalogue, which is
> not how this product works, and it is wrong the week a site is redesigned.
>
> **Counting the base tools is fine and is not the same claim.** They are the
> foundation the agent builds on, not a catalogue you shop; the number is stable
> because primitives do not rot when a page changes. Confirmed by the user
> 2026-09-07 — an earlier pass here stripped every number and went too far.
>
> **Say "asks", never "cannot".** What exists is review — a diff to approve, a
> confirmation before a write, restorable deletes, git underneath. That is not a
> structural guarantee, and the readers who care are listening for precisely
> that difference. Same rule for the network: do not claim nothing leaves the
> machine. Text you send goes to your own model provider under your own key, and
> localmd.app says so out loud.

**localmd.app** is a knowledge base that lives in a folder of plain Markdown on
your own disk: an agent lives in your folder, and a wiki grows around your
files. It reads the PDFs, EPUBs and notes already there and writes linked
Markdown beside them. Every citation clicks back to the exact paragraph, and
every change waits for your yes.

**localmd Connect gives that same agent a pair of hands in your browser.**

Not a second AI in your browser with its own chat box and its own memory. That
arrangement just leaves you copy-pasting between it and everything else. This is the
agent you already talk to, with the same knowledge base and the same citation
rules, reaching one more place: a browser you are already signed into.

**What you read lands in your folder.** Clip the page you are on as clean
Markdown with its title, author and dates, or just the passage you selected,
anchored so you can cite back to it. Drag a rectangle to screenshot part of a
page and annotate it. A PDF open in a tab is filed as the file itself. It
arrives as a source in your own folder, citable like any book you put there, so
carrying context out of the browser stops being your job.

**50+ browser tools, and they work on your own logged-in browser.** Open a page
and read it as clean text or Markdown, list what is clickable, click, type, fill
a whole form in one call, press keys, scroll, screenshot, manage tabs, and fetch
any URL with your own session past the CORS wall that stops an ordinary web page
calling most APIs. Pages behind a sign-in, and services that refuse a web page
outright, are simply available. No cookie pasting, no second browser, no
scraping code to keep alive.

These are primitives, not per-site integrations. They work the same way on a
site nobody has ever looked at as on one you use daily.

**A site nobody wrote support for is a conversation, not a missing feature.**
The agent can ask where a value actually comes from: the page's structured
data, its accessibility tree, the requests it makes. Then it can run JavaScript
in the page's own origin until the answer comes back the same way twice. Then it saves
what it worked out as a **skill in your own folder**, and the next time is
immediate. Adding a capability is a conversation you have, not a release you
wait for.

**Highlight while you read.** Mark passages in any page in the colour you want,
write a note on one, and they are still there on your next visit. Your agent can
read them back, so what you marked by hand becomes the strongest signal of what
mattered. Select any text and the toolbar can also translate it, explain it, or
run a prompt you wrote yourself, answered by the model you configured in
localmd.app, right there over the paragraph.

**And persistent page fixes (experimental).** Site scripts let you fix a page
once and keep it fixed: hide the ad rails and the clutter, restyle a site you
read daily, or run a small script on pages you choose, on every visit until you
remove it.

**Your browser's own memory, if you let it.** Bookmarks, history, reading list
and recently-closed tabs are each behind a switch you flip in the popup. Off
until they buy you something, and then your agent can find the page you know you
read without you hunting for it.

━━━ WHAT YOU CAN DO ━━━

• Clip a page, a selection, a region screenshot or a PDF into your folder with
one keystroke, and cite it later like any other source
• Research a site you have to be signed in to, straight into your knowledge base
• Highlight as you read, and have your agent write up what you marked
• Translate or explain a passage in place, or run a prompt you wrote yourself
• Have the agent work out how an unfamiliar site serves its data, and keep what
it learned as a skill in your folder
• Read any page as clean Markdown, or fetch JSON and RSS with your own session
• Drive a multi-step task across tabs while you watch it happen
• Strip the noise from a site you read daily, permanently

━━━ HOW MUCH IT DOES ON ITS OWN ━━━

The honest answer is mechanisms, not intentions:

• Exactly one site can reach the tools: localmd.app. The list is compiled into
the extension; there is no setting that widens it, so no page can talk you into
granting itself access
• Nothing outside your browser can reach it either: no local server, no port,
no daemon
• Anything that would post, send or delete on a real site asks first, in
localmd.app, showing exactly what it is about to do. Driving the page's own
buttons by hand does not get around it
• Anything that injects code into your pages asks the same way
• Writes to your folder arrive as a diff you approve or discard, with git
underneath, so nothing is a one-way door
• Every site script is listed in the popup, where you can pause or delete it
• Your bookmarks, history and reading list stay unreadable until you switch each
one on yourself
• There is no server of ours anywhere in this. Be clear about what that does
and does not mean, though: what you send your model goes to the provider you
configured, under your own key

━━━ OPEN SOURCE ━━━

Both halves are open and MIT-licensed. The app is at
https://github.com/whitefoxx/localmd and this extension at
https://github.com/whitefoxx/web-tools. An extension that drives your
signed-in browser is exactly the half you should be able to read.

Your files should outlive the app. They are Markdown in a folder you chose; if
you stop using localmd tomorrow, everything you wrote is still there, openable
by anything.

━━━ WHAT TO EXPECT ━━━

• This is a **companion**. On its own it does nothing; it needs localmd.app,
which is free and open source.
• **An agent driving a site is less settled than a purpose-built integration.**
Sites get redesigned and things break. We think this is the right direction and
are betting on it; you should know it is a bet and not a finished spec.
• Chrome or Chromium only. The app half needs the File System Access API, the
same API that lets your knowledge base be a real folder on your disk instead of
a database we hold.
• Site scripts need Chrome's **"Allow user scripts"** switch on this extension's
details page. One click, and everything else works without it.
• It runs headless: no window, no sidebar, just a small toolbar popup showing
status, what you captured, and your site scripts.

━━━ GET STARTED ━━━

1. Install localmd Connect.
2. Open localmd.app. It is allowed by default, and Settings → Tools will say
   Connected, and your agent has the tools.
3. Turn on "Allow user scripts" in the extension's details page if you want
   persistent page fixes.

The knowledge base itself: https://localmd.app

## Dashboard fields — the Privacy form, ready to paste

**Category:** Productivity (secondary: Developer Tools)

> **Convention in this section: plain text is a field value, `>` is a note.**
> Everything not quoted is meant to be selected and pasted into the dashboard
> exactly as it stands — that is why the answers below carry no blockquote
> markers. Anything quoted is guidance for whoever is editing this file and must
> never end up in the form.

Three things differ from WebCLI's form and are the easy ones to get wrong: this
shell requests `contextMenus` (the capture menu) which WebCLI does not, it does
**not** request `alarms` (the shipping build has no daemon to redial — if the
dashboard shows an alarms box, the manifest is wrong), and as of 0.2.0 **remote
code is answered NO** — it was YES while site adapters were fetched at runtime,
and they are gone.

### Single purpose description

localmd Connect is a companion extension for the web app localmd.app — an AI
knowledge base that runs entirely in the user's browser over their own local
Markdown files. It gives that app's agent a fixed set of actions on the user's
own Chrome: open a URL, read and extract page content, click, type, scroll,
take screenshots, and manage tabs; capture pages, selections and screenshots
into the user's knowledge base; and apply page rules the user has approved.
Only localmd.app can reach it — that list is compiled into the extension — and
it acts only when that app sends a command. It has no AI of its own.

### Permission justifications

**debugger**

This is the core automation engine. The extension uses the Chrome DevTools
Protocol (chrome.debugger) to reliably drive the tabs the agent targets —
navigating, reading the DOM and accessibility tree, dispatching clicks and
keystrokes, and capturing screenshots. It attaches only to tabs involved in a
command from localmd.app.

**tabs**

Used to open, query, switch, and close tabs while carrying out browser actions
(for example, open a URL, list open tabs, or close a tab it opened). Used only
to perform the actions localmd.app requests.

**tabGroups**

When the agent opens several tabs for a task, the extension groups them under
"localmd Connect" to keep them organized and visually separated from the
user's own tabs. Used only for tabs the extension itself creates.

**scripting**

Used to read and act on pages. The extension injects its own bundled scripts to
read page structure (links, buttons, inputs, text), perform the requested
interactions (click, type, select, scroll), and show the in-page highlighter
and capture toolbar. Injection happens only into tabs involved in a command
from localmd.app, or into the page the user invoked a capture on.

**userScripts**

Site scripts are page rules the user has explicitly approved — hide these
elements, apply this CSS, run this small script on this site. They are written
by the user's own agent and approved by the user rather than bundled with the
extension, so they run in Chrome's isolated USER_SCRIPT world rather than the
extension's own context. Chrome additionally gates this API behind a switch the
user turns on themselves, so nothing runs until they do, and every script is
listed in the popup where the user can pause or delete it.

**contextMenus**

Adds this extension's own right-click entries for capturing what the user is
reading — clip this page, clip the current selection, screenshot a region — so
they can send it to their knowledge base at localmd.app without leaving the
page. These are the only menu items the extension creates, and each one acts on
the page the user invoked it from. No menu entry sends anything to the
developer.

**storage**

Stores only the extension's own data in chrome.storage.local and IndexedDB: the
site-script rules the user approved, the highlights the user made, and the
queue of items they captured but the app has not written up yet. No browsing
data or personal information is collected, and the list of sites allowed to use
the extension is compiled in, not stored.

**cookies**

The extension automates the user's own logged-in session. The cookies
permission lets the browser-automation layer read the active tab's cookies so
requests it makes on the user's behalf stay within that existing session.
Cookies are never collected or sent to the developer or any third party.

**downloads**

Automated navigation can trigger a file download, and clipping a PDF the user
has open needs to read that file. The downloads permission lets the extension
manage download behavior during automation so a prompt doesn't stall a task.
The extension sends nothing to the developer.

> **The dashboard asks for each optional permission SEPARATELY** — one 1,000-char
> field per permission, not one block for all four. They are written out
> individually below so they can be pasted straight in. Each opens by saying the
> permission is off by default, because that is the fact a reviewer is checking
> for: none of these appear in the install prompt.

**bookmarks**

Optional and OFF by default: Chrome never prompts for it at install, and the
extension requests it only when the user turns it on with a switch in its
toolbar popup.

It lets the agent in localmd.app answer "find that page I bookmarked" by
searching and listing the user's own bookmarks, and add or remove one when the
user asks it to. Used only to carry out a request the user made in that app.

Bookmarks are read in the user's browser and returned to the localmd.app tab in
the same browser. They are never collected by the extension, never sent to the
developer, and there is no server on our side to send them to. The extension
works fully with this permission denied, and the user can revoke it at any time
from the same switch.

**history**

Optional and OFF by default: Chrome never prompts for it at install, and the
extension requests it only when the user turns it on with a switch in its
toolbar popup.

It lets the agent in localmd.app answer "find that article I read last week" —
searching the user's own history for a page they are trying to get back to,
instead of asking them to hunt for it by hand. Used only to carry out a request
the user made in that app.

Read only: the extension never deletes or modifies browsing history. Results
are returned to the localmd.app tab in the same browser, are never collected by
the extension, and are never sent to the developer — there is no server on our
side to send them to. The extension works fully with this permission denied,
and the user can revoke it at any time from the same switch.

**readingList**

Optional and OFF by default: Chrome never prompts for it at install, and the
extension requests it only when the user turns it on with a switch in its
toolbar popup.

It lets the agent in localmd.app find something the user saved to Chrome's
reading list for later, add a page to it when they ask, remove one, or mark one
as read. Used only to carry out a request the user made in that app.

The reading list is read in the user's browser and returned to the localmd.app
tab in the same browser. It is never collected by the extension and never sent
to the developer — there is no server on our side to send it to. The extension
works fully with this permission denied, and the user can revoke it at any time
from the same switch.

**sessions**

Optional and OFF by default: Chrome never prompts for it at install, and the
extension requests it only when the user turns it on with a switch in its
toolbar popup.

It lets the agent in localmd.app list recently closed tabs, so the user can
recover a page they closed by accident and still wanted. Used only to carry out
a request the user made in that app.

Read only: the extension lists what Chrome already remembers and does not
reopen or alter anything on its own. The list is returned to the localmd.app
tab in the same browser, is never collected by the extension, and is never sent
to the developer — there is no server on our side to send it to. The extension
works fully with this permission denied, and the user can revoke it at any time
from the same switch.

**Host permission (`<all_urls>`)**

The user decides which website to work with, so the target can be any site.
Broad host access is required to open, read, and interact with whatever page
the user directs the agent to, to capture the page they are reading, and to
apply the page rules the user approved. The extension touches a site only when
localmd.app issues a command for it or the user invokes a capture there; it
does not run in the background across sites.

### Remote code — **NO** (changed in 0.2.0)

> **This paragraph is for the reviewer and stays as written.** The marketing copy
> above deliberately no longer tells the story of a site catalog that was shipped
> and then dropped — the product is described by what it is, not by what it used
> to be. The privacy form is the opposite case: this answer FLIPPED from YES to
> NO between two published versions, the reviewer can see both, and an
> unexplained flip on the remote-code question is the kind of thing that gets a
> submission held. Explaining a material change is not the same as advertising
> history. Do not trim it to match the description.


The extension executes no remote code: everything it runs is bundled in the
package. Until 0.2.0 it fetched site-adapter modules from a public GitHub
repository at runtime and answered YES here; those were removed in 0.2.0 and
nothing replaces them. Site scripts are written by the user's own agent,
approved by the user, and stored locally — never fetched from a server.
`eval_js` runs JavaScript the user's own agent supplies through localmd.app:
the user instructing their own browser, not code fetched from the internet.

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
