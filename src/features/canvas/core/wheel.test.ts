import { describe, expect, test } from 'bun:test';
import {
  WHEEL_STEP_MS,
  type WheelInput,
  type WheelState,
  initialWheelState,
  isMouseWheel,
  wheelIntent,
} from './wheel';

const wheel = (input: Partial<WheelInput>): WheelInput => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  zoomKey: false,
  shift: false,
  time: 0,
  ...input,
});

function spin(inputs: readonly Partial<WheelInput>[]) {
  let state: WheelState = initialWheelState;
  return inputs.map((input) => {
    const read = wheelIntent(state, wheel(input));
    state = read.state;
    return read.intent;
  });
}

describe('classification', () => {
  test('line and page deltas come from a mouse', () => {
    expect(isMouseWheel(wheel({ deltaY: 3, deltaMode: 1 }))).toBe(true);
    expect(isMouseWheel(wheel({ deltaY: 1, deltaMode: 2 }))).toBe(true);
  });

  test('whole legacy clicks come from a mouse', () => {
    expect(isMouseWheel(wheel({ deltaY: 100, legacyDeltaY: -120 }))).toBe(true);
    expect(isMouseWheel(wheel({ deltaY: -200, legacyDeltaY: 240 }))).toBe(true);
  });

  test('a trackpad reports exactly three times its pixel delta', () => {
    expect(isMouseWheel(wheel({ deltaY: 40, legacyDeltaY: -120 }))).toBe(false);
    expect(isMouseWheel(wheel({ deltaY: 2.5, legacyDeltaY: -7.5 }))).toBe(false);
  });

  test('horizontal or ambiguous pixel deltas are a trackpad', () => {
    expect(isMouseWheel(wheel({ deltaX: 4, deltaY: 100, legacyDeltaY: -120 }))).toBe(false);
    expect(isMouseWheel(wheel({ deltaY: 100 }))).toBe(false);
  });

  test('Ctrl with large whole deltas is a mouse, small ones are a pinch', () => {
    expect(isMouseWheel(wheel({ deltaY: 100, zoomKey: true }))).toBe(true);
    expect(isMouseWheel(wheel({ deltaY: 3.2, zoomKey: true }))).toBe(false);
  });
});

describe('intent', () => {
  test('a trackpad scroll pans with the content', () => {
    expect(spin([{ deltaX: 6, deltaY: -4 }])).toEqual([{ kind: 'pan', dx: -6, dy: 4 }]);
  });

  test('a trackpad pinch zooms in as its delta goes negative', () => {
    const [intent] = spin([{ deltaY: -10, zoomKey: true }]);
    expect(intent).toEqual({ kind: 'zoom', factor: Math.exp(0.1) });
  });

  test('each mouse click steps the zoom ladder toward the wheel direction', () => {
    expect(
      spin([
        { deltaY: -100, legacyDeltaY: 120, time: 0 },
        { deltaY: -100, legacyDeltaY: 120, time: 40 },
        { deltaY: 100, legacyDeltaY: -120, time: 400 },
      ]),
    ).toEqual([
      { kind: 'step', direction: 1 },
      { kind: 'step', direction: 1 },
      { kind: 'step', direction: -1 },
    ]);
  });

  test('a smooth wheel steps once per gathered delta while it spins', () => {
    const intents = spin(
      Array.from({ length: 8 }, (_, i) => ({ deltaY: 3, deltaMode: 1, time: i * 10 })),
    );
    expect(intents.map((intent) => intent.kind)).toEqual([
      'step',
      'none',
      'none',
      'step',
      'none',
      'none',
      'step',
      'none',
    ]);
  });

  test('a pause lets the next small click step at once', () => {
    const intents = spin([
      { deltaY: 1, deltaMode: 1, time: 0 },
      { deltaY: 1, deltaMode: 1, time: WHEEL_STEP_MS },
    ]);
    expect(intents.map((intent) => intent.kind)).toEqual(['step', 'step']);
  });

  test('Shift with a mouse wheel pans sideways', () => {
    expect(spin([{ deltaY: 3, deltaMode: 1, shift: true }])).toEqual([
      { kind: 'pan', dx: -48, dy: 0 },
    ]);
  });
});
