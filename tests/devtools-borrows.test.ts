/**
 * Unit coverage for the chrome-devtools-mcp borrows that have pure logic worth
 * pinning (docs/devtools-mcp-comparison.md §2): the screenshot encoding knobs,
 * the fill_form field parser, and the tool-profile filter.
 *
 * The in-page halves (canvas re-encode, the DOM fill, the WebMCP probe) need a
 * real browser and belong to docs/tests/platform.md, not here.
 */
import { describe, it, expect } from 'vitest';
import { resolveShotEncoding } from '../src/tools/generic/screenshot';
import { parseFields, groupByFrame } from '../src/tools/generic/fill-form';
import { isInProfile, coerceProfile, CORE_TOOLS } from '../src/core/tool-profile';

describe('screenshot — encoding knobs', () => {
  it('defaults to lossless png with no quality', () => {
    expect(resolveShotEncoding({})).toEqual({ format: 'png' });
  });

  it('rejects an unsupported format instead of silently substituting one', () => {
    // Same rule as web_search's `engine` (docs/webcli.md §2): a pin that is
    // quietly ignored teaches the caller a lie about what it captured.
    expect(() => resolveShotEncoding({ format: 'gif' })).toThrow(/unsupported format/i);
    expect(() => resolveShotEncoding({ format: 'gif' })).toThrow(/png, jpeg, webp/);
  });

  it('applies a quality default only for the lossy codecs', () => {
    expect(resolveShotEncoding({ format: 'jpeg' })).toEqual({ format: 'jpeg', quality: 80 });
    expect(resolveShotEncoding({ format: 'webp', quality: 40 })).toEqual({
      format: 'webp',
      quality: 40,
    });
    // png never carries one — canvas/CDP ignore it, and reporting it would imply
    // the capture was lossy.
    expect(resolveShotEncoding({ format: 'png', quality: 40 })).toEqual({ format: 'png' });
  });

  it('clamps quality into 1-100', () => {
    expect(resolveShotEncoding({ format: 'jpeg', quality: 0 }).quality).toBe(1);
    expect(resolveShotEncoding({ format: 'jpeg', quality: 999 }).quality).toBe(100);
    expect(resolveShotEncoding({ format: 'jpeg', quality: 'x' }).quality).toBe(80);
  });

  it('takes max_width but refuses a uselessly small or non-numeric one', () => {
    expect(resolveShotEncoding({ max_width: 1024 }).maxWidth).toBe(1024);
    expect(resolveShotEncoding({ max_width: '800' }).maxWidth).toBe(800);
    expect(resolveShotEncoding({}).maxWidth).toBeUndefined();
    expect(resolveShotEncoding({ max_width: '' }).maxWidth).toBeUndefined();
    expect(() => resolveShotEncoding({ max_width: 10 })).toThrow(/>= 64/);
    expect(() => resolveShotEncoding({ max_width: 'wide' })).toThrow(/>= 64/);
  });
});

describe('fill_form — field parsing', () => {
  it('accepts a JSON string (the documented form) and a decoded array alike', () => {
    const json = '[{"ref":"r3","value":"alice"},{"selector":"#pw","value":"x"}]';
    const fromString = parseFields(json);
    const fromArray = parseFields(JSON.parse(json));
    expect(fromString).toEqual(fromArray);
    expect(fromString).toEqual([
      { ref: 'r3', value: 'alice' },
      { selector: '#pw', value: 'x' },
    ]);
  });

  it('stringifies values so a number or a boolean survives the trip', () => {
    const [num, bool] = parseFields([
      { selector: '#qty', value: 3 },
      { selector: '#tos', value: true },
    ]);
    expect(num.value).toBe('3');
    expect(bool.value).toBe('true');
  });

  it('keeps "" (clear the field) but rejects a missing value', () => {
    expect(parseFields([{ selector: '#a', value: '' }])[0].value).toBe('');
    expect(() => parseFields([{ selector: '#a' }])).toThrow(/needs a "value"/);
    expect(() => parseFields([{ selector: '#a', value: null }])).toThrow(/needs a "value"/);
  });

  it('names the offending index when a field is unusable', () => {
    expect(() => parseFields([{ selector: '#a', value: '1' }, { value: '2' }])).toThrow(
      /fields\[1\] needs either "ref".*or "selector"/,
    );
    expect(() => parseFields(['nope'])).toThrow(/fields\[0\] must be an object/);
  });

  it('gives an example rather than a parser error on malformed JSON', () => {
    expect(() => parseFields('{ref:"r1"}')).toThrow(/must be a JSON array, e\.g\./);
    expect(() => parseFields('')).toThrow(/must not be empty/);
    expect(() => parseFields('[]')).toThrow(/must not be empty/);
    expect(() => parseFields('{"ref":"r1","value":"a"}')).toThrow(/JSON array of field objects/);
  });

  it('only sets append when it was asked for', () => {
    expect(parseFields([{ selector: '#a', value: 'x' }])[0].append).toBeUndefined();
    expect(parseFields([{ selector: '#a', value: 'x', append: true }])[0].append).toBe(true);
  });
});

describe('fill_form — frame grouping', () => {
  it('puts plain refs and selectors in the main frame', () => {
    const g = groupByFrame(parseFields([{ ref: 'r1', value: 'a' }, { selector: '#b', value: 'b' }]));
    expect([...g.keys()]).toEqual([0]);
    expect(g.get(0)).toHaveLength(2);
  });

  it('splits frame-scoped refs into one injection per frame', () => {
    // One executeScript per frame, not per field — the whole point of the tool.
    const g = groupByFrame(
      parseFields([
        { ref: 'f7r1', value: 'a' },
        { ref: 'r2', value: 'b' },
        { ref: 'f7r3', value: 'c' },
      ]),
    );
    expect([...g.keys()].sort()).toEqual([0, 7]);
    expect(g.get(7)).toHaveLength(2);
    expect(g.get(0)).toHaveLength(1);
  });

  it('preserves the caller order within a frame (submit targets the last field)', () => {
    const fields = parseFields([
      { selector: '#a', value: '1' },
      { selector: '#b', value: '2' },
      { selector: '#c', value: '3' },
    ]);
    expect(groupByFrame(fields).get(0)?.map((f) => f.selector)).toEqual(['#a', '#b', '#c']);
  });
});

describe('tool profiles', () => {
  it('full advertises everything', () => {
    expect(isInProfile('generic__drag_and_drop', 'full')).toBe(true);
    expect(isInProfile('anything__at_all', 'full')).toBe(true);
  });

  it('core keeps the drive-a-page loop and drops the long tail', () => {
    for (const n of ['open_url', 'get_page_text', 'click', 'type_into', 'fill_form']) {
      expect(isInProfile(`generic__${n}`, 'core'), n).toBe(true);
    }
    for (const n of ['drag_and_drop', 'file_upload', 'query_dom', 'hover', 'manage_tabs']) {
      expect(isInProfile(`generic__${n}`, 'core'), n).toBe(false);
    }
  });

  it('matches a bare name as well as a site__name id', () => {
    expect(isInProfile('click', 'core')).toBe(true);
    expect(isInProfile('generic__click', 'core')).toBe(true);
    expect(isInProfile('hover', 'core')).toBe(false);
  });

  it('treats anything that is not "core" as full', () => {
    // Storage can hold junk from an older build or a typo'd manual edit; the
    // failure mode must be "sees every tool", never "sees none".
    expect(coerceProfile(undefined)).toBe('full');
    expect(coerceProfile('slim')).toBe('full');
    expect(coerceProfile(0)).toBe('full');
    expect(coerceProfile('core')).toBe('core');
  });

  it('lists no duplicates', () => {
    expect(new Set(CORE_TOOLS).size).toBe(CORE_TOOLS.length);
  });
});
