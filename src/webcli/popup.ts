/**
 * WebCLI toolbar popup — the extension's only UI (no SidePanel, no options page).
 * It has to carry these jobs in 320px: say what this thing IS, show whether it is
 * connected, hand over the ONE setup command, hold the one knob (tool-set
 * profile), and give the user standing control over the site scripts an agent
 * installed (list / pause / delete). Web-app origin access was removed in 0.3.0
 * — that use case lives in the localmd Connect shell now.
 *
 * The setup disclosure is state-driven: OPEN while nothing is connected (that is
 * exactly when the user needs the command) and collapsed once the daemon
 * answers, because after that it is clutter sitting above the state the user
 * opened the popup to check.
 *
 * Site scripts are a shared-base primitive (docs/architecture.md §A.2). WebCLI
 * has no options page, so this popup is the user's standing control — the
 * "user disposes" half of the confirm contract (docs/webcli.md). It reads and
 * mutates the site-script store directly (the popup holds the `userScripts`
 * permission), and re-registers via `refreshSiteScript` so a toggle takes effect
 * without waiting for the SW.
 */

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

const DOC_URL = 'https://github.com/whitefoxx/web-tools#readme';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const dot = $('dot');
const statusText = $('statusText');
const verEl = $('ver');
const docLink = $<HTMLAnchorElement>('docLink');
const setup = $<HTMLDetailsElement>('setup');
const setupHint = $('setupHint');
/** Set once, so a later poll can't re-open a disclosure the user chose to close. */
let setupResolved = false;

verEl.textContent = 'v' + chrome.runtime.getManifest().version;
docLink.href = DOC_URL;

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

// Tool-set profile. This lives in the popup because a knob nobody can reach is
// a dead feature: WebCLI has no options page, so without this the only way to
// set it would be a console command against the service worker — which is not
// something the user this saves tokens for is ever going to do.
const profileSeg = $('profileSeg');
const profileCount = $('profileCount');
const profileDesc = $('profileDesc');
const segButtons = Array.from(profileSeg.querySelectorAll<HTMLButtonElement>('button'));

let profile: ToolProfile = 'full';
/** Last total the SW reported; used to render the count optimistically on a tap
 * instead of waiting for the next poll. */
let lastTotal: number | null = null;

void (async () => {
  try {
    const got = await chrome.storage.local.get([TOOL_PROFILE_KEY]);
    profile = coerceProfile(got[TOOL_PROFILE_KEY]);
  } catch {
    /* storage unavailable — leave it on the default */
  }
  renderProfile();
})();

/** Counts come from the SW's live registry (see WEBCLI_STATUS), so they follow
 * the tool set instead of being a constant here that quietly goes stale. */
function renderProfile(counts?: { advertised: number; total: number }): void {
  for (const b of segButtons) {
    b.setAttribute('aria-pressed', String(b.dataset.profile === profile));
  }
  if (counts) {
    lastTotal = counts.total;
    profileCount.textContent = `${counts.advertised}/${counts.total}`;
  } else if (lastTotal != null) {
    // A tap must move the number NOW. CORE_TOOLS is the same list the SW filters
    // with, so this optimistic value matches what the next poll confirms.
    const advertised = profile === 'core' ? CORE_TOOLS.length : lastTotal;
    profileCount.textContent = `${advertised}/${lastTotal}`;
  }
  profileDesc.textContent =
    profile === 'core'
      ? 'Only the core browse / read / act tools are advertised — a smaller prompt for your agent. The rest stay callable by name.'
      : 'Every tool is advertised to your agent. Switch to Core for a smaller agent prompt.';
}

for (const b of segButtons) {
  b.addEventListener('click', () => {
    const next = coerceProfile(b.dataset.profile);
    if (next === profile) return;
    profile = next;
    renderProfile(); // optimistic: buttons + count move on the tap
    void chrome.storage.local.set({ [TOOL_PROFILE_KEY]: next });
    poll(); // and confirm against the SW's registry right away, not in 2s
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
  if (typeof s?.toolsTotal === 'number' && typeof s.toolsAdvertised === 'number') {
    renderProfile({ advertised: s.toolsAdvertised, total: s.toolsTotal });
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

// ── Site scripts: the user's standing control (list / pause / delete) ──
const scriptsCount = document.getElementById('scriptsCount') as HTMLElement;
const scriptsWarn = document.getElementById('scriptsWarn') as HTMLElement;
const scriptList = document.getElementById('scriptList') as HTMLElement;
const scriptsEmpty = document.getElementById('scriptsEmpty') as HTMLElement;

function badge(s: SiteScript): string {
  if (s.js) return 'JS';
  if (s.css) return 'CSS';
  if (s.hideSelectors?.length) return 'hide';
  return '';
}

function renderScripts(scripts: SiteScript[]): void {
  scriptsWarn.hidden = siteScriptsRunnable();
  scriptsCount.textContent = scripts.length ? String(scripts.length) : '';
  scriptsEmpty.hidden = scripts.length > 0;
  scriptList.textContent = '';
  for (const s of scripts) {
    const row = document.createElement('div');
    row.className = 'srow';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = s.enabled;
    toggle.title = s.enabled ? 'Enabled — click to pause' : 'Paused — click to enable';
    toggle.addEventListener('change', () => {
      void (async () => {
        try {
          await setSiteScriptEnabled(s.id, toggle.checked);
          await refreshSiteScript(s.id);
        } catch {
          /* revert view on failure */
        }
        void refreshScripts();
      })();
    });

    const name = document.createElement('span');
    name.className = 'sname' + (s.enabled ? '' : ' off');
    name.textContent = s.label;
    name.title = `${s.label}\n${s.matches.join('\n')}`;

    const kind = document.createElement('span');
    kind.className = 'count';
    kind.textContent = badge(s);

    const del = document.createElement('button');
    del.className = 'sdel';
    del.textContent = '🗑';
    del.title = `Delete "${s.label}"`;
    del.addEventListener('click', () => {
      if (!window.confirm(`Delete "${s.label}"?\nIt will stop running on ${s.matches.join(', ')}.`)) return;
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

    row.append(toggle, name, kind, del);
    scriptList.append(row);
  }
}

async function refreshScripts(): Promise<void> {
  try {
    renderScripts(await listSiteScripts());
  } catch {
    /* store not ready — next open retries */
  }
}

void refreshScripts();
