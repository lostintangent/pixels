import type { AutosaveClock } from './contracts';

export const realClock: AutosaveClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface AutosaveScheduler {
  /** Call on every dirty-rect notification. Schedules or reschedules a flush. */
  noteChange(): void;
  /** Cancels any pending flush without running it. */
  cancel(): void;
}

/**
 * Debounces flushes: each change resets a `debounceMs` timer, but the wait since the first
 * pending change is capped at `maxWaitMs`, so a continuous stroke still saves periodically.
 * Pure aside from the injected clock, so tests drive it without real timers.
 */
export function createAutosaveScheduler(
  onFlush: () => void,
  options: { debounceMs?: number; maxWaitMs?: number; clock?: AutosaveClock } = {},
): AutosaveScheduler {
  const debounceMs = options.debounceMs ?? 1000;
  const maxWaitMs = options.maxWaitMs ?? 5000;
  const clock = options.clock ?? realClock;
  let timer: unknown = null;
  let firstChangeAt: number | null = null;

  function scheduleFlushIn(delay: number): void {
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = null;
      firstChangeAt = null;
      onFlush();
    }, delay);
  }

  return {
    noteChange() {
      const now = clock.now();
      if (firstChangeAt === null) firstChangeAt = now;
      const remainingBeforeMaxWait = maxWaitMs - (now - firstChangeAt);
      scheduleFlushIn(Math.max(0, Math.min(debounceMs, remainingBeforeMaxWait)));
    },
    cancel() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      firstChangeAt = null;
    },
  };
}
