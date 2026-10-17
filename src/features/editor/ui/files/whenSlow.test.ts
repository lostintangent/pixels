import { describe, expect, test } from 'bun:test';
import { whenSlow } from './whenSlow';
import type { Timers } from './whenSlow';

function clock() {
  let next = 0;
  const pending = new Map<number, () => void>();
  const timers: Timers = {
    set(callback) {
      pending.set(++next, callback);
      return next;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  const elapse = () => {
    const due = [...pending.values()];
    pending.clear();
    for (const callback of due) callback();
  };
  return { timers, elapse, pending };
}

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
  test('fast work shows nothing', async () => {
    const { timers, pending } = clock();
    const { log, notify } = notices();
    const work = deferred<string>();
    const result = whenSlow(work.promise, notify('export'), 500, timers);
    work.resolve('bytes');
    expect(await result).toBe('bytes');
    expect(log).toEqual([]);
    expect(pending.size).toBe(0);
  });

  test('slow work shows its notice and withdraws it before the result is used', async () => {
    const { timers, elapse } = clock();
    const { log, notify } = notices();
    const work = deferred<string>();
    const delivered = whenSlow(work.promise, notify('export'), 500, timers).then((bytes) => {
      log.push(`deliver ${bytes}`);
    });
    elapse();
    expect(log).toEqual(['show export']);
    work.resolve('bytes');
    await delivered;
    expect(log).toEqual(['show export', 'hide export', 'deliver bytes']);
  });

  test('a failure withdraws the notice before the error is reported', async () => {
    const { timers, elapse } = clock();
    const { log, notify } = notices();
    const work = deferred<string>();
    const reported = whenSlow(work.promise, notify('export'), 500, timers).catch(
      (error: Error) => void log.push(`fail ${error.message}`),
    );
    elapse();
    work.reject(new Error('encoder'));
    await reported;
    expect(log).toEqual(['show export', 'hide export', 'fail encoder']);
  });

  test('a notice closed by hand still lets the result arrive', async () => {
    const { timers, elapse } = clock();
    let shown = 0;
    const work = deferred<string>();
    const result = whenSlow(
      work.promise,
      () => {
        shown++;
        return () => {};
      },
      500,
      timers,
    );
    elapse();
    work.resolve('bytes');
    expect(await result).toBe('bytes');
    expect(shown).toBe(1);
  });

  test('overlapping work withdraws only its own notice', async () => {
    const { timers, elapse } = clock();
    const { log, notify } = notices();
    const first = deferred<string>();
    const second = deferred<string>();
    const a = whenSlow(first.promise, notify('first'), 500, timers);
    elapse();
    const b = whenSlow(second.promise, notify('second'), 500, timers);
    elapse();
    expect(log).toEqual(['show first', 'show second']);
    second.resolve('two');
    await b;
    expect(log).toEqual(['show first', 'show second', 'hide second']);
    first.resolve('one');
    await a;
    expect(log).toEqual(['show first', 'show second', 'hide second', 'hide first']);
  });
});
