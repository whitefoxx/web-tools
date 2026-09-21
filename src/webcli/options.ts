/**
 * WebCLI's settings page.
 *
 * The popup used to be the whole UI, and it carried five jobs in 320px: say
 * what this thing is, show the connection, hand over the setup command, hold
 * the tool-set knob, and be the standing control for every site script an agent
 * installed. The last two are the ones that broke: a list of persistent rules
 * running on your pages is something you read carefully — matches, source, when
 * it appeared — and 320px can show a name and a checkbox.
 *
 * So the split is localmd Connect's (docs/localmd-connect.md): the popup is the
 * quick thing — am I connected — and this page is everything read rarely and
 * carefully. Three sections, in the order a user meets them: the connection,
 * the catalog their agent is paying for on every request, and the rules running
 * on their pages.
 *
 * The nav machinery below is deliberately a second copy of the one in
 * `localmd-connect/options.ts` rather than a shared module. It is ~40 lines,
 * the two pages have diverged in what a nav item shows (this one carries a live
 * connection dot), and the bar for extracting an abstraction here is the third
 * hand-written copy, not the second.
 */

import { ICON_CHEVRON, ICON_CODE, ICON_GITHUB, ICON_PLUG, ICON_TERMINAL } from '../ui/icons';
import {
  CORE_TOOLS,
  coerceProfile,
  TOOL_PROFILE_KEY,
  type ToolProfile,
} from '../core/tool-profile';
import {
  listSiteScripts,
  setSiteScriptEnabled,
  deleteSiteScript,
  type SiteScript,
} from '../site-scripts/store';
import {
  refreshSiteScript,
  unregisterSiteScriptById,
  siteScriptsRunnable,
} from '../site-scripts/register';

const REPO_URL = 'https://github.com/whitefoxx/web-tools';
const DOC_URL = `${REPO_URL}#readme`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/* ── the two panes ────────────────────────────────────────────────────────── */

const NAV_ICONS: Record<string, string> = {
  plug: ICON_PLUG,
  terminal: ICON_TERMINAL,
  code: ICON_CODE,
};

const sections = [...document.querySelectorAll<HTMLElement>('main section[data-nav]')];
const nav = $('nav');
const navButtons = new Map<string, HTMLButtonElement>();

$<HTMLImageElement>('brandMark').src = chrome.runtime.getURL('icons/icon-128.png');
$('ver').textContent = 'v' + chrome.runtime.getManifest().version;
$<HTMLAnchorElement>('docLink').href = DOC_URL;
$<HTMLAnchorElement>('ghLink').href = REPO_URL;
$('ghIco').innerHTML = ICON_GITHUB(20);

for (const section of sections) {
  const b = document.createElement('button');
  b.className = 'nav-item';
  b.dataset.section = section.id;
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.innerHTML = NAV_ICONS[section.dataset.icon ?? ''] ?? '';
  const label = document.createElement('span');
  label.textContent = section.dataset.nav ?? section.id;
  b.append(ico, label);
  // Through the hash, so Back works and a deep link from the popup is the same
  // mechanism the nav uses rather than a special case.
  b.addEventListener('click', () => {
    location.hash = `#${section.id}`;
  });
  navButtons.set(section.id, b);
  nav.append(b);
}

/** A count beside a nav item — the same number its heading shows, so the left
 *  pane says what is in each topic without opening it. */
function navBadge(id: string, text: string): void {
  const b = navButtons.get(id);
  if (!b) return;
  let badge = b.querySelector<HTMLElement>('.badge');
  if (!text) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'badge';
    b.append(badge);
  }
  badge.textContent = text;
}

function show(id: string): void {
  const target = sections.find((s) => s.id === id) ?? sections[0];
  if (!target) return;
  for (const s of sections) s.hidden = s !== target;
  for (const [sid, b] of navButtons) b.classList.toggle('on', sid === target.id);
  document.title = `${target.dataset.nav ?? 'Settings'} — WebCLI`;
  $('main').scrollTo?.({ top: 0 });
}

function showFromHash(): void {
  show(location.hash.replace(/^#/, ''));
}
window.addEventListener('hashchange', showFromHash);
showFromHash();

async function copyInto(btn: HTMLButtonElement, text: string): Promise<void> {
  const label = btn.textContent ?? 'Copy';
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => (btn.textContent = label), 1200);
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
  btn.addEventListener('click', () => {
    const src = document.getElementById(btn.dataset.copy ?? '');
    if (src) void copyInto(btn, (src.textContent ?? '').trim());
  });
}

/* ── connection ───────────────────────────────────────────────────────────── */

const dot = $('dot');
const statusText = $('statusText');
const portText = $('portText');
const setupHint = $('setupHint');
const daemonWhy = $('daemonWhy');

interface Status {
  connected: boolean;
  enabled: boolean;
  port: number;
  profile?: string;
  toolsTotal?: number;
  toolsAdvertised?: number;
}

/** The connection dot is repeated in the nav, so the state is visible from the
 *  other two sections without navigating back. */
function navDot(connected: boolean): void {
  const b = navButtons.get('connection');
  if (!b) return;
  let live = b.querySelector<HTMLElement>('.live');
  if (!live) {
    live = document.createElement('span');
    live.className = 'live';
    b.append(live);
  }
  live.classList.toggle('on', connected);
  live.title = connected ? 'Connected to the daemon' : 'Not connected to the daemon';
}

function renderStatus(s: Status | null): void {
  const connected = !!s?.connected;
  dot.classList.toggle('on', connected);
  navDot(connected);
  // The site-script card tells the user to ask their agent. Whether there IS an
  // agent is this poll's answer, so the gate is updated from here rather than
  // read once when the list renders. Through a hoisted FUNCTION, not the const
  // below: `poll()` runs at module level, above that section, and a `const` read
  // from here is a temporal-dead-zone ReferenceError that takes the rest of the
  // page's wiring with it.
  setAgentGate(connected);
  statusText.textContent = s && !s.enabled ? 'Disabled' : connected ? 'Connected' : 'Not connected';
  portText.textContent = s ? `port ${s.port}` : '';
  setupHint.textContent = connected
    ? 'Connected — your agent can drive this browser now.'
    : 'The skill starts the local bridge for you, and this page turns green within a minute of it coming up.';
  daemonWhy.textContent = connected
    ? 'Already running. This is the command the skill uses.'
    : 'The skill does this for you; run it yourself if you want the daemon in a terminal you can watch.';
  if (typeof s?.toolsTotal === 'number' && typeof s.toolsAdvertised === 'number') {
    renderCounts(s.toolsAdvertised, s.toolsTotal);
  }
}

function poll(): void {
  try {
    chrome.runtime.sendMessage({ type: 'WEBCLI_STATUS' }, (resp?: Status) => {
      void chrome.runtime.lastError; // SW may be waking — ignore, next tick retries
      renderStatus(resp ?? null);
    });
  } catch {
    renderStatus(null);
  }
}

poll();
const timer = setInterval(poll, 2000);
window.addEventListener('unload', () => clearInterval(timer));

/* ── tools ────────────────────────────────────────────────────────────────── */

const profileSeg = $('profileSeg');
const profileCount = $('profileCount');
const profileDesc = $('profileDesc');
const toolCount = $('toolCount');
const toolList = $('toolList');
const toolsEmpty = $('toolsEmpty');
const segButtons = Array.from(profileSeg.querySelectorAll<HTMLButtonElement>('button'));

interface ToolArg {
  name: string;
  type: string;
  help: string;
  required: boolean;
}

interface ToolRow {
  id: string;
  name: string;
  description: string;
  core: boolean;
  args?: ToolArg[];
}

let profile: ToolProfile = 'full';
let tools: ToolRow[] = [];

function renderCounts(advertised: number, total: number): void {
  profileCount.textContent = `${advertised} of ${total} advertised`;
  toolCount.textContent = String(total);
  navBadge('tools', `${advertised}/${total}`);
}

function renderProfile(): void {
  for (const b of segButtons) b.setAttribute('aria-pressed', String(b.dataset.profile === profile));
  profileDesc.textContent =
    profile === 'core'
      ? `Only the ${CORE_TOOLS.length} core tools are advertised — a smaller prompt on every step of your agent's loop. The rest stay callable by name: hidden is not disabled.`
      : 'Every tool is advertised to your agent. Switch to Core for a smaller agent prompt.';
  for (const item of toolList.querySelectorAll<HTMLElement>('.titem')) {
    item.classList.toggle('off', profile === 'core' && item.dataset.core !== '1');
  }
  if (tools.length) {
    renderCounts(
      profile === 'core' ? tools.filter((t) => t.core).length : tools.length,
      tools.length,
    );
  }
}

/** The panel under an open row: the whole description, then every argument.
 *  Built once, on first open — 39 of these up front is a lot of DOM for
 *  something most readers never expand. */
function toolDetail(t: ToolRow): HTMLElement {
  const more = document.createElement('div');
  more.className = 'tmore';

  const full = document.createElement('p');
  full.className = 'full';
  full.textContent = t.description;
  more.append(full);

  if (!t.args?.length) {
    const none = document.createElement('div');
    none.className = 'tnoargs';
    none.textContent = 'Takes no arguments.';
    more.append(none);
    return more;
  }

  for (const a of t.args) {
    const row = document.createElement('div');
    row.className = 'targ';

    const name = document.createElement('span');
    name.className = 'targ-name';
    name.textContent = a.name;

    const type = document.createElement('span');
    type.className = 'targ-type';
    type.textContent = a.type;

    row.append(name, type);
    if (a.required) {
      const req = document.createElement('span');
      req.className = 'targ-req';
      req.textContent = 'required';
      row.append(req);
    }
    if (a.help) {
      const help = document.createElement('span');
      help.className = 'targ-help';
      help.textContent = a.help;
      row.append(help);
    }
    more.append(row);
  }
  return more;
}

function renderTools(): void {
  toolsEmpty.hidden = tools.length > 0;
  toolList.textContent = '';
  for (const t of tools) {
    const item = document.createElement('div');
    item.className = 'titem';
    item.dataset.core = t.core ? '1' : '0';

    const row = document.createElement('button');
    row.className = 'trow';
    row.type = 'button';
    row.setAttribute('aria-expanded', 'false');

    const chev = document.createElement('span');
    chev.className = 'tchev';
    chev.innerHTML = ICON_CHEVRON;

    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = t.name;

    const desc = document.createElement('span');
    desc.className = 'tdesc';
    // The first sentence only: the row is one line. The whole thing is one
    // click away rather than squeezed in as a tooltip nobody hovers.
    desc.textContent = (t.description.split(/(?<=[.!?])\s/)[0] ?? '').trim();

    row.append(chev, name, desc);
    if (t.core) {
      const flag = document.createElement('span');
      flag.className = 'tflag';
      flag.textContent = 'core';
      row.append(flag);
    }

    let more: HTMLElement | null = null;
    row.addEventListener('click', () => {
      const open = !item.classList.contains('open');
      if (open && !more) {
        more = toolDetail(t);
        item.append(more);
      }
      item.classList.toggle('open', open);
      if (more) more.hidden = !open;
      row.setAttribute('aria-expanded', String(open));
    });

    item.append(row);
    toolList.append(item);
  }
  renderProfile();
}

interface ToolsResponse {
  profile?: string;
  tools?: ToolRow[];
}

// Asked once, on open — not polled. A catalog does not change while you read it.
try {
  chrome.runtime.sendMessage({ type: 'WEBCLI_TOOLS' }, (resp?: ToolsResponse) => {
    void chrome.runtime.lastError;
    if (!resp?.tools) return;
    tools = resp.tools;
    renderTools();
  });
} catch {
  /* SW asleep — the empty line explains it */
}

void (async () => {
  try {
    const got = await chrome.storage.local.get([TOOL_PROFILE_KEY]);
    profile = coerceProfile(got[TOOL_PROFILE_KEY]);
  } catch {
    /* storage unavailable — leave it on the default */
  }
  renderProfile();
})();

for (const b of segButtons) {
  b.addEventListener('click', () => {
    const next = coerceProfile(b.dataset.profile);
    if (next === profile) return;
    profile = next;
    renderProfile(); // optimistic: the list dims on the tap, not on the next poll
    void chrome.storage.local.set({ [TOOL_PROFILE_KEY]: next });
    poll(); // and confirm against the SW's registry right away
  });
}

/* ── site scripts ─────────────────────────────────────────────────────────── */

const scriptsCount = $('scriptsCount');
const scriptsWarn = $('scriptsWarn');
const scriptList = $('scriptList');
const scriptsGuide = $('scriptsGuide');
const scriptsGuideTitle = $('scriptsGuideTitle');

/** Hoisted on purpose — see the call in renderStatus. */
function setAgentGate(connected: boolean): void {
  $('scriptsNoAgent').hidden = connected;
}

$('goConnect').addEventListener('click', () => {
  location.hash = '#connection';
});

$('openExtPage').addEventListener('click', () => {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

function kindOf(s: SiteScript): string {
  if (s.js) return 'JS';
  if (s.css) return 'CSS';
  if (s.hideSelectors?.length) return 'hide';
  return '';
}

/** What this rule actually does to a page, verbatim. */
function sourceOf(s: SiteScript): string {
  const parts: string[] = [];
  if (s.hideSelectors?.length) parts.push(`hide:\n${s.hideSelectors.join('\n')}`);
  if (s.css) parts.push(`css:\n${s.css}`);
  if (s.js) parts.push(`js:\n${s.js}`);
  return parts.join('\n\n');
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function renderScripts(scripts: SiteScript[]): void {
  scriptsWarn.hidden = siteScriptsRunnable();
  scriptsCount.textContent = scripts.length ? String(scripts.length) : '';
  navBadge('site-scripts', scripts.length ? String(scripts.length) : '');
  // The guidance does NOT disappear once a script exists. "How do I get another
  // one" has the same answer as "how do I get the first", and the three things
  // it says — what these are, that the AGENT writes them and you approve, how to
  // ask — are exactly what someone forgets between one script and the next. Only
  // the heading tracks the count; below a non-empty list it reads as a footnote.
  scriptsGuideTitle.textContent = scripts.length ? 'Want another one?' : 'No site scripts yet';
  scriptsGuide.classList.toggle('after-list', scripts.length > 0);
  scriptList.textContent = '';

  for (const s of scripts) {
    const row = document.createElement('div');
    row.className = 'srow' + (s.enabled ? '' : ' off');

    const head = document.createElement('div');
    head.className = 'shead';

    const name = document.createElement('span');
    name.className = 'sname';
    name.textContent = s.label;

    const kind = document.createElement('span');
    kind.className = 'skind';
    kind.textContent = kindOf(s);

    const spacer = document.createElement('span');
    spacer.className = 'sspace';

    const src = document.createElement('pre');
    src.className = 'ssrc';
    src.hidden = true;
    src.textContent = sourceOf(s);

    const view = document.createElement('button');
    view.className = 'sghost';
    view.textContent = 'Source';
    view.setAttribute('aria-expanded', 'false');
    view.addEventListener('click', () => {
      src.hidden = !src.hidden;
      view.setAttribute('aria-expanded', String(!src.hidden));
      view.textContent = src.hidden ? 'Source' : 'Hide';
    });

    const toggle = document.createElement('button');
    toggle.className = 'sghost';
    toggle.textContent = s.enabled ? 'Pause' : 'Enable';
    toggle.addEventListener('click', () => {
      void (async () => {
        try {
          await setSiteScriptEnabled(s.id, !s.enabled);
          await refreshSiteScript(s.id);
        } catch {
          /* leave the list to re-render from the store */
        }
        void refreshScripts();
      })();
    });

    const del = document.createElement('button');
    del.className = 'sghost danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (!window.confirm(`Delete "${s.label}"?\nIt will stop running on ${s.matches.join(', ')}.`))
        return;
      void (async () => {
        try {
          await deleteSiteScript(s.id);
          await unregisterSiteScriptById(s.id);
        } catch {
          /* ignore */
        }
        void refreshScripts();
      })();
    });

    head.append(name, kind, spacer, view, toggle, del);

    const matches = document.createElement('div');
    matches.className = 'smatch';
    matches.textContent = s.matches.join('  ');

    const meta = document.createElement('div');
    meta.className = 'smeta';
    const origin =
      s.origin?.type === 'agent'
        ? 'written by your agent'
        : s.origin?.type === 'explore'
          ? 'from an explore session'
          : 'written by hand';
    meta.textContent = `${origin} · added ${WHEN.format(new Date(s.createdAt))}${
      s.enabled ? '' : ' · paused'
    }`;

    row.append(head, matches, meta, src);
    scriptList.append(row);
  }
}

async function refreshScripts(): Promise<void> {
  try {
    renderScripts(await listSiteScripts());
  } catch {
    /* store not ready — reopening retries */
  }
}

// The user flips "Allow user scripts" on ANOTHER tab (chrome://extensions), then
// comes back to this one. Nothing would tell us, so a page that only checked on
// load would still be saying "switched off" after they did what it asked — the
// single most discouraging thing a prerequisite notice can do.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshScripts();
});
window.addEventListener('focus', () => void refreshScripts());

void refreshScripts();
