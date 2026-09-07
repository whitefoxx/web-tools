/**
 * `preview_site_script { dry_run_js }` reporting the truth about what happened
 * (findings F-54). The world it injects into forbids eval, so a syntax error
 * cannot be caught from inside the injected code — it takes the wrapper's own
 * try/catch down with it and Chrome hands back nothing. Answering `ran: true`
 * to that is a failure dressed as a success.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let executeResult: unknown;
let executeThrows: Error | null = null;

vi.stubGlobal('chrome', {
  userScripts: {
    execute: async () => {
      if (executeThrows) throw executeThrows;
      return executeResult;
    },
    configureWorld: async () => {},
    register: async () => {},
    getScripts: async () => [],
  },
  storage: { onChanged: { addListener: () => {} } },
});

const { dryRunSiteScriptJs } = await import('../src/site-scripts/register');

beforeEach(() => {
  executeThrows = null;
});

describe('dryRunSiteScriptJs', () => {
  it('passes through logs and the return value of code that ran', async () => {
    executeResult = [{ result: { ok: true, returnValue: 42, logs: ['log: hi'] } }];
    const r = await dryRunSiteScriptJs(1, 'console.log("hi"); return 42;');
    expect(r).toMatchObject({ ran: true, returnValue: 42, logs: ['log: hi'] });
    expect(r.error).toBeUndefined();
  });

  it('passes through a RUNTIME error, which the wrapper does catch', async () => {
    executeResult = [{ result: { ok: false, error: 'boom @ <anonymous>:2:7', logs: [] } }];
    const r = await dryRunSiteScriptJs(1, 'throw new Error("boom")');
    expect(r.ran).toBe(true);
    expect(r.error).toMatch(/boom/);
  });

  it('reports a PARSE failure as not having run, and says what to look for', async () => {
    // What Chrome hands back when the injected code cannot be parsed: a frame
    // with no result and no error of its own.
    executeResult = [{ result: undefined }];
    const r = await dryRunSiteScriptJs(1, 'const x = await 1;');
    expect(r.ran).toBe(false);
    expect(r.error).toMatch(/could not be parsed/);
    // The trap that produces this most often, named so nobody has to guess.
    expect(r.error).toMatch(/top-level `await`/);
  });

  it('treats a missing frame the same way', async () => {
    executeResult = [];
    expect((await dryRunSiteScriptJs(1, 'x')).ran).toBe(false);
  });

  it('reports the frame error when Chrome gives one', async () => {
    executeResult = [{ error: 'target frame gone' }];
    const r = await dryRunSiteScriptJs(1, 'x');
    expect(r).toMatchObject({ ran: false, error: 'target frame gone' });
  });

  it('reports a thrown execute() as not run', async () => {
    executeThrows = new Error('no such tab');
    const r = await dryRunSiteScriptJs(1, 'x');
    expect(r).toMatchObject({ ran: false, error: 'no such tab' });
  });
});
