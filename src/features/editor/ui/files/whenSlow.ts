export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Settles with `work`, calling `notify` only if it is still running after `delay` ms. The notice
 * is withdrawn when the work settles, before anything chained on the returned promise runs, so a
 * slow result never arrives behind its own notice. Each call owns its notice, so overlapping
 * calls never withdraw each other's.
 */
export function whenSlow<T>(
  work: Promise<T>,
  notify: () => () => void,
  delay: number,
  timers: Timers = realTimers,
): Promise<T> {
  let withdraw: (() => void) | undefined;
  const timer = timers.set(() => {
    withdraw = notify();
  }, delay);
  return work.finally(() => {
    timers.clear(timer);
    withdraw?.();
  });
}
