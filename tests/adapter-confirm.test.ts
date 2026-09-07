/**
 * needsConfirmation (④ sensitive-op gate): WRITE confirms unless auto-approve; a
 * `confirmBeforeUse` adapter ALWAYS confirms (even read, even auto). Pure; node.
 */

import { describe, it, expect } from 'vitest';
import { needsConfirmation } from '../src/tools/manifest';

describe('needsConfirmation (④)', () => {
  it('WRITE confirms, unless auto-approve is on', () => {
    expect(needsConfirmation({ access: 'write' }, false)).toBe(true);
    expect(needsConfirmation({ access: 'write' }, true)).toBe(false);
  });

  it('plain READ / unknown → no confirm', () => {
    expect(needsConfirmation({ access: 'read' }, false)).toBe(false);
    expect(needsConfirmation(undefined, false)).toBe(false);
  });

  it('confirmBeforeUse ALWAYS confirms — even a read, even in auto mode', () => {
    expect(needsConfirmation({ access: 'read', confirmBeforeUse: true }, false)).toBe(true);
    expect(needsConfirmation({ access: 'read', confirmBeforeUse: true }, true)).toBe(true);
    expect(needsConfirmation({ access: 'write', confirmBeforeUse: true }, true)).toBe(true);
  });
});
