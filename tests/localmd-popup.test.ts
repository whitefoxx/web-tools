// @vitest-environment jsdom
/**
 * The popup, actually running.
 *
 * It shipped twice with buttons that did nothing, and both times the check that
 * missed it looked at the LAYOUT — a screenshot of the page served over http,
 * where `chrome` does not exist and the script dies on its first line. A
 * picture of a popup proves nothing about a popup.
 *
 * So this loads the real popup.html into jsdom, stubs the chrome surface the
 * script uses, imports the script, and clicks things. What it guards is the one
 * failure that is invisible from the outside: a click that goes nowhere.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Sent {
  msg: { type: string; action?: string; tabId?: number };
  cb?: (r: unknown) => void;
}

const sent: Sent[] = [];
let pageState: Record<string, unknown> = {
  url: 'https://ex.test/a',
  title: 'A page',
  capturable: true,
  entry: null,
  highlights: 2,
  marks: [
    { id: 'h1', exact: 'the first passage', color: 'green', note: 'why it mattered' },
    { id: 'h2', exact: 'the second passage' },
  ],
  pending: 0,
};
const messaged: Array<{ tabId: number; type?: string; id?: string }> = [];
const queryTabs: Array<{ id?: number; url?: string }> = [{ id: 42, url: 'https://ex.test/a' }];
const kbState: { folders: string[]; current: string | null } = {
  folders: ['trace', 'notes'],
  current: 'trace',
};
const created: string[] = [];
const closed = { count: 0 };

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'src/localmd-connect/popup.html'), 'utf8');
  document.documentElement.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-ext',
      lastError: undefined,
      getManifest: () => ({
        version: '9.9.9',
        options_ui: { page: 'src/localmd-connect/options.html' },
      }),
      getURL: (path: string) => `chrome-extension://test-ext/${path}`,
      openOptionsPage: () => {},
      sendMessage: (msg: Sent['msg'], cb?: (r: unknown) => void) => {
        sent.push({ msg, cb });
        if (!cb) return;
        // Answer the way the worker does, on a later task like a real one.
        setTimeout(() => {
          if (msg.type === 'LOCALMD_PAGE_STATE') cb(pageState);
          else if (msg.type === 'LOCALMD_CAPTURE') cb({ ok: true, id: 'ib_1' });
          else if (msg.type === 'LOCALMD_STATUS') cb({ siteScriptsRunnable: true, toolsTotal: 55 });
          else if (msg.type === 'LOCALMD_KB_STATE') cb(kbState);
          else if (msg.type === 'LOCALMD_OPEN_KB') cb({ ok: true, reached: 1 });
          else if (msg.type === 'LOCALMD_OPEN_APP') cb({ ok: true, opened: false });
          else if (msg.type === 'GET_PAGE_TOOLS')
            cb({ settings: { enabled: true, blacklist: [], defaultColor: 'yellow' } });
          else if (msg.type === 'LIST_SITE_SCRIPTS') cb({ scripts: [], runnable: true });
          else cb(undefined);
        }, 0);
      },
    },
    tabs: {
      sendMessage: (
        tabId: number,
        msg: { type?: string; id?: string },
        cb?: (r: unknown) => void,
      ) => {
        messaged.push({ tabId, ...msg });
        cb?.(undefined);
      },
      query: async () => queryTabs,
      create: async (opts: { url?: string }) => {
        created.push(opts?.url ?? '');
        return {};
      },
    },
    permissions: { contains: (_p: unknown, cb: (b: boolean) => void) => cb(false) },
    permissions: { contains: (_p: unknown, cb: (b: boolean) => void) => cb(false) },
    storage: { onChanged: { addListener: () => {} } },
  });
  vi.stubGlobal('close', () => closed.count++);
  window.close = () => closed.count++;

  await import('../src/localmd-connect/popup');
  await tick();
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const btn = (id: string): HTMLButtonElement => $(id) as HTMLButtonElement;
const captureMsgs = (): Sent[] => sent.filter((s) => s.msg.type === 'LOCALMD_CAPTURE');

describe('the popup wires up at all', () => {
  it('finds every element the script reaches for', () => {
    // A missing id is a null deref that kills the module, and every listener
    // after it — the whole popup goes dead without a visible error.
    for (const id of [
      'pageTitle',
      'pageHost',
      'pageStatus',
      'pageState',
      'actionNote',
      'clipPage',
      'shotRegion',
      'shotPage',
      'askPage',
      'icoClip',
      'icoRegion',
      'icoFull',
      'icoAsk',
      'openOptions',
      'openApp',
      'openMarks',
      'kbCurrent',
      'kbName',
      'kbList',
      'icoFolder',
      'icoCaret',
      'icoMarks',
      'dot',
      'statusText',
      'ver',
      'userScriptsWarn',
      'openSettings',
    ]) {
      expect($(id), `#${id} missing from popup.html`).toBeTruthy();
    }
  });

  it('asks for the page state with the tab it belongs to', () => {
    const q = sent.find((s) => s.msg.type === 'LOCALMD_PAGE_STATE');
    expect(q).toBeTruthy();
    // Resolved HERE, not in the worker: the worker's lastFocusedWindow can be
    // the popup itself, and then it decides there is no page.
    expect(q!.msg.tabId).toBe(42);
  });

  it('says whether the folder has this page on the host line', () => {
    expect($('pageStatus').textContent).toContain('Not saved yet');
    expect($('pageState').textContent).not.toContain('Not saved yet');
  });

  it('renders what the page is and what the folder knows about it', () => {
    expect($('pageTitle').textContent).toBe('A page');
    expect($('pageHost').textContent).toBe('ex.test');
    expect($('pageStatus').textContent).toContain('Not saved yet');
    expect($('pageState').textContent).toContain('2 highlights');
  });

  it('paints its icons — an empty button is a button nobody presses', () => {
    for (const id of ['icoClip', 'icoRegion', 'icoFull', 'icoAsk', 'openOptions']) {
      expect($(id).querySelector('svg'), `#${id} has no icon`).toBeTruthy();
    }
  });
});

describe('a click actually goes somewhere', () => {
  it('every capture button sends its action, with the tab id', async () => {
    for (const [id, action] of [
      ['clipPage', 'clip_page'],
      ['shotRegion', 'screenshot_region'],
      ['shotPage', 'screenshot_page'],
      ['askPage', 'ask_page'],
    ] as const) {
      const before = captureMsgs().length;
      btn(id).click();
      await tick();
      const msgs = captureMsgs();
      expect(msgs.length, `#${id} sent nothing`).toBe(before + 1);
      expect(msgs[msgs.length - 1].msg).toMatchObject({ action, tabId: 42 });
      await tick();
    }
  });

  it('closes itself at once for the two that need the page, and not otherwise', async () => {
    const was = closed.count;
    btn('shotRegion').click();
    await tick();
    expect(closed.count, 'a region capture must get out of the way').toBe(was + 1);
    btn('clipPage').click();
    await tick();
    await tick();
    expect(closed.count, 'a clip keeps the popup open to report').toBe(was + 1);
  });
});

describe('which knowledge base this is about', () => {
  it('names the open folder rather than leaving the question unanswered', () => {
    expect($('kbName').textContent).toBe('trace');
  });

  it('offers the others, marking the one that is open', () => {
    const items = [...$('kbList').querySelectorAll('.kb-item')];
    expect(items.map((i) => i.textContent)).toEqual(['trace', 'notes']);
    expect(items.filter((i) => i.classList.contains('on')).map((i) => i.textContent)).toEqual([
      'trace',
    ]);
  });

  it('the list is collapsed until asked for', () => {
    const list = $('kbList') as HTMLUListElement;
    expect(list.hidden).toBe(true);
    btn('kbCurrent').click();
    expect(list.hidden).toBe(false);
    expect(btn('kbCurrent').getAttribute('aria-expanded')).toBe('true');
    btn('kbCurrent').click();
    expect(list.hidden).toBe(true);
  });

  it('the menu floats rather than pushing the buttons down', () => {
    // A picker that moved the page would move the button the user is about to
    // press, and this popup has no room to grow.
    const css = readFileSync(resolve(process.cwd(), 'src/localmd-connect/popup.html'), 'utf8');
    const rule = /\.kb-list \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/position:\s*absolute/);
    expect(/\.kb \{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/position:\s*relative/);
  });

  it('asks localmd to switch — it cannot open a folder itself', async () => {
    sent.length = 0;
    btn('kbCurrent').click();
    ($('kbList').querySelectorAll('.kb-item')[1] as HTMLButtonElement).click();
    const ask = sent.find((s) => s.msg.type === 'LOCALMD_OPEN_KB');
    expect(ask?.msg).toMatchObject({ name: 'notes' });
    await tick();
  });

  it('stays on this page instead of jumping to localmd', async () => {
    // Switching happens on the way to capturing THIS page; being thrown into
    // another tab loses it.
    sent.length = 0;
    created.length = 0;
    const before = closed.count;
    btn('kbCurrent').click();
    ($('kbList').querySelectorAll('.kb-item')[1] as HTMLButtonElement).click();
    await tick();
    expect(sent.find((s) => s.msg.type === 'LOCALMD_OPEN_APP')).toBeUndefined();
    expect(created).toEqual([]);
    expect(closed.count).toBe(before);
  });

  it('closes the menu on a pick, and on a click anywhere else', () => {
    const list = $('kbList') as HTMLUListElement;
    btn('kbCurrent').click();
    expect(list.hidden).toBe(false);
    ($('kbList').querySelectorAll('.kb-item')[1] as HTMLButtonElement).click();
    expect(list.hidden).toBe(true);
    btn('kbCurrent').click();
    expect(list.hidden).toBe(false);
    document.body.click();
    expect(list.hidden).toBe(true);
  });

  it('does not ask to switch to the folder that is already open', () => {
    sent.length = 0;
    btn('kbCurrent').click();
    ($('kbList').querySelectorAll('.kb-item')[0] as HTMLButtonElement).click();
    expect(sent.find((s) => s.msg.type === 'LOCALMD_OPEN_KB')).toBeUndefined();
  });
});

describe('the ways out of the popup', () => {
  it('hands "open localmd" to the worker, which knows the origins', async () => {
    sent.length = 0;
    btn('openApp').click();
    expect(sent.find((s) => s.msg.type === 'LOCALMD_OPEN_APP')).toBeTruthy();
    await tick();
  });

  it('opens the annotations list in a tab — a popup dies on the next click', () => {
    created.length = 0;
    btn('openMarks').click();
    // The path comes from the MANIFEST. The bundler emits these pages at their
    // source path, so a hand-written 'options.html' is a URL that has never
    // existed — and it fails as a blank tab with nothing in any console.
    expect(created[0]).toBe(
      'chrome-extension://test-ext/src/localmd-connect/options.html#annotations',
    );
  });

  it('the highlight count opens the passages themselves', () => {
    document.body.click(); // known state: everything closed
    const chip = $('pageState').querySelector('button.chip.marks') as HTMLButtonElement;
    expect(chip, 'the highlight chip should be clickable').toBeTruthy();
    const menu = $('pageState').querySelector('.mark-menu') as HTMLElement;
    expect(menu.hidden).toBe(true);
    chip.click();
    expect(menu.hidden).toBe(false);
    expect(menu.textContent).toContain('the first passage');
    expect(menu.textContent).toContain('why it mattered');
    expect((menu.querySelector('.mark-dot') as HTMLElement).style.background).toBe(
      'rgb(126, 214, 126)',
    );
  });

  it('a passage scrolls THIS page to it, rather than opening another one', async () => {
    document.body.click(); // known state: everything closed
    messaged.length = 0;
    created.length = 0;
    ($('pageState').querySelector('button.chip.marks') as HTMLButtonElement).click();
    ($('pageState').querySelectorAll('.mark-row')[1] as HTMLButtonElement).click();
    await tick();
    expect(messaged[0]).toMatchObject({ tabId: 42, type: 'LOCALMD_FOCUS_HIGHLIGHT', id: 'h2' });
    expect(created).toEqual([]);
  });

  it('still offers the full list, one row down', () => {
    document.body.click(); // known state: everything closed
    created.length = 0;
    ($('pageState').querySelector('button.chip.marks') as HTMLButtonElement).click();
    ($('pageState').querySelector('.mark-all') as HTMLButtonElement).click();
    expect(created[0]).toContain('page=' + encodeURIComponent('https://ex.test/a'));
  });

  it('only one menu is open at a time', () => {
    document.body.click(); // known state: everything closed
    ($('pageState').querySelector('button.chip.marks') as HTMLButtonElement).click();
    const menu = $('pageState').querySelector('.mark-menu') as HTMLElement;
    expect(menu.hidden).toBe(false);
    btn('kbCurrent').click();
    expect(menu.hidden, 'opening the folder picker closes the passages').toBe(true);
    expect(($('kbList') as HTMLUListElement).hidden).toBe(false);
    document.body.click();
  });
});

describe('what it does when it cannot tell what the page is', () => {
  it('leaves the buttons usable rather than going silently dead', async () => {
    // The bug this pins: an unknown URL disabled everything, so the popup
    // looked fine and answered no click.
    pageState = { url: '', title: '', capturable: false, entry: null, highlights: 0, pending: 0 };
    // Any action refreshes the state afterwards; then check the buttons.
    btn('clipPage').click();
    await tick();
    await tick();
    await tick();
    expect(btn('clipPage').disabled, 'unknown page must not disable the button').toBe(false);
  });

  it('disables page actions only when the page is KNOWN not to be one', async () => {
    pageState = {
      url: 'chrome://extensions',
      title: 'Extensions',
      capturable: false,
      entry: null,
      highlights: 0,
      pending: 0,
    };
    btn('clipPage').click(); // any action refreshes the state afterwards
    await tick();
    await tick();
    await tick();
    expect(btn('clipPage').disabled).toBe(true);
    expect($('pageStatus').textContent).toContain('Not a web page');
  });
});
