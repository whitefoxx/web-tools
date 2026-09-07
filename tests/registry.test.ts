import { describe, it, expect } from 'vitest';
import { cli, getRegistry, findAdapter, Strategy } from '../src/runtime/registry.js';

describe('Strategy enum', () => {
  it('exposes the expected literal values', () => {
    expect(Strategy.COOKIE).toBe('cookie');
    expect(Strategy.DIRECT).toBe('direct');
    expect(Strategy.AUTO).toBe('auto');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(Strategy)).toBe(true);
  });
});

describe('cli() registration', () => {
  it('registers an adapter and findAdapter retrieves it', () => {
    const before = getRegistry().length;
    cli({
      site: 'testsite',
      name: 'cmd1',
      description: 'test cmd',
      func: async () => 'ok',
    });
    expect(getRegistry().length).toBe(before + 1);
    const found = findAdapter('testsite', 'cmd1');
    expect(found?.name).toBe('cmd1');
    expect(found?.site).toBe('testsite');
  });

  it('throws on missing site/name but tolerates a missing func', () => {
    expect(() => cli(null as any)).toThrow();
    expect(() => cli({ name: 'x', func: async () => {} } as any)).toThrow(/site/);
    expect(() => cli({ site: 'x', func: async () => {} } as any)).toThrow(/name/);
    // opencli permits func-less commands whose logic is a declarative
    // `pipeline` (e.g. hackernews/top.js). Requiring func would reject those
    // and break source-level drop-in compat, so cli() registers with a warning
    // instead of throwing. The dispatcher returns a clear error if such a
    // command is actually executed without a pipeline engine.
    expect(() => cli({ site: 'funcless', name: 'y' } as any)).not.toThrow();
    expect(findAdapter('funcless', 'y')?.name).toBe('y');
  });
});

describe('getRegistry() isolation', () => {
  it('returns a shallow copy — mutating the result does not pollute', () => {
    const reg1 = getRegistry();
    reg1.push({ site: 'mutated', name: 'x', func: async () => {} } as any);
    const reg2 = getRegistry();
    expect(reg2.find((d) => d.site === 'mutated')).toBeUndefined();
  });
});

describe('findAdapter', () => {
  it('returns undefined for unknown (site, name)', () => {
    expect(findAdapter('nope', 'nope')).toBeUndefined();
  });
});
