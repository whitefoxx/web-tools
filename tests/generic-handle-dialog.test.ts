// @vitest-environment jsdom
/**
 * handle_dialog — installDialogHandler overrides window.alert/confirm/prompt in
 * the page's MAIN world to auto-answer (so a blocking confirm() can't deadlock
 * the agent). Tested under jsdom by installing on the jsdom window and then
 * invoking the dialogs. (The MAIN-world injection itself is real-browser-only.)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { installDialogHandler } from '../src/tools/generic/handle-dialog';

afterEach(() => {
  // Restore so cases don't leak overrides into each other.
  installDialogHandler('disarm', null);
});

describe('installDialogHandler', () => {
  it('accept → confirm true, prompt returns default, logs each dialog', () => {
    const armed = installDialogHandler('accept', null);
    expect(armed.armed).toBe(true);
    expect(armed.action).toBe('accept');
    expect(window.confirm('delete?')).toBe(true);
    expect(window.prompt('name?', 'def')).toBe('def');
    window.alert('hi');
    // state accumulates on window; re-arm reads the running log
    const again = installDialogHandler('accept', null);
    expect(again.handled).toBe(3);
    expect(again.dialogs.map((d) => d.type)).toEqual(['confirm', 'prompt', 'alert']);
    expect(again.dialogs[0].message).toBe('delete?');
  });

  it('accept with prompt_text overrides the default', () => {
    installDialogHandler('accept', 'typed value');
    expect(window.prompt('name?', 'def')).toBe('typed value');
  });

  it('dismiss → confirm false, prompt null', () => {
    installDialogHandler('dismiss', null);
    expect(window.confirm('sure?')).toBe(false);
    expect(window.prompt('name?', 'def')).toBeNull();
  });

  it('disarm restores originals and reports the final log', () => {
    installDialogHandler('accept', null);
    window.confirm('x');
    const off = installDialogHandler('disarm', null);
    expect(off.armed).toBe(false);
    expect(off.handled).toBe(1);
    // after disarm, our override is gone → confirm no longer force-returns our
    // armed value (jsdom's native confirm returns undefined, not true).
    expect(window.confirm('y')).not.toBe(true);
  });
});
