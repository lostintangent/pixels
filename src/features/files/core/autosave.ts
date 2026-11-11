const DEBOUNCE_MS = 1000;
const MAX_WAIT_MS = 5000;

export interface AutosaveScheduler {
  /**
   * Call on every dirty-rect notification. Schedules or reschedules a flush. Pass `urgent` when
   * the pending ground has no crash-journal fallback (it's too big for `CRASH_RECOVERY_MAX_BYTES`):
   * the flush is scheduled at 0ms instead of the debounce. Urgency latches — once any call passes
   * `true`, the scheduled flush stays at 0ms even if a later call in the same window passes
   * `false` — since ground over that cap can only grow until a flush actually takes it.
   */
  noteChange(urgent?: boolean): void;
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
  let urgent = false;

  function scheduleFlushIn(delay: number): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      firstChangeAt = null;
      urgent = false;
      onFlush();
    }, delay);
  }

  return {
    noteChange(isUrgent = false) {
      urgent ||= isUrgent;
      if (urgent) {
        scheduleFlushIn(0);
        return;
      }
      const now = Date.now();
      if (firstChangeAt === null) firstChangeAt = now;
      const remainingBeforeMaxWait = MAX_WAIT_MS - (now - firstChangeAt);
      scheduleFlushIn(Math.max(0, Math.min(DEBOUNCE_MS, remainingBeforeMaxWait)));
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      firstChangeAt = null;
      urgent = false;
    },
  };
}
