/*
 * Wheel input reads as one of three intents. A mouse wheel steps the zoom ladder at the cursor.
 * A trackpad scroll pans. A trackpad pinch, which browsers report as a wheel with Ctrl held,
 * zooms freely and settles onto the ladder afterward.
 *
 * Browsers don't say which device sent a wheel, so the classifier only reports a mouse on strong
 * evidence. A mouse misread as a trackpad pans, which is harmless. A trackpad misread as a mouse
 * would zoom on every scroll.
 */

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  /** Ctrl or Cmd, which trackpad pinches also report. */
  zoomKey: boolean;
  shift: boolean;
  /** The legacy `wheelDeltaY`, when the browser still reports it. */
  legacyDeltaY?: number;
  /** Milliseconds on a monotonic clock. */
  time: number;
}

export type WheelIntent =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; factor: number }
  | { kind: 'step'; direction: -1 | 1 }
  | { kind: 'none' };

export interface WheelState {
  /** Pixel delta gathered toward the next zoom step. */
  readonly pending: number;
  readonly lastStepAt: number;
}

export const initialWheelState: WheelState = { pending: 0, lastStepAt: -Infinity };

/** A pause this long makes the next wheel click step at once. */
export const WHEEL_STEP_MS = 150;
/** Gathered delta that makes one step during a continuous spin. */
export const WHEEL_STEP_DELTA = 100;
const LINE_PX = 16;
const PAGE_PX = 800;

export function wheelIntent(
  state: WheelState,
  input: WheelInput,
): { state: WheelState; intent: WheelIntent } {
  const scale = input.deltaMode === 1 ? LINE_PX : input.deltaMode === 2 ? PAGE_PX : 1;
  const dx = input.deltaX * scale;
  const dy = input.deltaY * scale;
  const mouse = isMouseWheel(input);

  if (mouse && input.shift && !input.zoomKey)
    return { state, intent: { kind: 'pan', dx: -(dx || dy), dy: 0 } };
  if (mouse) return stepped(state, dy, input.time);
  if (input.zoomKey) return { state, intent: { kind: 'zoom', factor: Math.exp(-dy * 0.01) } };
  return { state, intent: { kind: 'pan', dx: -dx, dy: -dy } };
}

export function isMouseWheel(input: WheelInput): boolean {
  if (input.deltaMode !== 0) return true;
  if (input.deltaX !== 0) return false;
  const legacy = input.legacyDeltaY;
  // Mouse clicks report whole 120ths. Trackpads report exactly three times the pixel delta.
  if (legacy && legacy % 120 === 0 && legacy !== -3 * input.deltaY) return true;
  // Ctrl with a mouse wheel sends large whole deltas. A pinch streams small fractional ones.
  return input.zoomKey && Math.abs(input.deltaY) >= 50 && Number.isInteger(input.deltaY);
}

/** One step per click, at most one per gathered 100 px while a smooth wheel spins. */
function stepped(
  state: WheelState,
  dy: number,
  time: number,
): { state: WheelState; intent: WheelIntent } {
  if (dy === 0) return { state, intent: { kind: 'none' } };
  const direction = dy < 0 ? 1 : -1;
  const reversed = state.pending !== 0 && Math.sign(state.pending) !== Math.sign(dy);
  const pending = (reversed ? 0 : state.pending) + dy;
  if (time - state.lastStepAt < WHEEL_STEP_MS && Math.abs(pending) < WHEEL_STEP_DELTA)
    return { state: { ...state, pending }, intent: { kind: 'none' } };
  return { state: { pending: 0, lastStepAt: time }, intent: { kind: 'step', direction } };
}
