/**
 * WebCLI's toolbar popup — the quick thing, and the way to the rest.
 *
 * It used to be the entire UI, carrying five jobs in 320px: what this thing IS,
 * whether it is connected, the setup command, the tool-set knob, and the
 * standing control over every site script an agent installed. The last two
 * outgrew the space — a list of persistent rules running on your pages is read
 * carefully (what does it match, what does it do, when did it appear), and
 * 320px fits a name and a checkbox. They live on the settings page now
 * (options.html); this popup keeps the state you open it to check, and shows
 * each of their counts so the trip is only needed when you want to act.
 *
 * The setup disclosure is state-driven: OPEN while nothing is connected (that is
 * exactly when the user needs the command) and collapsed once the daemon
 * answers, because after that it is clutter sitting above the state the user
 * opened the popup to check.
 */

import { ICON_GITHUB, ICON_SETTINGS } from '../ui/icons';
import {
  CORE_TOOLS,
  coerceProfile,
  TOOL_PROFILE_KEY,
  type ToolProfile,
} from '../core/tool-profile';
import { listSiteScripts } from '../site-scripts/store';

const REPO_URL = 'https://github.com/whitefoxx/web-tools';
const DOC_URL = `${REPO_URL}#readme`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const dot = $('dot');
const statusText = $('statusText');
const setup = $<HTMLDetailsElement>('setup');
const setupHint = $('setupHint');
const profileCount = $('profileCount');
const scriptsCount = $('scriptsCount');
/** Set once, so a later poll can't re-open a disclosure the user chose to close. */
let setupResolved = false;

$('ver').textContent = 'v' + chrome.runtime.getManifest().version;
$<HTMLAnchorElement>('docLink').href = DOC_URL;
$<HTMLAnchorElement>('ghLink').href = REPO_URL;
$('ghIco').innerHTML = ICON_GITHUB(14);
$('openOptions').innerHTML = ICON_SETTINGS;

/**
 * The settings page, at the section the row is about.
 *
 * The path comes from the MANIFEST, never spelled out here: the bundler emits
 * the page at its source path (`src/webcli/options.html`), so a hand-written
 * `options.html` is a URL that has never existed — and it fails as a blank tab
 * with no error anywhere. (The same trap localmd Connect documents in its
 * popup; this shell's page is new, so it is worth naming twice.)
 */
function openSettings(section?: string): void {
  const page = chrome.runtime.getManifest().options_ui?.page;
  if (!page) {
    chrome.runtime.openOptionsPage(); // no section, but it opens
    window.close();
    return;
  }
  void chrome.tabs.create({ url: chrome.runtime.getURL(page + (section ? `#${section}` : '')) });
  window.close();
}

$('openOptions').addEventListener('click', () => openSettings());
for (const b of document.querySelectorAll<HTMLButtonElement>('button.jump[data-go]')) {
  b.addEventListener('click', () => openSettings(b.dataset.go));
}

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

interface Status {
  connected: boolean;
  enabled: boolean;
  port: number;
  profile?: string;
  toolsTotal?: number;
  toolsAdvertised?: number;
}

function render(s: Status | null): void {
  const connected = !!s?.connected;
  dot.classList.toggle('on', connected);
  if (s && !s.enabled) {
    statusText.textContent = 'Disabled';
  } else if (connected) {
    statusText.textContent = `Connected to daemon (port ${s?.port ?? '?'})`;
  } else {
    statusText.textContent = `Not connected to daemon (port ${s?.port ?? '?'})`;
  }
  // Counts come from the SW's live registry (see WEBCLI_STATUS), so they follow
  // the tool set instead of being a constant here that quietly goes stale.
  if (typeof s?.toolsTotal === 'number' && typeof s.toolsAdvertised === 'number') {
    profileCount.textContent = `${s.toolsAdvertised}/${s.toolsTotal}`;
  }
  // First answer from the SW decides the disclosure — after that, leave it to the
  // user. Re-deciding on every 2s poll would slam it shut mid-copy.
  if (s && !setupResolved) {
    setupResolved = true;
    setup.open = !connected;
  }
  // Only shown while there is something left to explain. Connected ⇒ empty, and
  // `.step:empty` collapses the row — the dot already says "connected", so a
  // second line saying it is noise.
  setupHint.textContent = connected
    ? ''
    : 'The skill starts the local bridge for you; this turns green once it does.';
}

function poll(): void {
  try {
    chrome.runtime.sendMessage({ type: 'WEBCLI_STATUS' }, (resp?: Status) => {
      void chrome.runtime.lastError; // SW may be waking — ignore, next tick retries
      render(resp ?? null);
    });
  } catch {
    render(null);
  }
}

poll();
const timer = setInterval(poll, 2000);
window.addEventListener('unload', () => clearInterval(timer));

// The profile decides what the Tools count means, and the SW may not answer at
// all (asleep, or mid-restart) — so read it here too rather than leaving the
// row on its placeholder.
void (async () => {
  try {
    const got = await chrome.storage.local.get([TOOL_PROFILE_KEY]);
    const profile: ToolProfile = coerceProfile(got[TOOL_PROFILE_KEY]);
    if (profileCount.textContent === '…') {
      profileCount.textContent = profile === 'core' ? `${CORE_TOOLS.length}/…` : '…';
    }
  } catch {
    /* storage unavailable — the poll fills it in */
  }
})();

// Site scripts are read straight from the store: the popup only reports how
// many there are, and the page that lists, pauses and deletes them is one tap
// away.
void (async () => {
  try {
    scriptsCount.textContent = String((await listSiteScripts()).length);
  } catch {
    scriptsCount.textContent = '0';
  }
})();
