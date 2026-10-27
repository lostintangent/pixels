import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { whenSlow } from './whenSlow';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function notices() {
  const log: string[] = [];
  const notify = (name: string) => () => {
    log.push(`show ${name}`);
    return () => void log.push(`hide ${name}`);
  };
  return { log, notify };
}

describe('whenSlow', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('fast work shows nothing, even after the delay', async () => {
    const { log, notify } = notices();
    const work = deferred<string>();
    const result = whenSlow(work.promise, notify('export'), 500);
    work.resolve('bytes');
    expect(await result).toBe('bytes');
    jest.advanceTimersByTime(500);
    expect(log).toEqual([]);
  });

  test('slow work shows its notice and withdraws it before the result is used', async () => {
    const { log, notify } = notices();
    const work = deferred<string>();
    const delivered = whenSlow(work.promise, notify('export'), 500).then((bytes) => {
      log.push(`deliver ${bytes}`);
    });
    jest.advanceTimersByTime(499);
    expect(log).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(log).toEqual(['show export']);
    work.resolve('bytes');
    await delivered;
    expect(log).toEqual(['show export', 'hide export', 'deliver bytes']);
  });

  test('a failure withdraws the notice before the error is reported', async () => {
    const { log, notify } = notices();
    const work = deferred<string>();
    const reported = whenSlow(work.promise, notify('export'), 500).catch(
      (error: Error) => void log.push(`fail ${error.message}`),
    );
    jest.advanceTimersByTime(500);
    work.reject(new Error('encoder'));
    await reported;
    expect(log).toEqual(['show export', 'hide export', 'fail encoder']);
  });

  test('overlapping work withdraws only its own notice', async () => {
    const { log, notify } = notices();
    const first = deferred<string>();
    const second = deferred<string>();
    const a = whenSlow(first.promise, notify('first'), 500);
    jest.advanceTimersByTime(500);
    const b = whenSlow(second.promise, notify('second'), 500);
    jest.advanceTimersByTime(500);
    expect(log).toEqual(['show first', 'show second']);
    second.resolve('two');
    await b;
    expect(log).toEqual(['show first', 'show second', 'hide second']);
    first.resolve('one');
    await a;
    expect(log).toEqual(['show first', 'show second', 'hide second', 'hide first']);
  });
});
