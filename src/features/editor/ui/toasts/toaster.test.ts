import { describe, expect, test } from 'bun:test';
import type { ToastOptions } from '@astryxdesign/core/Toast';
import { createToaster } from './toaster';

const toast = (body: string): ToastOptions => ({ body });

function viewport() {
  const shown: string[] = [];
  const dismissed: string[] = [];
  const show = (options: ToastOptions) => {
    const body = options.body as string;
    shown.push(body);
    return () => void dismissed.push(body);
  };
  return { show, shown, dismissed };
}

describe('toaster', () => {
  test('shows directly once a viewport is attached', () => {
    const toaster = createToaster(() => {});
    const live = viewport();
    toaster.attach(live.show);
    toaster.show(toast('Saved'))();
    expect(live.shown).toEqual(['Saved']);
    expect(live.dismissed).toEqual(['Saved']);
  });

  test('every early toast asks for a viewport, so a failed load is retried', () => {
    let requests = 0;
    const toaster = createToaster(() => requests++);
    toaster.show(toast('One'));
    toaster.show(toast('Two'));
    toaster.attach(viewport().show);
    toaster.show(toast('Three'));
    expect(requests).toBe(2);
  });

  test('flushes early toasts in order when a viewport attaches', () => {
    const toaster = createToaster(() => {});
    toaster.show(toast('One'));
    toaster.show(toast('Two'));
    const live = viewport();
    toaster.attach(live.show);
    expect(live.shown).toEqual(['One', 'Two']);
  });

  test('drops an early toast dismissed before a viewport attaches', () => {
    const toaster = createToaster(() => {});
    const dismiss = toaster.show(toast('Stale'));
    toaster.show(toast('Fresh'));
    dismiss();
    const live = viewport();
    toaster.attach(live.show);
    expect(live.shown).toEqual(['Fresh']);
  });

  test('an early dismiss reaches the toast after it has shown', () => {
    const toaster = createToaster(() => {});
    const dismiss = toaster.show(toast('Not saved'));
    const live = viewport();
    toaster.attach(live.show);
    dismiss();
    expect(live.dismissed).toEqual(['Not saved']);
  });

  test('queues again after the viewport detaches', () => {
    const toaster = createToaster(() => {});
    const first = viewport();
    toaster.attach(first.show)();
    toaster.show(toast('Later'));
    expect(first.shown).toEqual([]);
    const second = viewport();
    toaster.attach(second.show);
    expect(second.shown).toEqual(['Later']);
  });
});
