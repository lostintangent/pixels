import type { DocumentPoint, ScreenPoint, Viewport } from './contracts';
import { clampZoom, screenToDocument } from './viewport';

/*
 * Pointer gesture recognition as a pure transition over pointer events.
 *
 * One mouse button, pen, or finger draws. Middle button, held space, or a finger once a pen has
 * been seen pans. Two fingers pinch, which zooms and pans at once. A quick two-finger tap undoes
 * and a three-finger tap redoes. A pen always wins over fingers, so a resting palm never blocks
 * or interrupts it. The canvas surface feeds events in and performs the returned commands.
 */

export type PointerKind = 'mouse' | 'pen' | 'touch';

export interface GesturePointer {
  id: number;
  kind: PointerKind;
  point: ScreenPoint;
  /** Milliseconds on a monotonic clock. */
  time: number;
}

export type GestureEvent =
  | { type: 'down'; pointer: GesturePointer; button: number; space: boolean }
  | { type: 'move'; pointer: GesturePointer; buttons?: number }
  | { type: 'up'; pointer: GesturePointer; cancelled: boolean }
  | { type: 'escape' };

/** What the surface should do. `begin` and `extend` apply to the event's own pointer samples. */
export type GestureCommand =
  | { type: 'begin' }
  | { type: 'extend' }
  | { type: 'end' }
  | { type: 'cancel' }
  | { type: 'view'; viewport: Viewport }
  /** Ease a free zoom to rest around `at`. `start` is the view the pinch began from. */
  | { type: 'settle'; at: ScreenPoint; start: Viewport }
  | { type: 'undo' }
  | { type: 'redo' };

export interface GestureState {
  readonly mode: Mode;
  /** Once a pen draws, fingers only navigate. */
  readonly penSeen: boolean;
  /** Pointers that stay inert until they lift, such as a palm under a pen. */
  readonly ignored: ReadonlySet<number>;
}

interface GestureStep {
  state: GestureState;
  commands: readonly GestureCommand[];
}

/** A touch that turns into a pinch within this window leaves no pixel behind. */
export const STRAY_MS = 250;
/** Every finger of a tap lands and lifts within this window. */
export const TAP_MS = 300;
/** Movement in CSS pixels that turns a tap into a pinch. */
const TAP_SLOP = 10;

type Mode = Idle | Draw | Pan | Pinch;

interface Idle {
  kind: 'idle';
}

interface Draw {
  kind: 'draw';
  id: number;
  pointer: PointerKind;
  origin: ScreenPoint;
  point: ScreenPoint;
  startedAt: number;
  moved: boolean;
}

interface Pan {
  kind: 'pan';
  id: number;
  pointer: PointerKind;
  origin: ScreenPoint;
  point: ScreenPoint;
  startedAt: number;
  moved: boolean;
  view: Viewport;
}

interface Finger {
  id: number;
  origin: ScreenPoint;
  point: ScreenPoint;
}

interface Pinch {
  kind: 'pinch';
  /** The two fingers whose span and midpoint drive the view. */
  a: Finger;
  b: Finger;
  /** Every finger of this gesture still down, including the pair. */
  touches: ReadonlySet<number>;
  /** Most fingers down at once, which picks undo or redo. */
  fingers: number;
  /** When the first finger landed. */
  startedAt: number;
  /** Still a candidate for a tap: nothing moved and nothing committed. */
  tap: boolean;
  view: Viewport;
  distance: number;
  /** Document point under the starting midpoint. It stays under the fingers. */
  anchor: DocumentPoint;
  latest: ScreenPoint;
}

const IDLE: Idle = { kind: 'idle' };
const NONE: readonly GestureCommand[] = [];
const BEGIN: readonly GestureCommand[] = [{ type: 'begin' }];
const EXTEND: readonly GestureCommand[] = [{ type: 'extend' }];
const END: readonly GestureCommand[] = [{ type: 'end' }];
const CANCEL: readonly GestureCommand[] = [{ type: 'cancel' }];
const NO_POINTERS: ReadonlySet<number> = new Set();

export const initialGestureState: GestureState = {
  mode: IDLE,
  penSeen: false,
  ignored: NO_POINTERS,
};

export function stepGesture(state: GestureState, event: GestureEvent, view: Viewport): GestureStep {
  switch (event.type) {
    case 'down':
      return pointerDown(state, event, view);
    case 'move':
      // A lost mouseup (for example while the window is blurred) must not turn hover into ink.
      if (event.pointer.kind === 'mouse' && event.buttons === 0)
        return pointerUp(state, event.pointer, false);
      return pointerMove(state, event.pointer, view);
    case 'up':
      return pointerUp(state, event.pointer, event.cancelled);
    case 'escape':
      return escape(state);
  }
}

/** Whether the view is under a pan or pinch, so hover and the brush cursor should step aside. */
export function isNavigating(state: GestureState): boolean {
  return state.mode.kind === 'pan' || state.mode.kind === 'pinch';
}

/** The session can finish a held draw when a dialog opens, while the pointer machine still owns it. */
export function wasDrawFinishedExternally(
  state: GestureState,
  beganInSession: boolean,
  sessionActive: boolean,
): boolean {
  return state.mode.kind === 'draw' && beganInSession && !sessionActive;
}

function pointerDown(
  state: GestureState,
  event: Extract<GestureEvent, { type: 'down' }>,
  view: Viewport,
): GestureStep {
  const { pointer, button, space } = event;
  const { mode } = state;

  if (pointer.kind === 'touch') {
    if (state.ignored.size > 0 || (mode.kind !== 'idle' && touchless(mode)))
      return { state: ignore(state, pointer.id), commands: NONE };
    if (mode.kind === 'idle') {
      if (state.penSeen) return { state: { ...state, mode: pan(pointer, view) }, commands: NONE };
      return { state: { ...state, mode: draw(pointer) }, commands: BEGIN };
    }
    if (mode.kind === 'pinch') {
      const touches = new Set(mode.touches).add(pointer.id);
      const tap = mode.tap && pointer.time - mode.startedAt <= TAP_MS;
      const fingers = Math.max(mode.fingers, touches.size);
      return { state: { ...state, mode: { ...mode, touches, tap, fingers } }, commands: NONE };
    }
    return beginPinch(state, mode, pointer, view);
  }

  // A pen takes over from any fingers, so a palm that landed first never blocks it.
  let next = state;
  let commands: readonly GestureCommand[] = NONE;
  if (pointer.kind === 'pen') {
    next = { ...state, penSeen: true };
    if (mode.kind !== 'idle' && !touchless(mode))
      ({ state: next, commands } = yieldToPen(next, pointer.time));
  }
  if (next.mode.kind !== 'idle') return { state: next, commands };
  if (button === 1 || (button === 0 && space))
    return { state: { ...next, mode: pan(pointer, view) }, commands };
  if (button !== 0) return { state: next, commands };
  return { state: { ...next, mode: draw(pointer) }, commands: [...commands, ...BEGIN] };
}

function pointerMove(state: GestureState, pointer: GesturePointer, view: Viewport): GestureStep {
  const { mode } = state;
  if (mode.kind === 'draw' && mode.id === pointer.id) {
    if (mode.pointer !== 'touch') return { state, commands: EXTEND };
    const moved = mode.moved || beyond(mode.origin, pointer.point);
    return {
      state: { ...state, mode: { ...mode, point: pointer.point, moved } },
      commands: EXTEND,
    };
  }
  if (mode.kind === 'pan' && mode.id === pointer.id) {
    const moved = mode.moved || beyond(mode.origin, pointer.point);
    const panned: Viewport = {
      ...mode.view,
      panX: Math.round(mode.view.panX + pointer.point.x - mode.origin.x),
      panY: Math.round(mode.view.panY + pointer.point.y - mode.origin.y),
    };
    return {
      state: { ...state, mode: { ...mode, point: pointer.point, moved } },
      commands: [{ type: 'view', viewport: panned }],
    };
  }
  if (mode.kind === 'pinch' && (pointer.id === mode.a.id || pointer.id === mode.b.id)) {
    const a = mode.a.id === pointer.id ? { ...mode.a, point: pointer.point } : mode.a;
    const b = mode.b.id === pointer.id ? { ...mode.b, point: pointer.point } : mode.b;
    const tap = mode.tap && !beyond(a.origin, a.point) && !beyond(b.origin, b.point);
    // Once one of the pair lifts, the view holds still until the rest lift.
    if (!mode.touches.has(a.id) || !mode.touches.has(b.id))
      return { state: { ...state, mode: { ...mode, a, b, tap } }, commands: NONE };
    const { distance, midpoint } = span(a.point, b.point);
    const zoom = clampZoom(mode.view.zoom * (distance / mode.distance));
    const viewport = anchored(view, zoom, mode.anchor, midpoint);
    return {
      state: { ...state, mode: { ...mode, a, b, tap, latest: midpoint } },
      commands: [{ type: 'view', viewport }],
    };
  }
  return { state, commands: NONE };
}

function pointerUp(state: GestureState, pointer: GesturePointer, cancelled: boolean): GestureStep {
  const { mode } = state;
  if (state.ignored.has(pointer.id)) {
    const ignored = new Set(state.ignored);
    ignored.delete(pointer.id);
    return { state: { ...state, ignored }, commands: NONE };
  }
  if (mode.kind === 'draw' && mode.id === pointer.id)
    return { state: { ...state, mode: IDLE }, commands: cancelled ? CANCEL : END };
  if (mode.kind === 'pan' && mode.id === pointer.id)
    return { state: { ...state, mode: IDLE }, commands: NONE };
  if (mode.kind !== 'pinch' || !mode.touches.has(pointer.id)) return { state, commands: NONE };

  const touches = new Set(mode.touches);
  touches.delete(pointer.id);
  const tap = mode.tap && !cancelled && pointer.time - mode.startedAt <= TAP_MS;
  if (touches.size === 0) {
    const commands: readonly GestureCommand[] = tap
      ? [{ type: 'view', viewport: mode.view }, { type: mode.fingers >= 3 ? 'redo' : 'undo' }]
      : [{ type: 'settle', at: mode.latest, start: mode.view }];
    return { state: { ...state, mode: IDLE }, commands };
  }
  const pair = pointer.id === mode.a.id || pointer.id === mode.b.id;
  if (!pair || tap) return { state: { ...state, mode: { ...mode, touches, tap } }, commands: NONE };
  // Lifting one of the pair ends the pinch, and the fingers left behind can't start a stroke.
  return {
    state: { ...state, mode: IDLE, ignored: union(state.ignored, touches) },
    commands: [{ type: 'settle', at: mode.latest, start: mode.view }],
  };
}

function escape(state: GestureState): GestureStep {
  const { mode } = state;
  if (mode.kind !== 'draw') return { state, commands: NONE };
  return { state: { ...ignore(state, mode.id), mode: IDLE }, commands: CANCEL };
}

/** Starts a pinch from a single finger that was drawing or panning. */
function beginPinch(
  state: GestureState,
  mode: Draw | Pan,
  pointer: GesturePointer,
  view: Viewport,
): GestureStep {
  // A stroke that just started was really the first finger of a pinch, so it rolls back.
  // An established stroke stays, and the gesture can no longer be an undo tap.
  const stray = mode.kind === 'draw' && pointer.time - mode.startedAt <= STRAY_MS;
  const commands = mode.kind !== 'draw' ? NONE : stray ? CANCEL : END;
  const quick = mode.kind === 'draw' ? stray : pointer.time - mode.startedAt <= TAP_MS;
  const a: Finger = { id: mode.id, origin: mode.origin, point: mode.point };
  const b: Finger = { id: pointer.id, origin: pointer.point, point: pointer.point };
  const { distance, midpoint } = span(a.point, b.point);
  const pinch: Pinch = {
    kind: 'pinch',
    a,
    b,
    touches: new Set([a.id, b.id]),
    fingers: 2,
    startedAt: mode.startedAt,
    tap: quick && !mode.moved,
    view,
    distance,
    anchor: screenToDocument(view, midpoint),
    latest: midpoint,
  };
  return { state: { ...state, mode: pinch }, commands };
}

/**
 * Hands the canvas to a pen and every finger goes inert. A finger stroke that barely moved or just
 * began was a palm, so it rolls back. A deliberate finger stroke stays.
 */
function yieldToPen(state: GestureState, time: number): GestureStep {
  const { mode } = state;
  const idle = { ...state, mode: IDLE };
  switch (mode.kind) {
    case 'draw': {
      const palm = !mode.moved || time - mode.startedAt <= STRAY_MS;
      return { state: ignore(idle, mode.id), commands: palm ? CANCEL : END };
    }
    case 'pan':
      return { state: ignore(idle, mode.id), commands: NONE };
    case 'pinch': {
      const command: GestureCommand = mode.tap
        ? { type: 'view', viewport: mode.view }
        : { type: 'settle', at: mode.latest, start: mode.view };
      return {
        state: { ...idle, ignored: union(state.ignored, mode.touches) },
        commands: [command],
      };
    }
    case 'idle':
      return { state, commands: NONE };
  }
}

/** A mouse or pen owns the gesture, so fingers stay out of it. */
function touchless(mode: Draw | Pan | Pinch): boolean {
  return mode.kind !== 'pinch' && mode.pointer !== 'touch';
}

function draw(pointer: GesturePointer): Draw {
  return {
    kind: 'draw',
    id: pointer.id,
    pointer: pointer.kind,
    origin: pointer.point,
    point: pointer.point,
    startedAt: pointer.time,
    moved: false,
  };
}

function pan(pointer: GesturePointer, view: Viewport): Pan {
  return {
    kind: 'pan',
    id: pointer.id,
    pointer: pointer.kind,
    origin: pointer.point,
    point: pointer.point,
    startedAt: pointer.time,
    moved: false,
    view,
  };
}

function ignore(state: GestureState, id: number): GestureState {
  return { ...state, ignored: new Set(state.ignored).add(id) };
}

function union(a: ReadonlySet<number>, b: ReadonlySet<number>): ReadonlySet<number> {
  return new Set([...a, ...b]);
}

function beyond(origin: ScreenPoint, point: ScreenPoint): boolean {
  return Math.hypot(point.x - origin.x, point.y - origin.y) > TAP_SLOP;
}

function span(a: ScreenPoint, b: ScreenPoint): { distance: number; midpoint: ScreenPoint } {
  return {
    distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

/** Pans and zooms at once so `anchor`, a document point, sits under `screen`. */
function anchored(
  view: Viewport,
  zoom: number,
  anchor: DocumentPoint,
  screen: ScreenPoint,
): Viewport {
  return { ...view, zoom, panX: screen.x - anchor.x * zoom, panY: screen.y - anchor.y * zoom };
}
