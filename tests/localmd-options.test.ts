// @vitest-environment jsdom
/**
 * The settings page, actually running — the same guard as the popup's test and
 * for the same reason: the settings moved out of the popup wholesale, and a
 * moved block that lost an element id dies on load, taking every listener after
 * it with it and leaving a page that looks right and does nothing.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sent: Array<{ type: string }> = [];
/** chrome.storage.onChanged subscribers, so a test can be another tab. */
const storageListeners: Array<(c: Record<string, unknown>, area: string) => void> = [];
const fireStorage = (changes: Record<string, unknown>): void => {
  for (const fn of storageListeners) fn(changes, 'local');
};
const created: string[] = [];
const messaged: Array<{ tabId: number; type: string; id?: string }> = [];
const openTabs: Array<{ id: number; url: string; windowId: number }> = [];

/** Two pages of highlights, one of them with a note. */
const store: Record<string, unknown> = {
  'selHl:https://ex.test/a': [
    {
      id: 'h1',
      ts: Date.now() - 3600_000,
      exact: 'the passage itself',
      prefix: '',
      suffix: '',
      title: 'A page',
      color: 'green',
      note: 'why it mattered',
    },
  ],
  'selHl:https://other.test/b': [
    { id: 'h2', ts: Date.now() - 60_000, exact: 'another quote', prefix: '', suffix: '' },
  ],
};

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'src/localmd-connect/options.html'), 'utf8');
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
        setTimeout(() => {
          if (msg.type === 'GET_PAGE_TOOLS')
            cb({ settings: { enabled: true, blacklist: ['x.test'], defaultColor: 'yellow' } });
          else if (msg.type === 'LIST_SITE_SCRIPTS') cb({ scripts: [], runnable: true });
          else if (msg.type === 'LOCALMD_STATUS') cb({ siteScriptsRunnable: false, dev: false });
          else cb(undefined);
        }, 0);
      },
    },
    tabs: {
      create: async (opts: { url?: string }) => {
        created.push(opts?.url ?? '');
        return {};
      },
      query: async () => openTabs,
      update: async () => ({}),
      sendMessage: async (id: number, msg: { type: string; id?: string }) => {
        messaged.push({ tabId: id, ...msg });
      },
    },
    windows: { update: async () => ({}) },
    permissions: { contains: (_p: unknown, cb: (b: boolean) => void) => cb(true) },
    storage: {
      onChanged: {
        addListener: (fn: (c: Record<string, unknown>, area: string) => void) =>
          storageListeners.push(fn),
      },
      local: {
        get: async (keys: string | string[] | null) => {
          if (keys === null) return { ...store };
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        getKeys: async () => Object.keys(store),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
        remove: async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        },
      },
    },
  });
  await import('../src/localmd-connect/options');
  await new Promise((r) => setTimeout(r, 0));
});

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/** The annotation row quoting this text — by content, because the list is
 *  ordered by recency and an index would pin the wrong thing. */
const markRow = (quote: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('#markList .mark')].find((b) =>
    (b.textContent ?? '').includes(quote),
  )!;

describe('the settings page', () => {
  it('finds every element its script reaches for', () => {
    for (const id of [
      'ver',
      'docLink',
      'userScriptsWarn',
      'openSettings',
      'hlEnabled',
      'hlBlock',
      'hlList',
      'hlNote',
      'hlState',
      'permList',
      'permCount',
      'scriptList',
      'scriptsCount',
      'scriptsEmpty',
      'cliSetup',
      'daemonHint',
      'cmdDaemon',
    ]) {
      expect($(id), `#${id} missing from options.html`).toBeTruthy();
    }
  });

  it('reads the settings it is there to show', () => {
    const types = sent.map((m) => m.type);
    expect(types).toContain('GET_PAGE_TOOLS');
    expect(types).toContain('LIST_SITE_SCRIPTS');
    expect(types).toContain('LOCALMD_STATUS');
  });

  it('renders the highlight blacklist it was given', () => {
    expect(($('hlEnabled') as HTMLInputElement).checked).toBe(true);
    expect($('hlList').textContent).toContain('x.test');
  });

  it('lists the four browser-data permissions', () => {
    expect($('permList').querySelectorAll('input[type=checkbox]')).toHaveLength(4);
  });

  it('shows the user-scripts warning when that switch is actually off', () => {
    expect($('userScriptsWarn').classList.contains('show')).toBe(true);
  });
});

describe('the annotations list', () => {
  it('shows every page that has highlights, and what was marked', () => {
    const cards = [...$('markList').querySelectorAll('.mark-page')];
    expect(cards).toHaveLength(2);
    expect($('markList').textContent).toContain('the passage itself');
    expect($('markList').textContent).toContain('another quote');
    expect($('markCount').textContent).toBe('2 on 2 pages');
  });

  it('shows the note, which is the reason the passage was kept', () => {
    expect($('markList').textContent).toContain('why it mattered');
  });

  it('lists the most recently marked page first', () => {
    const titles = [...$('markList').querySelectorAll('.mark-page-host')].map((e) => e.textContent);
    expect(titles).toEqual(['other.test', 'ex.test']);
  });

  it('colours each row by the highlighter that made it', () => {
    // green from the shared palette for the one that names a colour, and the
    // first swatch for the one that does not — an older entry is not broken.
    expect((markRow('the passage itself').querySelector('.swatch') as HTMLElement).style.background)
      .toBe('rgb(126, 214, 126)');
    expect((markRow('another quote').querySelector('.swatch') as HTMLElement).style.background)
      .toBe('rgb(255, 214, 51)');
  });

  it('opens the page when a passage is clicked, and asks to be taken to it', async () => {
    created.length = 0;
    markRow('the passage itself').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(created[0]).toBe('https://ex.test/a');
    // The request survives the navigation in storage — the tab does not exist
    // yet when it is made.
    expect(store.hlFocus).toMatchObject({ key: 'selHl:https://ex.test/a', id: 'h1' });
  });

  it('tells a tab that is ALREADY open, which would never read the request', async () => {
    openTabs.push({ id: 7, url: 'https://ex.test/a', windowId: 1 });
    created.length = 0;
    messaged.length = 0;
    markRow('the passage itself').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(created).toEqual([]);
    expect(messaged[0]).toMatchObject({ tabId: 7, type: 'LOCALMD_FOCUS_HIGHLIGHT', id: 'h1' });
    openTabs.length = 0;
  });

  it('filters on the text, the note and the site', async () => {
    const search = $('markSearch') as HTMLInputElement;
    search.value = 'mattered';
    search.dispatchEvent(new Event('input'));
    expect([...$('markList').querySelectorAll('.mark-page')]).toHaveLength(1);
    search.value = 'other.test';
    search.dispatchEvent(new Event('input'));
    expect($('markList').textContent).toContain('another quote');
    search.value = 'nothing like this';
    search.dispatchEvent(new Event('input'));
    expect($('markEmpty').textContent).toBe('Nothing matches that.');
    search.value = '';
    search.dispatchEvent(new Event('input'));
  });
});

describe('the two panes', () => {
  const navItems = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>('#nav .nav-item'),
  ];
  const shown = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('main section')]
      .filter((s) => !s.hidden)
      .map((s) => s.id);

  it('builds the nav from the sections themselves', () => {
    expect(navItems().map((b) => b.dataset.section)).toEqual([
      'annotations',
      'prompts',
      'browser-data',
      'site-scripts',
      'cliSetup',
    ]);
    // One entry for one feature: the highlights and the switches that make
    // them were two, which read as two features.
    expect(navItems()[0].textContent).toContain('Highlights');
  });

  it('shows exactly one section, and marks its nav item', () => {
    expect(shown()).toEqual(['annotations']);
    expect(navItems()[0].classList.contains('on')).toBe(true);
  });

  it('switches through the hash, so Back works and the deep link is not a special case', () => {
    location.hash = '#site-scripts';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(shown()).toEqual(['site-scripts']);
    expect(navItems().find((b) => b.classList.contains('on'))?.dataset.section).toBe('site-scripts');
    location.hash = '#annotations';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(shown()).toEqual(['annotations']);
  });

  it('falls back to the first section for a hash that names nothing', () => {
    location.hash = '#nowhere';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(shown()).toEqual(['annotations']);
  });

  it('hides the dev-only topic AND its way in', () => {
    // The status reply in this harness says dev: false.
    const cli = navItems().find((b) => b.dataset.section === 'cliSetup')!;
    expect(cli.hidden).toBe(true);
    location.hash = '#cliSetup';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(shown()).toEqual(['annotations']);
    location.hash = '#annotations';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

  it('counts what is in a topic beside its name', () => {
    const marks = navItems()[0].querySelector('.badge');
    expect(marks?.textContent).toBe('2');
  });
});

describe('what stays put while a list scrolls', () => {
  const css = (): string =>
    readFileSync(resolve(process.cwd(), 'src/localmd-connect/options.html'), 'utf8');

  it('scrolls the list, not the section, in the two long topics', () => {
    // The search box must not scroll away from the results it is filtering.
    for (const id of ['markList']) {
      expect($(id).classList.contains('scroller'), `#${id} should be the scroller`).toBe(true);
      // and it is a SIBLING of the search box, not its container
      const search = 'markSearch';
      expect($(id).contains($(search))).toBe(false);
      expect($(id).parentElement).toBe($(search).parentElement);
    }
    const rule = /\.scroller \{([^}]*)\}/.exec(css())?.[1] ?? '';
    expect(rule).toMatch(/overflow-y:\s*auto/);
    // 0 1 auto, so an empty list takes no room and its "nothing yet" line stays
    // under the search box rather than at the bottom of the window.
    expect(rule).toMatch(/flex:\s*0 1 auto/);
  });

  it('a section that owns a scroller does not scroll itself', () => {
    expect(css()).toMatch(/section:has\(> \.scroller\) \{[^}]*overflow:\s*hidden/);
  });

  it('leaves room for a focus ring that a clipping section would cut off', () => {
    // A 100%-wide search box draws its outline 4px outside itself; a section
    // that scrolls clips exactly that, on the left and right only.
    const rule = /\bsection \{([^}]*)\}/.exec(css())?.[1] ?? '';
    expect(rule).toMatch(/padding-inline:\s*4px/);
    expect(rule).toMatch(/margin-inline:\s*-4px/); // pulled back, so nothing moves
  });

  it('centres the content pane rather than pinning it to the sidebar', () => {
    expect(/\.main \{([^}]*)\}/.exec(css())?.[1] ?? '').toMatch(/margin-inline:\s*auto/);
  });
});

describe('prompts', () => {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const lastSaved = (): {
    prompts: Array<{ id: string; label: string; on: boolean }>;
    bar: boolean;
  } => [...sent].reverse().find((m) => m.type === 'SET_PAGE_TOOLS')!['settings' as never] as never;
  const rows = (): HTMLElement[] => [...$('promptList').querySelectorAll<HTMLElement>('.item')];

  it('lists what ships, including the one with no prompt', () => {
    expect(rows().map((r) => r.querySelector('.name')!.textContent)).toEqual([
      'Translate',
      'Explain',
      'Ask…',
    ]);
    expect($('promptCount').textContent).toBe('(3 of 3 on)');
    expect(rows()[0].querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    // The general one says what it does instead of showing a blank subtitle.
    expect(rows()[2].querySelector('.kind')!.textContent).toBe('You type the question each time');
  });

  it('keeps a switched-off prompt instead of deleting it', () => {
    const toggle = rows()[1].querySelector<HTMLInputElement>('input')!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    const saved = lastSaved();
    expect(saved.prompts).toHaveLength(3);
    expect(saved.prompts[1]).toMatchObject({ id: 'explain', on: false });
    // …and the page says so rather than looking the same.
    expect($('promptCount').textContent).toBe('(2 of 3 on)');
    expect(rows()[1].querySelector('.name')!.className).toContain('off');
  });

  it('adds one, and refuses a nameless one', () => {
    $<HTMLButtonElement>('promptAdd').click();
    expect($('promptEditor').hidden).toBe(false);
    const before = sent.length;
    $<HTMLTextAreaElement>('promptText').value = 'Outline this in ${lang}: ${content}';
    $<HTMLButtonElement>('promptSave').click();
    expect(sent.length).toBe(before); // a prompt with no name is nothing
    expect($('promptEditor').hidden).toBe(false);
    $<HTMLInputElement>('promptName').value = 'Outline';
    $<HTMLButtonElement>('promptSave').click();
    expect($('promptEditor').hidden).toBe(true);
    const saved = lastSaved();
    expect(saved.prompts).toHaveLength(4);
    expect(saved.prompts[3]).toMatchObject({ label: 'Outline', on: true });
  });

  it('saves one with no prompt at all — that is the open-ended kind', () => {
    $<HTMLButtonElement>('promptAdd').click();
    $<HTMLInputElement>('promptName').value = 'Anything';
    $<HTMLTextAreaElement>('promptText').value = '';
    $<HTMLButtonElement>('promptSave').click();
    expect($('promptEditor').hidden).toBe(true);
    const saved = lastSaved();
    expect(saved.prompts.at(-1)).toMatchObject({ label: 'Anything', prompt: '', on: true });
  });

  it('edits in place rather than adding a copy', () => {
    rows()[3].querySelectorAll('button')[0].dispatchEvent(new Event('click'));
    expect($('promptEditorTitle').textContent).toBe('Edit Outline');
    $<HTMLInputElement>('promptName').value = 'Outline it';
    $<HTMLButtonElement>('promptSave').click();
    const saved = lastSaved();
    expect(saved.prompts).toHaveLength(5);
    expect(saved.prompts[3].label).toBe('Outline it');
  });

  it('deletes one, and can put the defaults back', () => {
    const before = rows().length;
    rows()[3].querySelectorAll('button')[1].dispatchEvent(new Event('click'));
    expect(lastSaved().prompts).toHaveLength(before - 1);
    $<HTMLButtonElement>('promptReset').click();
    expect(lastSaved().prompts.map((a) => a.id)).toEqual(['translate', 'explain', 'ask']);
    expect($('promptCount').textContent).toBe('(3 of 3 on)');
  });

  it('can switch the whole toolbar off without touching the highlights', () => {
    const bar = $<HTMLInputElement>('barOn');
    expect(bar.checked).toBe(true);
    bar.checked = false;
    bar.dispatchEvent(new Event('change'));
    expect(lastSaved().bar).toBe(false);
  });
});

/**
 * The language box. A `<datalist>` was the obvious control and wrong twice: no
 * arrow until focus, and it filters its own options by what is already typed —
 * so with a language in the box it came up empty. This list always shows
 * everything.
 */
describe('the language list', () => {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const items = (): HTMLButtonElement[] => [
    ...$('langMenu').querySelectorAll<HTMLButtonElement>('button'),
  ];

  it('opens on the caret and shows every suggestion, whatever is typed', () => {
    $<HTMLInputElement>('promptLang').value = '简体中文';
    expect($('langMenu').hidden).toBe(true);
    $<HTMLButtonElement>('langOpen').click();
    expect($('langMenu').hidden).toBe(false);
    expect(items().length).toBeGreaterThan(5);
    expect(items().map((b) => b.textContent)).toContain('English');
    // …and says which one is the current answer.
    expect(items().find((b) => b.classList.contains('on'))!.textContent).toBe('简体中文');
  });

  it('picking one saves it and closes', () => {
    const english = items().find((b) => b.textContent === 'English')!;
    english.click();
    expect($('langMenu').hidden).toBe(true);
    expect($<HTMLInputElement>('promptLang').value).toBe('English');
    const saved = [...sent].reverse().find((m) => m.type === 'SET_PAGE_TOOLS')!;
    expect((saved as unknown as { settings: { lang: string } }).settings.lang).toBe('English');
  });

  it('closes on a click elsewhere — not only by choosing', () => {
    $<HTMLButtonElement>('langOpen').click();
    expect($('langMenu').hidden).toBe(false);
    document.body.click();
    expect($('langMenu').hidden).toBe(true);
  });
});

describe('the merged highlights section', () => {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

  it('holds the switches, the fold and the list in one place', () => {
    const sec = document.getElementById('annotations')!;
    for (const id of ['hlEnabled', 'barOn', 'hlColors', 'hlBlock', 'markSearch', 'markList']) {
      expect(sec.contains(document.getElementById(id)), id).toBe(true);
    }
    // The bulky, rarely-touched half folds, so the list stays the first thing.
    expect($('hlFold').tagName).toBe('DETAILS');
    expect(($('hlFold') as HTMLDetailsElement).open).toBe(false);
  });

  it('lists the sites to stay off as ordinary, removable entries', () => {
    // Including localmd.app, which ships as a default rather than as a rule:
    // one mechanism, visible, and the user can disagree with it.
    const rows = [...$('hlList').querySelectorAll('.item')];
    expect(rows.map((r) => r.querySelector('.name')!.textContent)).toEqual(['x.test']);
    expect(rows[0].querySelector('button')).not.toBeNull();
  });
});

/**
 * The highlights list is the only place in this extension that can destroy the
 * user's own writing, so what it takes to do that is worth pinning.
 */
describe('removing and editing highlights', () => {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const clearButtons = (): HTMLButtonElement[] => [
    ...$('markList').querySelectorAll<HTMLButtonElement>('.mark-page-clear'),
  ];
  /** The row carrying the seeded note, whichever page it ended up on. */
  const notedRow = (): HTMLElement =>
    [...$('markList').querySelectorAll<HTMLElement>('.mark')].find((r) =>
      r.textContent?.includes('the passage itself'),
    )!;
  /** The page's own dialog, not the browser's. */
  const dialog = () => document.getElementById('modal')!;
  const asks = (): string =>
    dialog().hidden ? '' : `${$('modalTitle').textContent} ${$('modalBody').textContent}`;
  const answerDialog = (yes: boolean): void => {
    ($(yes ? 'modalOk' : 'modalCancel') as HTMLButtonElement).click();
  };

  it('asks before removing a whole page, and says how many and where', () => {
    const keys = Object.keys(store).length;
    clearButtons()[0].click();
    expect(asks()).toMatch(/Remove \d+ highlights?\?/);
    expect(asks()).toContain('cannot be undone');
    // The SAFE button has focus, so a reflexive Enter cancels.
    expect(document.activeElement).toBe($('modalCancel'));
    answerDialog(false);
    expect(dialog().hidden).toBe(true);
    expect(Object.keys(store)).toHaveLength(keys); // "no" means no
  });

  it('asks before removing one, and quotes what it would remove', () => {
    const row = notedRow();
    (row.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(asks()).toContain('the passage itself');
    answerDialog(false);
    expect(notedRow()).toBeTruthy(); // still there
  });

  it('every quick way out of the dialog is the safe way', () => {
    clearButtons()[0].click();
    expect(dialog().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog().hidden).toBe(true);
    clearButtons()[0].click();
    dialog().dispatchEvent(new MouseEvent('click', { bubbles: true })); // the backdrop
    expect(dialog().hidden).toBe(true);
  });

  it('gives every highlight its own actions without taking away the jump', () => {
    const row = notedRow();
    expect(row.querySelectorAll('button')).toHaveLength(2); // note, remove
    expect(row.getAttribute('role')).toBe('button');
  });

  it('edits a note where it is read', () => {
    const row = notedRow();
    (row.querySelectorAll('button')[0] as HTMLButtonElement).click();
    const box = row.querySelector('.note-edit')!;
    const ta = box.querySelector('textarea')!;
    expect(ta.value).toBe('why it mattered'); // as seeded
    ta.value = 'a better reason';
    (box.querySelectorAll('button')[0] as HTMLButtonElement).click();
    expect(row.querySelector('.note-edit')).toBeNull();
  });

  it('removes it once the question is answered yes', async () => {
    const key = 'selHl:https://ex.test/a';
    const before = (store[key] as unknown[]).length;
    (notedRow().querySelectorAll('button')[1] as HTMLButtonElement).click();
    answerDialog(true);
    await new Promise((r) => setTimeout(r, 0));
    expect((store[key] as unknown[] | undefined)?.length ?? 0).toBe(before - 1);
  });
});

/**
 * The list follows the pages. The content script already listens the other way
 * — a mark removed here stops being painted on an open tab — and this is the
 * missing half: a list of annotations that goes stale the moment you highlight
 * something is a list you stop trusting.
 */
describe('highlights made while this page is open', () => {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const quotes = (): string[] =>
    [...$('markList').querySelectorAll('.mark-quote')].map((n) => n.textContent ?? '');
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 260));

  const KEY = 'selHl:https://ex.test/a';
  const mark = (id: string, exact: string) => ({
    id,
    ts: Date.now(),
    exact,
    prefix: '',
    suffix: '',
    title: 'A page',
  });

  it('shows one that appeared in another tab', async () => {
    expect(quotes()).not.toContain('marked a moment ago');
    // Whatever the removal tests above left behind — another tab writes the
    // whole page's list, which is what the store does.
    store[KEY] = [mark('h9', 'marked a moment ago')];
    fireStorage({ [KEY]: {} });
    await settle();
    expect(quotes()).toContain('marked a moment ago');
  });

  it('waits rather than throwing away a note somebody is typing', async () => {
    const row = [...$('markList').querySelectorAll<HTMLElement>('.mark')].find((r) =>
      r.textContent?.includes('marked a moment ago'),
    )!;
    (row.querySelectorAll('button')[0] as HTMLButtonElement).click();
    const box = row.querySelector('.note-edit')!;
    (box.querySelector('textarea') as HTMLTextAreaElement).value = 'half a thought';
    // A highlight lands elsewhere while that is open.
    store[KEY] = [mark('h9', 'marked a moment ago'), mark('h10', 'later still')];
    fireStorage({ [KEY]: {} });
    await settle();
    expect(row.querySelector('.note-edit')).not.toBeNull(); // still typing
    expect(quotes()).not.toContain('later still');
    // …and it arrives when the editor closes.
    (box.querySelectorAll('button')[1] as HTMLButtonElement).click(); // Cancel
    await settle();
    expect(quotes()).toContain('later still');
  });

  it('ignores changes that are not highlights', async () => {
    const before = quotes().length;
    fireStorage({ localmdPromptCache: {} });
    await settle();
    expect(quotes()).toHaveLength(before);
  });
});
