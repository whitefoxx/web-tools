// @vitest-environment jsdom
/**
 * WebCLI's settings page, actually running.
 *
 * The same guard localmd Connect's options test exists for, and for the same
 * reason: the tool-set knob and the site-script list were MOVED here out of a
 * 320px popup, and a moved block that lost an element id dies on load — taking
 * every listener after it with it and leaving a page that looks right and does
 * nothing. Type-checking cannot see an id that only exists in HTML.
 *
 * It also pins the one behaviour the design turns on: switching to Core DIMS
 * the rows it stops advertising instead of removing them. "Hidden is not
 * disabled" is the profile contract (core/tool-profile.ts); a list that deleted
 * the row would teach the user the opposite.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sent: Array<{ type: string }> = [];
const created: string[] = [];
const enabledCalls: Array<{ id: string; on: boolean }> = [];
const deleted: string[] = [];
const store: Record<string, unknown> = {};

const SCRIPTS = [
  {
    id: 'ss_1',
    label: 'zhihu — hide the login wall',
    matches: ['https://*.zhihu.com/*'],
    hideSelectors: ['.signin-modal', '.mask'],
    runAt: 'document_end' as const,
    enabled: true,
    origin: { type: 'agent' as const },
    createdAt: Date.UTC(2026, 0, 15),
    updatedAt: Date.UTC(2026, 0, 15),
  },
  {
    id: 'ss_2',
    label: 'example — restyle',
    matches: ['https://example.test/*'],
    css: 'body { font-size: 18px }',
    runAt: 'document_idle' as const,
    enabled: false,
    origin: { type: 'manual' as const },
    createdAt: Date.UTC(2026, 1, 2),
    updatedAt: Date.UTC(2026, 1, 2),
  },
];

/** IndexedDB does not exist in jsdom, so the real store would answer [] and the
 *  list assertions would pass vacuously. Mock the seam, not the database. */
vi.mock('../src/site-scripts/store', () => ({
  listSiteScripts: async () => SCRIPTS,
  setSiteScriptEnabled: async (id: string, on: boolean) => {
    enabledCalls.push({ id, on });
  },
  deleteSiteScript: async (id: string) => {
    deleted.push(id);
  },
}));
/** Chrome's "Allow user scripts" switch, as the page sees it. Mutable, because
 *  the user flips it in ANOTHER tab and the page has to notice on return. */
let runnable = true;
vi.mock('../src/site-scripts/register', () => ({
  refreshSiteScript: async () => {},
  unregisterSiteScriptById: async () => {},
  siteScriptsRunnable: () => runnable,
}));

const TOOLS = [
  {
    id: 'generic__open_url',
    name: 'open_url',
    description: 'Open a URL. More text.',
    core: true,
    args: [
      { name: 'url', type: 'string', help: 'The URL to open.', required: true },
      { name: 'active', type: 'boolean', help: 'Focus the tab.', required: false },
    ],
  },
  { id: 'generic__click', name: 'click', description: 'Click an element.', core: true, args: [] },
  {
    id: 'generic__get_a11y_tree',
    name: 'get_a11y_tree',
    description: 'Read the tree.',
    core: false,
    args: [],
  },
  {
    id: 'generic__eval_js',
    name: 'eval_js',
    description: 'Run JavaScript.',
    core: false,
    args: [],
  },
];

let connected = false;
/** The real SW recomputes `toolsAdvertised` from the live registry AND the
 *  stored profile on every status poll — a stub that always answers "all of
 *  them" would let a broken count pass. */
const statusNow = (): Record<string, unknown> => ({
  connected,
  enabled: true,
  port: 9376,
  profile: store.toolProfile ?? 'full',
  toolsTotal: TOOLS.length,
  toolsAdvertised: store.toolProfile === 'core' ? TOOLS.filter((t) => t.core).length : TOOLS.length,
});

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'src/webcli/options.html'), 'utf8');
  document.documentElement.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-ext',
      lastError: undefined,
      getManifest: () => ({ version: '9.9.9' }),
      getURL: (path: string) => `chrome-extension://test-ext/${path}`,
      sendMessage: (msg: { type: string }, cb?: (r: unknown) => void) => {
        sent.push(msg);
        if (!cb) return;
        if (msg.type === 'WEBCLI_STATUS') cb(statusNow());
        else if (msg.type === 'WEBCLI_TOOLS') cb({ profile: 'full', tools: TOOLS });
        else cb(undefined);
      },
    },
    tabs: {
      create: async (opts: { url?: string }) => {
        created.push(opts?.url ?? '');
        return {};
      },
    },
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
      },
    },
  });
  await import('../src/webcli/options');
  await new Promise((r) => setTimeout(r, 0));
});

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const rows = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];

describe('WebCLI settings — the page loads and wires up', () => {
  it('finds every element its script reaches for', () => {
    for (const id of [
      'nav',
      'main',
      'ver',
      'docLink',
      'brandMark',
      'dot',
      'statusText',
      'portText',
      'setupHint',
      'daemonWhy',
      'cmdSkill',
      'cmdDaemon',
      'profileSeg',
      'profileCount',
      'profileDesc',
      'toolCount',
      'toolList',
      'toolsEmpty',
      'scriptsCount',
      'scriptsWarn',
      'scriptList',
      'scriptsGuide',
      'scriptsGuideTitle',
      'scriptsNoAgent',
      'goConnect',
      'openExtPage',
      'ghLink',
      'ghIco',
      'cmdExample',
    ]) {
      expect($(id), `#${id} missing from options.html`).toBeTruthy();
    }
  });

  it('puts the repository where it can be seen, not in a grey footnote', () => {
    expect($('ghLink').getAttribute('href')).toBe('https://github.com/whitefoxx/web-tools');
    expect($('ghIco').innerHTML).toContain('<svg');
    expect($('docLink').getAttribute('href')).toBe('https://github.com/whitefoxx/web-tools#readme');
  });

  it('builds the nav from the sections, one entry each', () => {
    // The label span, not the button: a nav item also carries a count badge.
    const labels = rows('#nav .nav-item').map((b) => b.querySelectorAll('span')[1]?.textContent);
    expect(labels).toEqual(['Connection', 'Tools', 'Site scripts']);
    // Every nav entry names a section that exists, and vice versa.
    const navIds = rows('#nav .nav-item').map((b) => b.dataset.section);
    const sectionIds = rows('main section[data-nav]').map((s) => s.id);
    expect(navIds).toEqual(sectionIds);
  });

  it('shows exactly one section, and the hash chooses it', async () => {
    const shown = (): string[] =>
      rows('main section')
        .filter((s) => !s.hidden)
        .map((s) => s.id);
    expect(shown()).toEqual(['connection']); // no hash → the first

    location.hash = '#site-scripts';
    window.dispatchEvent(new Event('hashchange'));
    expect(shown()).toEqual(['site-scripts']);
    expect($('nav').querySelector('.nav-item.on')?.textContent).toContain('Site scripts');

    location.hash = '#tools';
    window.dispatchEvent(new Event('hashchange'));
    expect(shown()).toEqual(['tools']);
  });
});

describe('the tool catalog', () => {
  it('lists every tool the service worker reported', () => {
    expect(rows('#toolList .titem').map((r) => r.querySelector('.tname')?.textContent)).toEqual([
      'open_url',
      'click',
      'get_a11y_tree',
      'eval_js',
    ]);
    expect($('toolCount').textContent).toBe('4');
    expect($('toolsEmpty').hidden).toBe(true);
  });

  it('shows one sentence per row, and the whole thing when the row is opened', () => {
    const item = rows('#toolList .titem')[0];
    expect(item.querySelector('.tdesc')?.textContent).toBe('Open a URL.');
    expect(item.querySelector('.tmore')).toBeNull(); // built on first open, not up front

    item.querySelector<HTMLButtonElement>('.trow')!.click();
    const more = item.querySelector<HTMLElement>('.tmore')!;
    expect(more.hidden).toBe(false);
    expect(more.querySelector('.full')?.textContent).toBe('Open a URL. More text.');
    expect(item.classList.contains('open')).toBe(true);
    expect(item.querySelector('.trow')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('an opened row lists every argument with its type, and flags the required ones', () => {
    const item = rows('#toolList .titem')[0];
    const args = [...item.querySelectorAll<HTMLElement>('.targ')];
    expect(args.map((a) => a.querySelector('.targ-name')?.textContent)).toEqual(['url', 'active']);
    expect(args[0].querySelector('.targ-type')?.textContent).toBe('string');
    expect(args[0].querySelector('.targ-req')?.textContent).toBe('required');
    expect(args[1].querySelector('.targ-req')).toBeNull();
    expect(args[0].querySelector('.targ-help')?.textContent).toBe('The URL to open.');
  });

  it('says so when a tool takes no arguments, rather than showing an empty panel', () => {
    const item = rows('#toolList .titem')[1];
    item.querySelector<HTMLButtonElement>('.trow')!.click();
    expect(item.querySelector('.tnoargs')?.textContent).toBe('Takes no arguments.');
  });

  it('Core dims the tools it stops advertising — it does not remove them', async () => {
    const core = document.querySelector<HTMLButtonElement>(
      '#profileSeg button[data-profile="core"]',
    )!;
    core.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(rows('#toolList .titem')).toHaveLength(4); // still all four
    const off = rows('#toolList .titem.off').map((r) => r.querySelector('.tname')?.textContent);
    expect(off).toEqual(['get_a11y_tree', 'eval_js']);
    expect($('profileCount').textContent).toBe('2 of 4 advertised');
    expect(store.toolProfile).toBe('core');
  });
});

describe('site scripts', () => {
  it('renders a row per script, with its matches and what wrote it', () => {
    const list = rows('#scriptList .srow');
    expect(list).toHaveLength(2);
    expect(list[0].querySelector('.sname')?.textContent).toBe('zhihu — hide the login wall');
    expect(list[0].querySelector('.skind')?.textContent).toBe('hide');
    expect(list[0].querySelector('.smatch')?.textContent).toContain('https://*.zhihu.com/*');
    expect(list[0].querySelector('.smeta')?.textContent).toContain('written by your agent');
    // A paused script says so, in the row and in its styling.
    expect(list[1].classList.contains('off')).toBe(true);
    expect(list[1].querySelector('.smeta')?.textContent).toContain('paused');
    expect($('scriptsCount').textContent).toBe('2');
  });

  it('keeps the source readable — hidden until asked, then verbatim', () => {
    const row = rows('#scriptList .srow')[0];
    const src = row.querySelector<HTMLElement>('.ssrc')!;
    const btn = [...row.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Source',
    )!;
    expect(src.hidden).toBe(true);
    btn.click();
    expect(src.hidden).toBe(false);
    expect(src.textContent).toContain('.signin-modal');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('Pause goes to the store, with the script id and the flipped state', async () => {
    const row = rows('#scriptList .srow')[0];
    const pause = [...row.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Pause',
    )!;
    pause.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(enabledCalls).toContainEqual({ id: 'ss_1', on: false });
  });

  it('keeps teaching the feature after the first script exists', () => {
    // The guidance used to vanish the moment a script landed. It is the same
    // answer to "how do I get another one", and it is what someone forgets
    // between one script and the next — so it stays, as a footnote under the
    // list, and only the heading tracks the count.
    const guide = $('scriptsGuide');
    expect(guide.hidden).toBe(false);
    expect($('scriptsGuideTitle').textContent).toBe('Want another one?');
    expect(guide.classList.contains('after-list')).toBe(true);
    // All three things it has to say are still on the page.
    const said = guide.textContent ?? '';
    expect(said).toContain('your agent does, and you approve');
    expect(said).toContain('pause or delete');
    expect($('cmdExample').textContent).toContain('Hide the cookie banner');
  });

  it('marks the copyable line as an example, so it is not pasted verbatim', () => {
    // It carries a placeholder host. A line with a Copy button beside it reads
    // as something to paste as-is, so the label has to be next to the button.
    const label = document.querySelector('#scriptsGuide .ex-label')!;
    expect(label.textContent).toContain('For example');
    expect(label.querySelector('code')?.textContent).toBe('example.com');
  });

  it('says so when no agent is connected — the card tells you to ask one', () => {
    // The status poll answered "not connected" (see the connection tests), so
    // the prerequisite for everything this card describes is not met.
    expect($('scriptsNoAgent').hidden).toBe(false);
    $('goConnect').click();
    expect(location.hash).toBe('#connection');
  });

  it('points at the extension page for the user-scripts switch', () => {
    $('openExtPage').click();
    expect(created.at(-1)).toBe('chrome://extensions/?id=test-ext');
  });

  it('explains WHY the Chrome switch is needed, and the steps — not just its name', async () => {
    runnable = false;
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 0));

    const warn = $('scriptsWarn');
    expect(warn.hidden).toBe(false);
    const said = warn.textContent ?? '';
    expect(said).toContain('written by your agent, not shipped inside WebCLI');
    expect(said).toContain('saved but inert');
    expect(said).toContain('Allow user scripts');
    expect(said).toContain('Every other tool works without it');
  });

  it('stops warning as soon as the user comes back with the switch on', async () => {
    // The page cannot be told when that switch flips — it happens on
    // chrome://extensions. Re-checking on return is the whole mechanism, and a
    // notice that survives the user doing what it asked is the worst outcome.
    runnable = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 0));
    expect($('scriptsWarn').hidden).toBe(true);
  });
});

describe('the connection section', () => {
  it('reports the daemon state and repeats it as a dot in the nav', async () => {
    expect($('statusText').textContent).toBe('Not connected');
    expect($('portText').textContent).toBe('port 9376');
    expect($('dot').classList.contains('on')).toBe(false);
    expect(document.querySelector('.nav-item .live')?.classList.contains('on')).toBe(false);

    connected = true;
    await new Promise((r) => setTimeout(r, 2100));
    expect($('statusText').textContent).toBe('Connected');
    expect($('dot').classList.contains('on')).toBe(true);
    expect(document.querySelector('.nav-item .live')?.classList.contains('on')).toBe(true);
    // ...and the site-script card stops warning that there is nobody to ask.
    expect($('scriptsNoAgent').hidden).toBe(true);
  }, 6000);
});
