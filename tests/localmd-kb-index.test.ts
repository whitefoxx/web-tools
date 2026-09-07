/**
 * The browser learning what the knowledge base holds (docs/localmd-connect.md
 * §14.4g): the index key, and the `written` argument ack_inbox reads it from.
 */
import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('chrome', {
  tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
  windows: { onRemoved: { addListener: () => {} } },
  runtime: { getManifest: () => ({ name: 'localmd Connect' }) },
});

const { kbKey } = await import('../src/localmd-connect/kb-index');
const { parseWritten } = await import('../src/tools/generic/inbox');

describe('kbKey', () => {
  it('prefers the canonical URL, so two tracking URLs of one article are one note', () => {
    expect(kbKey('https://ex.test/a?utm=1', 'https://ex.test/a')).toBe('kbIndex:https://ex.test/a');
  });

  it('drops the fragment — the same page, whatever heading you landed on', () => {
    expect(kbKey('https://ex.test/a#sec')).toBe('kbIndex:https://ex.test/a');
  });

  it('ignores a canonical that is not an http(s) URL', () => {
    expect(kbKey('https://ex.test/a', 'not a url')).toBe('kbIndex:https://ex.test/a');
  });
});

describe('parseWritten', () => {
  it('reads {id, path} pairs from JSON or an array', () => {
    expect(parseWritten('[{"id":"a","path":"raw/x.md"}]')).toEqual([{ id: 'a', path: 'raw/x.md' }]);
    expect(parseWritten([{ id: 'a', path: ' raw/x.md ' }])).toEqual([
      { id: 'a', path: 'raw/x.md' },
    ]);
  });

  it('drops what it cannot use rather than failing the ack', () => {
    expect(parseWritten('not json')).toEqual([]);
    expect(parseWritten('')).toEqual([]);
    expect(parseWritten([{ id: 'a' }, { path: 'p' }, { id: 'b', path: '' }, 'junk'])).toEqual([]);
  });
});
