/**
 * siteFromHost — registrable second-level site label from a hostname (explore
 * site derivation). Pure. Fixes chat.deepseek.com → "chat" (it should be
 * "deepseek").
 */

import { describe, it, expect } from 'vitest';
import { siteFromHost } from '../src/tools/generic/open-url';

describe('siteFromHost', () => {
  it.each([
    ['chat.deepseek.com', 'deepseek'],
    ['www.zhihu.com', 'zhihu'],
    ['deepseek.com', 'deepseek'],
    ['m.example.com', 'example'],
    ['news.ycombinator.com', 'ycombinator'],
    ['weibo.com.cn', 'weibo'],
    ['example.co.uk', 'example'],
    ['xiaohongshu.com', 'xiaohongshu'],
    ['localhost', 'localhost'],
  ])('%s → %s', (host, site) => {
    expect(siteFromHost(host)).toBe(site);
  });
});
