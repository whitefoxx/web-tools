/**
 * createIdleSweep (src/core/idle-sweep.ts) — "the bridge went quiet", the only
 * moment a shell without runs can tidy up. The debounce is the whole safety
 * argument: a sweep that fired in the GAP between two calls of one task would be
 * cleaning up under a working agent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createIdleSweep } from '../src/core/idle-sweep';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('idle sweep', () => {
  it('runs once the shell has been quiet for the full delay', async () => {
    const run = vi.fn(async () => {});
    const sweep = createIdleSweep(run, 1000);
    sweep.onCallStart();
    sweep.onCallEnd();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not fire in the gap between two calls of the same task', async () => {
    const run = vi.fn(async () => {});
    const sweep = createIdleSweep(run, 1000);
    for (let i = 0; i < 5; i++) {
      sweep.onCallStart();
      sweep.onCallEnd();
      await vi.advanceTimersByTimeAsync(500); // agent thinks, then calls again
    }
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending sweep when a call starts', async () => {
    const run = vi.fn(async () => {});
    const sweep = createIdleSweep(run, 1000);
    sweep.onCallEnd();
    await vi.advanceTimersByTimeAsync(900);
    sweep.onCallStart(); // a call arrived just before the sweep would have run
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });

  it('survives a sweep that throws and arms again next time', async () => {
    const run = vi.fn(async () => {
      throw new Error('a tab vanished mid-reap');
    });
    const sweep = createIdleSweep(run, 1000);
    sweep.onCallEnd();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    sweep.onCallEnd();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
