/**
 * Site-scripts pure core: match-pattern validation (+ too-broad rejection),
 * input → SiteScript building (validation chokepoint), and compilation to the
 * chrome.scripting shape. IDB CRUD is best-effort/guarded (no node tests). Pure.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidMatchPattern,
  isTooBroadPattern,
  hostOfPattern,
  buildSiteScript,
  buildInjectionCode,
  buildDryRunCode,
  buildSiteCss,
  flagFragileSelectors,
  compileSiteScript,
  describeSiteScript,
  type SiteScript,
} from '../src/site-scripts/store';

describe('isValidMatchPattern', () => {
  it('accepts well-formed patterns', () => {
    expect(isValidMatchPattern('https://*.zhihu.com/*')).toBe(true);
    expect(isValidMatchPattern('https://news.ycombinator.com/*')).toBe(true);
    expect(isValidMatchPattern('*://example.com/path/*')).toBe(true);
    expect(isValidMatchPattern('<all_urls>')).toBe(true);
  });
  it('rejects malformed patterns', () => {
    expect(isValidMatchPattern('zhihu.com')).toBe(false); // no scheme
    expect(isValidMatchPattern('https://example.com')).toBe(false); // no path
    expect(isValidMatchPattern('')).toBe(false);
    expect(isValidMatchPattern('javascript://x/*')).toBe(false);
  });
});

describe('isTooBroadPattern', () => {
  it('flags whole-web patterns', () => {
    expect(isTooBroadPattern('<all_urls>')).toBe(true);
    expect(isTooBroadPattern('*://*/*')).toBe(true);
    expect(isTooBroadPattern('https://*/*')).toBe(true);
  });
  it('allows concrete hosts (incl. subdomain wildcard)', () => {
    expect(isTooBroadPattern('https://*.zhihu.com/*')).toBe(false);
    expect(isTooBroadPattern('https://example.com/*')).toBe(false);
  });
});

describe('hostOfPattern', () => {
  it('extracts the host, stripping the subdomain wildcard', () => {
    expect(hostOfPattern('https://*.zhihu.com/*')).toBe('zhihu.com');
    expect(hostOfPattern('https://news.ycombinator.com/*')).toBe('news.ycombinator.com');
  });
});

describe('buildSiteScript', () => {
  const now = 1000;
  it('builds a valid hide-selector script', () => {
    const s = buildSiteScript(
      { matches: ['https://*.zhihu.com/*'], hideSelectors: ['.Pc-word', ' .ad '] },
      'id1',
      now,
    );
    expect(s.matches).toEqual(['https://*.zhihu.com/*']);
    expect(s.hideSelectors).toEqual(['.Pc-word', '.ad']); // trimmed
    expect(s.runAt).toBe('document_start'); // default
    expect(s.enabled).toBe(true);
    expect(s.label).toBe('zhihu.com script'); // default from host
    expect(s.origin).toEqual({ type: 'manual' });
    expect(s.createdAt).toBe(now);
  });

  it('rejects empty matches', () => {
    expect(() => buildSiteScript({ matches: [] }, 'i', now)).toThrow(/matches cannot be empty/);
  });
  it('rejects malformed / too-broad matches', () => {
    expect(() =>
      buildSiteScript({ matches: ['zhihu.com'], hideSelectors: ['.a'] }, 'i', now),
    ).toThrow(/Invalid match pattern/);
    expect(() =>
      buildSiteScript({ matches: ['<all_urls>'], hideSelectors: ['.a'] }, 'i', now),
    ).toThrow(/too broad/);
    expect(() =>
      buildSiteScript({ matches: ['https://*/*'], hideSelectors: ['.a'] }, 'i', now),
    ).toThrow(/too broad/);
  });
  it('rejects an effect-less script', () => {
    expect(() => buildSiteScript({ matches: ['https://a.com/*'] }, 'i', now)).toThrow(
      /Script has no effect/,
    );
  });
  it('drops selectors containing braces (rule-breakout defense)', () => {
    const s = buildSiteScript(
      { matches: ['https://a.com/*'], hideSelectors: ['.ok', '.bad{color:red}', 'x}y'] },
      'i',
      now,
    );
    expect(s.hideSelectors).toEqual(['.ok']);
  });
  it('clamps runAt to the allowed enum', () => {
    expect(
      buildSiteScript(
        { matches: ['https://a.com/*'], hideSelectors: ['.a'], runAt: 'bogus' },
        'i',
        now,
      ).runAt,
    ).toBe('document_start');
    expect(
      buildSiteScript(
        { matches: ['https://a.com/*'], hideSelectors: ['.a'], runAt: 'document_end' },
        'i',
        now,
      ).runAt,
    ).toBe('document_end');
  });
  it('honors a custom label + origin + enabled:false', () => {
    const s = buildSiteScript(
      {
        matches: ['https://a.com/*'],
        css: 'body{background:#000}',
        label: '暗色',
        enabled: false,
        origin: { type: 'explore', note: 't' },
      },
      'i',
      now,
    );
    expect(s.label).toBe('暗色');
    expect(s.enabled).toBe(false);
    expect(s.origin).toEqual({ type: 'explore', note: 't' });
    expect(s.css).toBe('body{background:#000}');
  });
});

describe('buildInjectionCode', () => {
  it('injects a <style> for the css, JSON-escaped', () => {
    const code = buildInjectionCode('.ad{display:none!important}');
    expect(code).toContain('createElement');
    expect(code).toContain(JSON.stringify('.ad{display:none!important}'));
    expect(code).toContain('data-web-site-script');
  });
  it('appends raw js in its own try/catch', () => {
    const code = buildInjectionCode('', 'doThing()');
    expect(code).not.toContain('createElement'); // no css → no style block
    expect(code).toContain('doThing()');
    expect(code).toContain('try{');
  });
  it('empty css + js → just the IIFE shell', () => {
    expect(buildInjectionCode('')).toBe('(function(){\n})();');
  });
});

describe('buildDryRunCode', () => {
  // The produced code is plain JS (no DOM needed for DOM-free snippets), so we
  // execute it in node to verify the capture semantics end-to-end.
  const run = (
    js: string,
  ): { ok: boolean; error?: string; returnValue?: unknown; logs: string[] } =>
    eval(buildDryRunCode(js));

  it('captures a top-level return value', () => {
    expect(run('return 1 + 2;')).toEqual({ ok: true, error: undefined, returnValue: 3, logs: [] });
  });
  it('captures console output (objects JSON-stringified) alongside the return', () => {
    const r = run("console.log('a', { x: 1 }); console.warn('w'); return 'done';");
    expect(r.ok).toBe(true);
    expect(r.returnValue).toBe('done');
    expect(r.logs).toEqual(['log: a {"x":1}', 'warn: w']);
  });
  it('captures a thrown error and restores the patched console', () => {
    const before = console.log;
    const r = run("throw new Error('boom')");
    expect(r.ok).toBe(false);
    expect(r.error).toContain('boom');
    expect(console.log).toBe(before); // restored in finally
  });
  it('runs a side-effecting IIFE (undefined return, still ok)', () => {
    const r = run('(function(){ var z = 1 + 1; })()');
    expect(r).toMatchObject({ ok: true, returnValue: undefined });
  });
});

describe('compileSiteScript', () => {
  const base: SiteScript = {
    id: 'id1',
    label: 'x',
    matches: ['https://a.com/*'],
    runAt: 'document_start',
    enabled: true,
    origin: { type: 'manual' },
    createdAt: 0,
    updatedAt: 0,
  };
  it('produces a USER_SCRIPT entry whose code injects the hide rule', () => {
    const c = compileSiteScript({ ...base, hideSelectors: ['.ad', '#banner'] });
    expect(c.world).toBe('USER_SCRIPT');
    expect(c.id).toBe('id1');
    expect(c.matches).toEqual(['https://a.com/*']);
    expect(c.js).toHaveLength(1);
    expect(c.js[0]!.code).toContain(JSON.stringify('.ad,#banner{display:none!important}'));
  });
  it('appends raw css after the hide rule in the injected style', () => {
    const c = compileSiteScript({ ...base, hideSelectors: ['.ad'], css: 'body{color:red}' });
    expect(c.js[0]!.code).toContain(JSON.stringify('.ad{display:none!important}\nbody{color:red}'));
  });
  it('includes raw js in the injected code', () => {
    const c = compileSiteScript({ ...base, js: 'console.log(1)' });
    expect(c.js[0]!.code).toContain('console.log(1)');
  });
});

describe('buildSiteCss', () => {
  it('joins a hide rule + raw css', () => {
    expect(buildSiteCss(['.ad', '#banner'], 'body{color:red}')).toBe(
      '.ad,#banner{display:none!important}\nbody{color:red}',
    );
  });
  it('hide-only', () => {
    expect(buildSiteCss(['.ad'])).toBe('.ad{display:none!important}');
  });
  it('css-only', () => {
    expect(buildSiteCss(undefined, 'a{color:blue}')).toBe('a{color:blue}');
  });
  it('empty → empty', () => {
    expect(buildSiteCss([], '')).toBe('');
  });
});

describe('flagFragileSelectors (v1.1 lint)', () => {
  it('flags hashed / CSS-modules / styled-components classes', () => {
    expect(flagFragileSelectors(['.YzCcne'])).toEqual(['.YzCcne']); // short random mixed-case
    expect(flagFragileSelectors(['.Content-module__Content__mHmep'])).toEqual([
      '.Content-module__Content__mHmep',
    ]);
    expect(flagFragileSelectors(['.sc-hjKLMn'])).toEqual(['.sc-hjKLMn']);
    expect(flagFragileSelectors(['.css-1a2b3c'])).toEqual(['.css-1a2b3c']);
  });
  it('does NOT flag semantic / BEM / short-stable classes', () => {
    expect(flagFragileSelectors(['.Banner-adTag', '.ad-banner', '#promoted'])).toEqual([]);
    expect(flagFragileSelectors(['.search-result__title', '.header__nav-button'])).toEqual([]);
    expect(flagFragileSelectors(['[data-ad]', 'a[href*="/ads/"]', '.ad'])).toEqual([]);
  });
  it('scans compound selectors + dedupes', () => {
    expect(flagFragileSelectors(['.AdvertImg.YzCcne', '.other .YzCcne'])).toEqual(['.YzCcne']);
  });
  it('handles empty / undefined', () => {
    expect(flagFragileSelectors(undefined)).toEqual([]);
    expect(flagFragileSelectors([])).toEqual([]);
  });
});

describe('describeSiteScript', () => {
  const base: SiteScript = {
    id: 'i',
    label: '知乎去广告',
    matches: ['https://*.zhihu.com/*'],
    runAt: 'document_start',
    enabled: true,
    origin: { type: 'manual' },
    createdAt: 0,
    updatedAt: 0,
  };
  it('summarizes effects, flagging JS', () => {
    expect(describeSiteScript({ ...base, hideSelectors: ['.a', '.b'] })).toContain(
      'hide 2 selector(s)',
    );
    expect(describeSiteScript({ ...base, js: 'x' })).toContain('⚠️ inject JS');
  });
});
