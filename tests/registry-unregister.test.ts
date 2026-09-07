/**
 * registry.unregister — needed by the install manager to remove a
 * runtime-installed adapter on uninstall/disable.
 */

import { describe, it, expect } from 'vitest';
import { cli, getRegistry, findAdapter, unregister } from '../src/runtime/registry.js';

describe('registry.unregister', () => {
  it('removes a registered adapter and returns true', () => {
    cli({ site: 'unreg', name: 'a', access: 'read', func: async () => [] });
    expect(findAdapter('unreg', 'a')).toBeTruthy();
    expect(unregister('unreg', 'a')).toBe(true);
    expect(findAdapter('unreg', 'a')).toBeUndefined();
  });

  it('returns false when nothing matches', () => {
    expect(unregister('nope', 'nope')).toBe(false);
  });

  it('only removes the targeted (site,name), leaving siblings intact', () => {
    cli({ site: 'unreg2', name: 'x', access: 'read', func: async () => [] });
    cli({ site: 'unreg2', name: 'y', access: 'read', func: async () => [] });
    expect(unregister('unreg2', 'x')).toBe(true);
    expect(findAdapter('unreg2', 'x')).toBeUndefined();
    expect(findAdapter('unreg2', 'y')).toBeTruthy();
  });

  it('a re-registered adapter (install→uninstall→install) ends up registered once', () => {
    const def = { site: 'unreg3', name: 'z', access: 'read' as const, _installed: true, func: async () => [] };
    cli(def);
    unregister('unreg3', 'z');
    cli(def);
    const matches = getRegistry().filter((d: { site: string; name: string }) => d.site === 'unreg3' && d.name === 'z');
    expect(matches).toHaveLength(1);
  });
});
