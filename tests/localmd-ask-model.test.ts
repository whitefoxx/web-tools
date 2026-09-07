/**
 * The selection bar's quick actions, answered by localmd's model over the
 * reverse direction of the MCP relay (docs/localmd-connect.md §14.4o).
 *
 * The wire shapes and the wake-the-app retry are the parts worth pinning: the
 * UI is a real-browser check, but "no localmd tab is open" is the NORMAL state
 * for somebody reading an article, so the recovery is the feature.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/tools/manifest', () => ({ openAiToolsFromRegistry: () => [] }));

import { NO_CLIENT_MESSAGE } from '../src/core/external-mcp-core';
import {
  SAMPLING_METHOD,
  askModelViaApp,
  isNoClient,
  samplingParams,
  samplingText,
  wakeApp,
} from '../src/localmd-connect/ask-model';

const ask = {
  prompt: 'Translate the following into English. Output only the translation: "这是一段话"',
  label: 'Translate',
  url: 'https://a.test/post',
};

describe('samplingParams', () => {
  it('sends the message as written, and says who is asking', () => {
    const p = samplingParams(ask) as {
      messages: Array<{ role: string; content: { type: string; text: string } }>;
      systemPrompt: string;
      maxTokens: number;
      metadata: Record<string, unknown>;
    };
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].role).toBe('user');
    // Verbatim. The page has already put the template and the passage together
    // (fillPromptTemplate), and a second layer of framing here would quietly
    // break the promise the help makes about what gets sent.
    expect(p.messages[0].content.text).toBe(ask.prompt);
    expect(p.systemPrompt).toMatch(/text-selection assistant/);
    expect(p.maxTokens).toBeGreaterThan(0);
    expect(p.metadata).toMatchObject({
      source: 'localmd-connect/selection',
      action: 'Translate',
      url: 'https://a.test/post',
    });
  });

  it('leaves out what it was not told, rather than sending empty strings', () => {
    const p = samplingParams({ prompt: 'p' }) as { metadata: Record<string, unknown> };
    expect(p.metadata).toEqual({ source: 'localmd-connect/selection' });
  });
});

describe('samplingText', () => {
  it('reads the spec shape and the array one clients also send', () => {
    expect(samplingText({ content: { type: 'text', text: ' hi ' } })).toBe('hi');
    expect(
      samplingText({
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', data: 'x' },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toBe('one\ntwo');
  });

  it('answers empty for anything with no text in it, rather than "undefined"', () => {
    expect(samplingText(null)).toBe('');
    expect(samplingText({})).toBe('');
    expect(samplingText({ content: { type: 'image', data: 'x' } })).toBe('');
  });

  it('caps what the popover has to hold', () => {
    const out = samplingText({ content: { type: 'text', text: 'z'.repeat(30_000) } });
    expect(out.length).toBeLessThan(30_000);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('askModelViaApp', () => {
  const reply = { content: { type: 'text', text: 'the answer' } };

  it('asks once and returns the text', async () => {
    const request = vi.fn().mockResolvedValue(reply);
    const wakeApp = vi.fn();
    const r = await askModelViaApp({ request, wakeApp }, ask);
    expect(r).toEqual({ ok: true, result: 'the answer' });
    expect(request).toHaveBeenCalledWith(SAMPLING_METHOD, expect.any(Object));
    expect(wakeApp).not.toHaveBeenCalled();
  });

  it('opens localmd and asks again when no page was listening', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error(NO_CLIENT_MESSAGE))
      .mockResolvedValueOnce(reply);
    const wakeApp = vi.fn().mockResolvedValue(undefined);
    const r = await askModelViaApp({ request, wakeApp }, ask);
    expect(r).toEqual({ ok: true, result: 'the answer' });
    expect(wakeApp).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('says something a reader can act on when the app never turns up', async () => {
    const request = vi.fn().mockRejectedValue(new Error(NO_CLIENT_MESSAGE));
    const r = await askModelViaApp({ request, wakeApp: vi.fn().mockResolvedValue(undefined) }, ask);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('Open it in a tab') });
  });

  it('does not retry a failure that opening a tab cannot fix', async () => {
    // "No model is configured" comes back from a page that IS connected.
    // Waking another one would ask the same question of the same settings.
    const request = vi.fn().mockRejectedValue(new Error('No model is configured in localmd'));
    const wakeApp = vi.fn();
    const r = await askModelViaApp({ request, wakeApp }, ask);
    expect(r).toEqual({ ok: false, error: 'No model is configured in localmd' });
    expect(wakeApp).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports an empty answer as a failure, not as a blank popover', async () => {
    const request = vi.fn().mockResolvedValue({ content: { type: 'text', text: '   ' } });
    const r = await askModelViaApp({ request, wakeApp: vi.fn() }, ask);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('no text') });
  });

  it('carries a failure from waking the app through, rather than reporting silence', async () => {
    const request = vi.fn().mockRejectedValue(new Error(NO_CLIENT_MESSAGE));
    const wakeApp = vi.fn().mockRejectedValue(new Error('localmd opened but did not connect'));
    const r = await askModelViaApp({ request, wakeApp }, ask);
    expect(r).toEqual({ ok: false, error: 'localmd opened but did not connect' });
  });
});

describe('isNoClient', () => {
  it('tells the recoverable failure from every other one', () => {
    expect(isNoClient(new Error(NO_CLIENT_MESSAGE))).toBe(true);
    expect(isNoClient(new Error('sampling/createMessage got no answer in 120s'))).toBe(false);
    expect(isNoClient(NO_CLIENT_MESSAGE)).toBe(false); // a string is not the error
  });
});

/**
 * Getting a localmd to listen. The case that matters is NOT "none is open" —
 * that opens a tab and works. It is a localmd that is **open and not
 * connected**, which is what every extension reload leaves behind: the port
 * dies, the app's row goes to error, the relay heals itself, and the app never
 * finds out because a client is what starts an MCP conversation. Reported from
 * real use on 2026-09-05 as "localmd opened but did not connect in time".
 */
describe('wakeApp', () => {
  const connected = () => Promise.resolve();
  const silent = () => Promise.reject(new Error('no handshake'));

  it('nudges a tab that was already there — the reload case', async () => {
    const nudge = vi.fn().mockResolvedValue(undefined);
    await wakeApp({
      ensureTab: async () => ({ tabId: 7, opened: false }),
      nudge,
      waitForClient: connected,
    });
    expect(nudge).toHaveBeenCalledWith(7);
  });

  it('does not nudge a tab it just opened — that one is already loading', async () => {
    const nudge = vi.fn();
    await wakeApp({
      ensureTab: async () => ({ tabId: 8, opened: true }),
      nudge,
      waitForClient: connected,
    });
    expect(nudge).not.toHaveBeenCalled();
  });

  it('names the manual fix when a tab that was open still will not talk', async () => {
    await expect(
      wakeApp({
        ensureTab: async () => ({ tabId: 9, opened: false }),
        nudge: vi.fn().mockResolvedValue(undefined),
        waitForClient: silent,
      }),
    ).rejects.toThrow(/switch to its tab once, or reload it/);
  });

  it('says something different when the tab is one it just opened', async () => {
    await expect(
      wakeApp({
        ensureTab: async () => ({ tabId: 10, opened: true }),
        nudge: vi.fn(),
        waitForClient: silent,
      }),
    ).rejects.toThrow(/opened but did not connect in time/);
  });

  it('still waits when the nudge itself fails — the injection is an optimisation', async () => {
    const waitForClient = vi.fn().mockResolvedValue(undefined);
    await wakeApp({
      ensureTab: async () => ({ tabId: 11, opened: false }),
      nudge: vi.fn().mockRejectedValue(new Error('cannot inject here')),
      waitForClient,
    });
    expect(waitForClient).toHaveBeenCalled();
  });
});
