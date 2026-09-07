import { describe, it, expect, beforeAll } from 'vitest';
import { cli } from '../src/runtime/registry.js';
import { openAiToolsFromRegistry, lookupAdapter } from '../src/tools/manifest';

beforeAll(() => {
  cli({
    site: 'fooSite',
    name: 'do-thing',
    description: 'A test tool',
    args: [
      { name: 'q', required: true, help: 'query string' },
      { name: 'limit', type: 'int', default: 10, help: 'page size' },
      { name: 'flag', type: 'bool', help: 'a boolean' },
    ],
    func: async () => 'result',
  });
  cli({
    site: 'fooSite',
    name: 'no-args',
    description: 'No args at all',
    func: async () => 'ok',
  });
});

describe('openAiToolsFromRegistry', () => {
  it('emits one OpenAI function entry per registered adapter', () => {
    const tools = openAiToolsFromRegistry();
    const names = tools.map((t) => t.function.name);
    expect(names).toContain('fooSite__do-thing');
    expect(names).toContain('fooSite__no-args');
  });

  it('wraps each tool in {type: "function", function: {...}}', () => {
    const tools = openAiToolsFromRegistry();
    const tool = tools.find((t) => t.function.name === 'fooSite__do-thing')!;
    expect(tool.type).toBe('function');
    expect(tool.function.description).toBe('A test tool');
    expect(tool.function.parameters.type).toBe('object');
  });

  it('maps int → integer and bool → boolean in JSON schema', () => {
    const tools = openAiToolsFromRegistry();
    const tool = tools.find((t) => t.function.name === 'fooSite__do-thing')!;
    expect(tool.function.parameters.properties.q.type).toBe('string');
    expect(tool.function.parameters.properties.limit.type).toBe('integer');
    expect(tool.function.parameters.properties.flag.type).toBe('boolean');
  });

  it('only marks required: true args as required', () => {
    const tools = openAiToolsFromRegistry();
    const tool = tools.find((t) => t.function.name === 'fooSite__do-thing')!;
    expect(tool.function.parameters.required).toEqual(['q']);
  });

  it('produces an empty parameters block for arg-less adapters', () => {
    const tools = openAiToolsFromRegistry();
    const tool = tools.find((t) => t.function.name === 'fooSite__no-args')!;
    expect(tool.function.parameters.properties).toEqual({});
    expect(tool.function.parameters.required).toEqual([]);
  });
});

describe('lookupAdapter', () => {
  it('finds an adapter by its OpenAI tool name', () => {
    const a = lookupAdapter('fooSite__do-thing');
    expect(a?.site).toBe('fooSite');
    expect(a?.name).toBe('do-thing');
  });

  it('returns null for an unknown tool name', () => {
    expect(lookupAdapter('nope__x')).toBeNull();
  });

  it('returns null when the name has no __ separator', () => {
    expect(lookupAdapter('no_separator')).toBeNull();
  });

  it('handles dashes in command name (splits on first __ only)', () => {
    cli({ site: 'alpha', name: 'creator-notes', func: async () => 'x' });
    const a = lookupAdapter('alpha__creator-notes');
    expect(a?.name).toBe('creator-notes');
  });
});
