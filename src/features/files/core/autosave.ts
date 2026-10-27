const DEBOUNCE_MS = 1000;
const MAX_WAIT_MS = 5000;

export interface AutosaveScheduler {
  /** Call on every dirty-rect notification. Schedules or reschedules a flush. */
  noteChange(): void;
  /** Cancels any pending flush without running it. */
  cancel(): void;
}

/**
 * Debounces flushes: each change resets the timer, but the wait since the first pending change is
 * capped, so a continuous stroke still saves periodically.
 */
export function createAutosaveScheduler(onFlush: () => void): AutosaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstChangeAt: number | null = null;

  function scheduleFlushIn(delay: number): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      firstChangeAt = null;
      onFlush();
    }, delay);
  }

  return {
    noteChange() {
      const now = Date.now();
      if (firstChangeAt === null) firstChangeAt = now;
      const remainingBeforeMaxWait = MAX_WAIT_MS - (now - firstChangeAt);
      scheduleFlushIn(Math.max(0, Math.min(DEBOUNCE_MS, remainingBeforeMaxWait)));
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      firstChangeAt = null;
    },
  };
}
