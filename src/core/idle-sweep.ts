/**
 * "The bridge went quiet" — the one moment a shell without runs can safely tidy
 * up after itself.
 *
 * An in-extension agent has a run end: a task finishes, and everything it opened
 * along the way can go. A shell that only serves an EXTERNAL agent has no such
 * boundary — calls arrive one at a time with nothing marking the last one — so
 * the closest honest signal is that nothing has been asked of it for a while.
 *
 * Debounced and cancelled while a call is in flight, so the sweep fires only
 * when the shell is truly idle rather than in the gap between two calls of the
 * same task. Nothing here decides WHAT gets swept: a shell hands in the work it
 * considers safe at that moment, which is never a tab the calling agent still
 * holds a handle to (those are the caller's, by contract).
 *
 * The timer is a plain `setTimeout`, which dies with the service worker — on
 * purpose. A sweep that has to survive an MV3 recycle would need `alarms`, a
 * permission the shipping localmd Connect manifest deliberately does not ask
 * for; and a missed sweep is a leftover tab, while a wrongly-granted permission
 * is forever.
 */

export interface IdleSweep {
  /** A call started — cancel any pending sweep. */
  onCallStart(): void;
  /** A call finished — (re)arm the sweep. */
  onCallEnd(): void;
}

export function createIdleSweep(run: () => Promise<unknown>, idleMs: number): IdleSweep {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    onCallStart: cancel,
    onCallEnd() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        void run().catch(() => {
          /* best-effort — the next quiet moment tries again */
        });
      }, idleMs);
    },
  };
}
