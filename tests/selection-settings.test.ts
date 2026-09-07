/**
 * 划词助手 settings — pure parts: defaults merge (tolerates older/partial
 * blobs), the BLACKLIST hostname matcher (suffix semantics, no substring
 * false-positives), and user-input normalization.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeSelSettings,
  isHostBlacklisted,
  normalizeBlacklistEntry,
  visibleSelActions,
  DEFAULT_SEL_ACTIONS,
} from '../src/selection/settings';

describe('mergeSelSettings', () => {
  it('empty/garbage → defaults (disabled, auto, preset actions)', () => {
    for (const raw of [undefined, null, 42, {}]) {
      const s = mergeSelSettings(raw);
      expect(s.enabled).toBe(false);
      expect(s.trigger).toBe('auto');
      expect(s.blacklist).toEqual([]);
      expect(s.actions).toEqual(DEFAULT_SEL_ACTIONS);
    }
  });

  it('keeps user values; drops malformed actions/blacklist entries', () => {
    const s = mergeSelSettings({
      enabled: true,
      trigger: 'alt',
      blacklist: ['example.com', 42, ''],
      actions: [{ id: 'x', label: '改写', prompt: '改写得更通顺' }, { nope: true }],
    });
    expect(s.enabled).toBe(true);
    expect(s.trigger).toBe('alt');
    expect(s.blacklist).toEqual(['example.com']);
    expect(s.actions).toEqual([{ id: 'x', label: '改写', prompt: '改写得更通顺' }]);
  });

  it('an empty actions array falls back to the presets (never a dead toolbar)', () => {
    expect(mergeSelSettings({ actions: [] }).actions).toEqual(DEFAULT_SEL_ACTIONS);
  });

  it('minChars: kept as stored (0 = explicit always-show), legacy 总结 backfilled to 120', () => {
    const s = mergeSelSettings({
      actions: [
        { id: 'summarize', label: '总结', prompt: 'p' }, // legacy blob, field absent
        { id: 'x', label: '改写', prompt: 'p', minChars: 50 },
        { id: 'y', label: '解释', prompt: 'p', minChars: 0 },
        { id: 'z', label: '翻译', prompt: 'p', minChars: -3 }, // malformed → dropped
      ],
    });
    expect(s.actions[0].minChars).toBe(120);
    expect(s.actions[1].minChars).toBe(50);
    expect(s.actions[2].minChars).toBe(0);
    expect(s.actions[3].minChars).toBeUndefined();
  });
});

describe('visibleSelActions', () => {
  it('hides actions whose minChars exceeds the selection length', () => {
    const acts = [
      { id: 'a', label: '翻译', prompt: 'p' },
      { id: 'b', label: '总结', prompt: 'p', minChars: 120 },
      { id: 'c', label: '解释', prompt: 'p', minChars: 0 },
    ];
    expect(visibleSelActions(acts, 30).map((a) => a.id)).toEqual(['a', 'c']);
    expect(visibleSelActions(acts, 120).map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('isHostBlacklisted', () => {
  const bl = ['example.com', 'www.zhihu.com'];
  it('exact + subdomain suffix match', () => {
    expect(isHostBlacklisted('example.com', bl)).toBe(true);
    expect(isHostBlacklisted('sub.example.com', bl)).toBe(true);
    expect(isHostBlacklisted('a.b.example.com', bl)).toBe(true);
  });
  it('no substring false-positives', () => {
    expect(isHostBlacklisted('notexample.com', bl)).toBe(false);
    expect(isHostBlacklisted('example.com.evil.net', bl)).toBe(false);
  });
  it('www. is transparent on both sides', () => {
    expect(isHostBlacklisted('www.example.com', bl)).toBe(true);
    expect(isHostBlacklisted('zhihu.com', bl)).toBe(true);
    expect(isHostBlacklisted('zhuanlan.zhihu.com', bl)).toBe(true);
  });
});

describe('normalizeBlacklistEntry', () => {
  it('bare host / full URL / www-stripping', () => {
    expect(normalizeBlacklistEntry('Example.com')).toBe('example.com');
    expect(normalizeBlacklistEntry('https://www.zhihu.com/question/1')).toBe('zhihu.com');
    expect(normalizeBlacklistEntry('http://localhost:8123/x')).toBe('localhost');
  });
  it('garbage → null', () => {
    expect(normalizeBlacklistEntry('')).toBeNull();
    expect(normalizeBlacklistEntry('   ')).toBeNull();
  });
});
