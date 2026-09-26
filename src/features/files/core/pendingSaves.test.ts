import { describe, expect, test } from 'bun:test';
import { trackPendingSave, waitForPendingSave } from './pendingSaves';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('pendingSaves', () => {
  test('waiting for an id with no registered save resolves immediately', async () => {
    expect(await waitForPendingSave('nothing-pending')).toBeUndefined();
  });

  test('a wait started before the save resolves settles once the save resolves', async () => {
    const { promise, resolve } = deferred<void>();
    trackPendingSave('doc-a', promise);
    let settled = false;
    const wait = waitForPendingSave('doc-a').then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    resolve();
    await wait;
    expect(settled).toBe(true);
  });

  test('a rejected save does not make waitForPendingSave throw', async () => {
    const { promise, reject } = deferred<void>();
    trackPendingSave('doc-b', promise);
    reject(new Error('simulated write failure'));
    expect(await waitForPendingSave('doc-b')).toBeUndefined();
  });

  test('waiting for a different id is unaffected by another id’s pending save', async () => {
    const { promise } = deferred<void>();
    trackPendingSave('doc-c', promise);
    expect(await waitForPendingSave('doc-d')).toBeUndefined();
  });

  test('a settled entry is cleared, so a later wait for the same id does not hang on a stale promise', async () => {
    const { promise, resolve } = deferred<void>();
    trackPendingSave('doc-e', promise);
    resolve();
    await waitForPendingSave('doc-e');
    // A second, unrelated save for the same id registers cleanly; nothing from the first lingers.
    const { promise: second, resolve: resolveSecond } = deferred<void>();
    trackPendingSave('doc-e', second);
    let settled = false;
    const wait = waitForPendingSave('doc-e').then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    resolveSecond();
    await wait;
    expect(settled).toBe(true);
  });
});
