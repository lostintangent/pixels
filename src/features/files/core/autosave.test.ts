import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { createAutosaveScheduler } from './autosave';

describe('autosave scheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('flushes 1000ms after the last change', () => {
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++);
    scheduler.noteChange();
    jest.advanceTimersByTime(999);
    expect(flushes).toBe(0);
    jest.advanceTimersByTime(1);
    expect(flushes).toBe(1);
  });

  test('each change reschedules the debounce window', () => {
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++);
    scheduler.noteChange();
    jest.advanceTimersByTime(600);
    scheduler.noteChange(); // resets the 1000ms window
    jest.advanceTimersByTime(600);
    expect(flushes).toBe(0);
    jest.advanceTimersByTime(400);
    expect(flushes).toBe(1);
  });

  test('caps the total wait at 5000ms under continuous changes', () => {
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++);
    scheduler.noteChange();
    // A change every 400ms would perpetually postpone a plain debounce past 5s.
    for (let elapsed = 0; elapsed < 4800; elapsed += 400) {
      jest.advanceTimersByTime(400);
      scheduler.noteChange();
      expect(flushes).toBe(0);
    }
    jest.advanceTimersByTime(200); // total elapsed since first change is 5000ms
    expect(flushes).toBe(1);
  });

  test('cancel drops a pending flush', () => {
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++);
    scheduler.noteChange();
    scheduler.cancel();
    jest.advanceTimersByTime(10_000);
    expect(flushes).toBe(0);
  });

  test('a change after a flush starts a fresh debounce window', () => {
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++);
    scheduler.noteChange();
    jest.advanceTimersByTime(1000);
    expect(flushes).toBe(1);
    scheduler.noteChange();
    jest.advanceTimersByTime(999);
    expect(flushes).toBe(1);
    jest.advanceTimersByTime(1);
    expect(flushes).toBe(2);
  });

  test('an urgent change flushes at 0ms instead of waiting out the debounce', () => {
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++);
    scheduler.noteChange(true);
    jest.advanceTimersByTime(0);
    expect(flushes).toBe(1);
  });

  test('urgency latches: a later non-urgent call never pushes an urgent flush back to the debounce', () => {
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++);
    scheduler.noteChange(true);
    scheduler.noteChange(); // must not demote the already-urgent flush back to 1000ms
    jest.advanceTimersByTime(0);
    expect(flushes).toBe(1);
  });

  test('cancel drops a pending urgent flush too', () => {
    let flushes = 0;
    const scheduler = createAutosaveScheduler(() => flushes++);
    scheduler.noteChange(true);
    scheduler.cancel();
    jest.advanceTimersByTime(10_000);
    expect(flushes).toBe(0);
    // A later, non-urgent change starts a fresh, ordinary debounce — cancel() must not leave the
    // scheduler permanently urgent.
    scheduler.noteChange();
    jest.advanceTimersByTime(999);
    expect(flushes).toBe(0);
    jest.advanceTimersByTime(1);
    expect(flushes).toBe(1);
  });
});
