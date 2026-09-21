// @vitest-environment jsdom
/**
 * WebCLI's popup, actually running.
 *
 * Written when the settings moved OUT of this popup onto a page of their own:
 * what is left has to keep working, and the ways INTO the new page have to
 * resolve. The deep link is the part worth a test — the bundler emits the
 * settings page at its source path, so a hand-written "options.html" URL is one
 * that has never existed, and it fails as a blank tab with no error anywhere.
 * Reading the path out of the manifest is the fix; this pins it.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const created: string[] = [];
const store: Record<string, unknown> = {};
const connected = false;

vi.mock('../src/site-scripts/store', () => ({
  listSiteScripts: async () => [{ id: 'ss_1' }, { id: 'ss_2' }, { id: 'ss_3' }],
}));

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'src/webcli/popup.html'), 'utf8');
  document.documentElement.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-ext',
      lastError: undefined,
      getManifest: () => ({
        version: '9.9.9',
        options_ui: { page: 'src/webcli/options.html' },
      }),
      getURL: (path: string) => `chrome-extension://test-ext/${path}`,
      openOptionsPage: () => {},
      sendMessage: (msg: { type: string }, cb?: (r: unknown) => void) => {
        if (msg.type === 'WEBCLI_STATUS')
          cb?.({ connected, enabled: true, port: 9376, toolsTotal: 39, toolsAdvertised: 39 });
        else cb?.(undefined);
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
        get: async () => ({ ...store }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
      },
    },
  });
  vi.stubGlobal('close', () => {});
  await import('../src/webcli/popup');
  await new Promise((r) => setTimeout(r, 0));
});

const $ = (id: string): HTMLElement => document.getElementById(id)!;

describe('the WebCLI popup', () => {
  it('finds every element its script reaches for', () => {
    for (const id of [
      'ver',
      'docLink',
      'openOptions',
      'ghLink',
      'ghIco',
      'dot',
      'statusText',
      'setup',
      'setupHint',
      'profileCount',
      'scriptsCount',
      'cmdSkill',
    ]) {
      expect($(id), `#${id} missing from popup.html`).toBeTruthy();
    }
  });

  it('names the repository in the footer, with its mark', () => {
    expect($('ghLink').getAttribute('href')).toBe('https://github.com/whitefoxx/web-tools');
    expect($('ghIco').innerHTML).toContain('<svg');
  });

  it('opens the settings page at the path the MANIFEST gives, not a guessed one', () => {
    $('openOptions').click();
    expect(created.at(-1)).toBe('chrome-extension://test-ext/src/webcli/options.html');
  });

  it('each row is a deep link into the section it is about', () => {
    for (const b of document.querySelectorAll<HTMLButtonElement>('button.jump')) b.click();
    expect(created.slice(-2)).toEqual([
      'chrome-extension://test-ext/src/webcli/options.html#tools',
      'chrome-extension://test-ext/src/webcli/options.html#site-scripts',
    ]);
  });

  it('still answers the question it is opened for: connected, and how much', () => {
    expect($('statusText').textContent).toBe('Not connected to daemon (port 9376)');
    expect($('profileCount').textContent).toBe('39/39');
    expect($('scriptsCount').textContent).toBe('3');
  });

  it('opens the setup disclosure only while nothing is connected', () => {
    // First SW answer said "not connected", so the one-time decision opened it.
    expect(($('setup') as HTMLDetailsElement).open).toBe(true);
    expect($('setupHint').textContent).toContain('starts the local bridge');
  });
});
