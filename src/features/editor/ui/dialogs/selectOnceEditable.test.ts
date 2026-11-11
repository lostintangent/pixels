import { afterEach, beforeEach, expect, test } from 'bun:test';
import { selectOnceEditable } from './selectOnceEditable';

class FakeInput extends EventTarget {
  selections = 0;
  select() {
    this.selections++;
  }
}

const frames = new Map<number, () => void>();
let nextFrame = 0;
const saved = {
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  document: globalThis.document,
};

function runFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback();
}

function focus(): FakeInput {
  const input = new FakeInput();
  Object.assign(globalThis, { document: { activeElement: input } });
  selectOnceEditable({ currentTarget: input as unknown as HTMLInputElement });
  return input;
}

beforeEach(() => {
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
});

afterEach(() => {
  frames.clear();
  Object.assign(globalThis, saved);
});

test('selects the whole value on the next frame', () => {
  const input = focus();
  expect(input.selections).toBe(0);
  runFrames();
  expect(input.selections).toBe(1);
});

test('a key pressed before a late frame selects first, and the frame then does nothing', () => {
  const input = focus();
  input.dispatchEvent(new Event('keydown'));
  expect(input.selections).toBe(1);
  input.dispatchEvent(new Event('keydown'));
  runFrames();
  expect(input.selections).toBe(1);
});

test('a press inside the field or leaving it cancels the select', () => {
  for (const type of ['pointerdown', 'blur']) {
    const input = focus();
    input.dispatchEvent(new Event(type));
    runFrames();
    input.dispatchEvent(new Event('keydown'));
    expect(input.selections).toBe(0);
  }
});
