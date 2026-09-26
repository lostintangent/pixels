import { describe, expect, test } from 'bun:test';
import type { AutosaveClock } from './contracts';
import { createAutosaveScheduler } from './autosave';

interface PendingTimer {
  id: number;
  dueAt: number;
  callback: () => void;
}

/** A deterministic clock: advance(ms) fires every timer due within the advanced window, in order. */
function createManualClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, PendingTimer>();
  const clock: AutosaveClock = {
    now: () => now,
    setTimeout(callback, ms) {
      const id = nextId++;
      pending.set(id, { id, dueAt: now + ms, callback });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id as number);
    },
  };
  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      const due = [...pending.values()]
        .filter((t) => t.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt);
      if (due.length === 0) break;
      const next = due[0]!;
      pending.delete(next.id);
      now = next.dueAt;
      next.callback();
    }
    now = target;
  }
  return { clock, advance, pendingCount: () => pending.size };
}

describe('autosave scheduler', () => {
  test('flushes debounceMs after the last change', () => {
    const { clock, advance } = createManualClock();
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++, {
      debounceMs: 1000,
      maxWaitMs: 5000,
      clock,
    });
    scheduler.noteChange();
    advance(999);
    expect(flushes).toBe(0);
    advance(1);
    expect(flushes).toBe(1);
  });

  test('each change reschedules the debounce window', () => {
    const { clock, advance } = createManualClock();
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++, {
      debounceMs: 1000,
      maxWaitMs: 5000,
      clock,
    });
    scheduler.noteChange();
    advance(600);
    scheduler.noteChange(); // resets the 1000ms window
    advance(600);
    expect(flushes).toBe(0);
    advance(400);
    expect(flushes).toBe(1);
  });

  test('caps the total wait at maxWaitMs under continuous changes', () => {
    const { clock, advance } = createManualClock();
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++, {
      debounceMs: 1000,
      maxWaitMs: 5000,
      clock,
    });
    scheduler.noteChange();
    // A change every 400ms would perpetually postpone a plain debounce past 5s.
    for (let elapsed = 0; elapsed < 4800; elapsed += 400) {
      advance(400);
      scheduler.noteChange();
      expect(flushes).toBe(0);
    }
    advance(200); // total elapsed since first change is 5000ms
    expect(flushes).toBe(1);
  });

  test('cancel drops a pending flush', () => {
    const { clock, advance } = createManualClock();
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++, { clock });
    scheduler.noteChange();
    scheduler.cancel();
    advance(10_000);
    expect(flushes).toBe(0);
  });

  test('a change after a flush starts a fresh debounce window', () => {
    const { clock, advance } = createManualClock();
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++, {
      debounceMs: 1000,
      maxWaitMs: 5000,
      clock,
    });
    scheduler.noteChange();
    advance(1000);
    expect(flushes).toBe(1);
    scheduler.noteChange();
    advance(999);
    expect(flushes).toBe(1);
    advance(1);
    expect(flushes).toBe(2);
  });
});
