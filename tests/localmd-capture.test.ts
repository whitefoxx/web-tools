// @vitest-environment jsdom
/**
 * localmd Connect knowledge-base capture (docs/localmd-connect.md §14): the
 * pure parts of the clipper, the inbox and the capture routing. The browser
 * I/O (executeScript, IndexedDB, fetch) is exercised on a real machine per
 * docs/tests; what is pinned here is the data shape localmd builds on.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.stubGlobal('chrome', {
  tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
  windows: { onRemoved: { addListener: () => {} } },
  runtime: { getManifest: () => ({ name: 'localmd Connect' }) },
});

import { extractPageMeta, extractPageMarkdown } from '../src/tools/generic/get-page-text';
import { parseHtml } from '../src/tools/generic/_mini-dom';
import { collectImageUrls } from '../src/localmd-connect/clip';
import { makeInboxItem, sortInbox, summarize } from '../src/localmd-connect/inbox';
import { actionForMenuId, MENU_IDS, COMMAND_IDS } from '../src/localmd-connect/capture-actions';
import { parseIds } from '../src/tools/generic/inbox';

describe('extractPageMeta', () => {
  it('reads Open Graph, canonical, article dates, author, lang, description', () => {
    document.documentElement.setAttribute('lang', 'zh-CN');
    document.head.innerHTML =
      '<title>Fallback</title>' +
      '<link rel="canonical" href="https://ex.test/post/1">' +
      '<meta property="og:title" content="OG Title">' +
      '<meta property="og:site_name" content="Example">' +
      '<meta name="description" content="A summary.">' +
      '<meta name="author" content="Ada">' +
      '<meta property="article:published_time" content="2026-01-02T03:04:05Z">' +
      '<meta property="og:image" content="/hero.png">';
    const m = extractPageMeta();
    expect(m.title).toBe('OG Title');
    expect(m.canonical).toBe('https://ex.test/post/1');
    expect(m.site).toBe('Example');
    expect(m.description).toBe('A summary.');
    expect(m.author).toBe('Ada');
    expect(m.published).toBe('2026-01-02T03:04:05Z');
    expect(m.image).toBe('/hero.png');
    expect(m.lang).toBe('zh-CN');
    document.head.innerHTML = '';
  });

  it('falls back to JSON-LD for what the meta tags left empty', () => {
    document.head.innerHTML =
      '<title>T</title>' +
      '<script type="application/ld+json">' +
      JSON.stringify({
        '@type': 'Article',
        datePublished: '2025-12-31',
        author: { '@type': 'Person', name: 'Grace' },
      }) +
      '</script>';
    const m = extractPageMeta();
    expect(m.published).toBe('2025-12-31');
    expect(m.author).toBe('Grace');
    document.head.innerHTML = '';
  });

  it('ignores a malformed JSON-LD block', () => {
    document.head.innerHTML =
      '<title>T</title><script type="application/ld+json">{nope</script>' +
      '<meta name="author" content="Ok">';
    expect(extractPageMeta().author).toBe('Ok');
    document.head.innerHTML = '';
  });

  it('answers the same over the mini DOM (the raw-fetch path)', () => {
    const html =
      '<html><head><title>Mini</title><meta property="og:site_name" content="S">' +
      '<meta name="author" content="A"><link rel="canonical" href="https://m.test/c"></head>' +
      '<body><p>x</p></body></html>';
    const doc = parseHtml(html, 'https://m.test/p');
    const m = extractPageMeta(doc as unknown as Parameters<typeof extractPageMeta>[0]);
    expect(m.title).toBe('Mini');
    expect(m.site).toBe('S');
    expect(m.author).toBe('A');
    expect(m.canonical).toBe('https://m.test/c');
    expect(m.url).toBe('https://m.test/p');
  });
});

describe('selection clip: fragment → Markdown through the shared walker', () => {
  it('renders a selection fragment via the mini DOM with the same dialect', () => {
    const doc = parseHtml(
      '<body><h2>Sub</h2><p>Hello <a href="https://x.test/a">there</a></p></body>',
      'https://x.test/p',
    );
    const md = extractPageMarkdown(
      100_000,
      'body',
      doc as unknown as Parameters<typeof extractPageMarkdown>[2],
    ).markdown;
    expect(md).toContain('## Sub');
    expect(md).toContain('[there](https://x.test/a)');
  });
});

describe('collectImageUrls', () => {
  it('lists absolute http(s) image URLs, og:image first, deduplicated', () => {
    const md =
      '![a](https://c.test/a.png) text ![b](/b.jpg "t") ![a again](https://c.test/a.png) ![d](data:image/png;base64,AAA)';
    expect(collectImageUrls(md, 'https://c.test/x/', 'https://c.test/hero.png')).toEqual([
      'https://c.test/hero.png',
      'https://c.test/a.png',
      'https://c.test/b.jpg',
    ]);
  });
});

describe('inbox (pure parts)', () => {
  it('builds items with a tabId only when given, and lists oldest first', () => {
    const a = makeInboxItem('clip', { url: 'u1', title: 't1', payload: {} }, 2000);
    const b = makeInboxItem(
      'ask',
      { url: 'u2', title: 't2', tabId: 5, payload: { selection: 's' } },
      1000,
    );
    expect('tabId' in a).toBe(false);
    expect(b.tabId).toBe(5);
    expect(sortInbox([a, b]).map((i) => i.id)).toEqual([b.id, a.id]);
    expect(summarize(b)).toEqual({
      id: b.id,
      kind: 'ask',
      createdAt: 1000,
      url: 'u2',
      title: 't2',
      tabId: 5,
    });
  });
});

describe('ack_inbox id parsing', () => {
  it('accepts a JSON array, an array, or a comma list', () => {
    expect(parseIds('["a","b"]')).toEqual(['a', 'b']);
    expect(parseIds(['a', ' b '])).toEqual(['a', 'b']);
    expect(parseIds('a, b c')).toEqual(['a', 'b', 'c']);
    expect(parseIds('')).toEqual([]);
  });
});

describe('where "Ask localmd" goes', () => {
  /** The two lists as the service worker declares them, dev build included. */
  const ALLOWED_DEV = ['https://localmd.app', 'http://localhost:5173', 'http://localhost:8123'];
  const APP_DEV = ['http://localhost:5173'];
  const APP_SHIPPING = ['https://localmd.app'];

  it('each build has exactly ONE app: the dev build drives the dev app', () => {
    // Not a search over candidates. Two earlier versions treated it as one and
    // were wrong the same way — first the whole allowlist (so "Ask localmd"
    // focused this repo's fixture server), then both app origins with a
    // most-recently-used tiebreak (so a dev build still jumped to production
    // whenever a localmd.app tab happened to be open).
    expect(APP_DEV).toEqual(['http://localhost:5173']);
    expect(APP_SHIPPING).toEqual(['https://localmd.app']);
  });

  it("localmd's own origin is one the extension also allows to connect", () => {
    for (const o of APP_DEV) expect(ALLOWED_DEV).toContain(o);
  });

  it('the fixture server may CONNECT but is not localmd', () => {
    // The bug this pins: handing the allowlist to ensureLocalmdTab made "Ask
    // localmd" focus whichever allowed origin had a tab open, which in a dev
    // profile is this repo's fixture server. "May talk to the extension" and
    // "is the app" are different questions.
    expect(ALLOWED_DEV).toContain('http://localhost:8123');
    expect(APP_DEV).not.toContain('http://localhost:8123');
  });

  it('the service worker declares one origin per build, not a merged list', () => {
    const sw = readFileSync(
      resolve(process.cwd(), 'src/background/localmd-connect-service-worker.ts'),
      'utf8',
    );
    const decl = /const LOCALMD_APP_ORIGINS[^;]+;/.exec(sw)?.[0] ?? '';
    expect(decl).toMatch(/__LOCALMD_DEV__/);
    expect(decl).toMatch(/'http:\/\/localhost:5173'/);
    expect(decl).toMatch(/'https:\/\/localmd\.app'/);
    // The dev branch must not also list production: that is the bug.
    const q = decl.indexOf('?');
    expect(decl.slice(q, decl.indexOf(':', q))).not.toMatch(/localmd\.app/);
  });

  it('the service worker uses the app list, not the allowlist, to find a tab', () => {
    const sw = readFileSync(
      resolve(process.cwd(), 'src/background/localmd-connect-service-worker.ts'),
      'utf8',
    );
    expect(sw).toMatch(/ensureLocalmdTab\(LOCALMD_APP_ORIGINS/);
    expect(sw).not.toMatch(/ensureLocalmdTab\(ALLOWED_ORIGINS/);
    // And the two lists really are declared differently, so this is not a
    // rename of the same thing.
    expect(sw).toMatch(/const LOCALMD_APP_ORIGINS/);
  });
});

describe('capture routing', () => {
  it('knows both screenshot gestures apart', () => {
    expect(actionForMenuId(MENU_IDS.screenshot_region)).toBe('screenshot_region');
    expect(actionForMenuId(MENU_IDS.screenshot_page)).toBe('screenshot_page');
  });

  it('maps every menu id back to its action and no other id', () => {
    for (const [action, id] of Object.entries(MENU_IDS)) expect(actionForMenuId(id)).toBe(action);
    expect(actionForMenuId('nope')).toBeNull();
  });

  it('the manifest commands are exactly the ones the SW routes', () => {
    // process.cwd() rather than import.meta.url: under the jsdom environment
    // the module URL is not file:-schemed.
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'manifest.localmd.json'), 'utf8'),
    ) as { commands: Record<string, unknown> };
    expect(Object.keys(manifest.commands).sort()).toEqual(Object.keys(COMMAND_IDS).sort());
  });
});
