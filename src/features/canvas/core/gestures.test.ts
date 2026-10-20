import { describe, expect, test } from 'bun:test';
import type { ScreenPoint, Viewport } from './contracts';
import {
  type GestureCommand,
  type GestureEvent,
  type GestureState,
  type PointerKind,
  STRAY_MS,
  TAP_MS,
  initialGestureState,
  isNavigating,
  stepGesture,
  wasDrawFinishedExternally,
} from './gestures';
import { screenToDocument } from './viewport';

const view: Viewport = {
  zoom: 8,
  panX: 40,
  panY: 20,
  cssWidth: 400,
  cssHeight: 800,
  devicePixelRatio: 3,
};

/** Drives the machine like a surface: the latest `view` command becomes the current viewport. */
function gestures() {
  let state: GestureState = initialGestureState;
  let current = view;
  const log: GestureCommand['type'][] = [];
  const send = (event: GestureEvent) => {
    const step = stepGesture(state, event, current);
    state = step.state;
    for (const command of step.commands) {
      log.push(command.type);
      if (command.type === 'view') current = command.viewport;
    }
    return step.commands.map((command) => command.type);
  };
  const at = (id: number, kind: PointerKind, point: ScreenPoint, time: number) => ({
    id,
    kind,
    point,
    time,
  });
  return {
    get state() {
      return state;
    },
    get view() {
      return current;
    },
    log,
    down: (id: number, kind: PointerKind, point: ScreenPoint, time: number, button = 0) =>
      send({ type: 'down', pointer: at(id, kind, point, time), button, space: false }),
    spaceDown: (id: number, point: ScreenPoint, time: number) =>
      send({ type: 'down', pointer: at(id, 'mouse', point, time), button: 0, space: true }),
    move: (id: number, kind: PointerKind, point: ScreenPoint, time: number, buttons?: number) =>
      send({ type: 'move', pointer: at(id, kind, point, time), buttons }),
    up: (id: number, kind: PointerKind, point: ScreenPoint, time: number, cancelled = false) =>
      send({ type: 'up', pointer: at(id, kind, point, time), cancelled }),
    escape: () => send({ type: 'escape' }),
  };
}

describe('drawing', () => {
  test('a mouse, pen, or finger draws a stroke from down to up', () => {
    for (const kind of ['mouse', 'pen', 'touch'] as const) {
      const g = gestures();
      expect(g.down(1, kind, { x: 10, y: 10 }, 0)).toEqual(['begin']);
      expect(g.move(1, kind, { x: 30, y: 10 }, 16)).toEqual(['extend']);
      expect(g.up(1, kind, { x: 30, y: 10 }, 32)).toEqual(['end']);
      expect(g.state.mode.kind).toBe('idle');
    }
  });

  test('a cancelled pointer rolls its stroke back', () => {
    const g = gestures();
    g.down(1, 'mouse', { x: 10, y: 10 }, 0);
    expect(g.up(1, 'mouse', { x: 10, y: 10 }, 16, true)).toEqual(['cancel']);
  });

  test('a mouse move after a lost button release ends ink without drawing the hover path', () => {
    const g = gestures();
    g.down(1, 'mouse', { x: 10, y: 10 }, 0);
    g.move(1, 'mouse', { x: 20, y: 10 }, 16, 1);
    expect(g.move(1, 'mouse', { x: 90, y: 10 }, 32, 0)).toEqual(['end']);
    expect(g.state.mode.kind).toBe('idle');
    expect(g.move(1, 'mouse', { x: 120, y: 10 }, 48, 0)).toEqual([]);
    expect(g.log).toEqual(['begin', 'extend', 'end']);

    const pen = gestures();
    pen.down(2, 'pen', { x: 10, y: 10 }, 0);
    expect(pen.move(2, 'pen', { x: 20, y: 10 }, 16, 0)).toEqual(['extend']);
  });

  test('Escape abandons a stroke and the rest of that drag stays inert', () => {
    const g = gestures();
    g.down(1, 'mouse', { x: 10, y: 10 }, 0);
    expect(g.escape()).toEqual(['cancel']);
    expect(g.move(1, 'mouse', { x: 40, y: 10 }, 16)).toEqual([]);
    expect(g.up(1, 'mouse', { x: 40, y: 10 }, 32)).toEqual([]);
    expect(g.down(1, 'mouse', { x: 10, y: 10 }, 48)).toEqual(['begin']);
  });

  test('Fill pressed on workspace gray stays eligible for a pinch after the first finger moves', () => {
    const g = gestures();
    // The pointer machine begins a draw, but Fill's session rejects the off-image point.
    expect(g.down(1, 'touch', { x: 10, y: 10 }, 0)).toEqual(['begin']);
    const beganInSession = false;
    if (wasDrawFinishedExternally(g.state, beganInSession, false)) g.escape();
    expect(g.state.mode.kind).toBe('draw');
    expect(g.move(1, 'touch', { x: 11, y: 10 }, 16)).toEqual(['extend']);
    expect(g.down(2, 'touch', { x: 30, y: 10 }, 50)).toEqual(['cancel']);
    expect(g.state.mode.kind).toBe('pinch');
    expect(g.move(2, 'touch', { x: 35, y: 10 }, 66)).toEqual(['view']);

    const owned = gestures();
    owned.down(1, 'touch', { x: 10, y: 10 }, 0);
    // A dialog later finished a draw that really existed in the session.
    expect(wasDrawFinishedExternally(owned.state, true, false)).toBe(true);
  });

  test('only the primary button draws', () => {
    for (const button of [2, 3, 4, 5]) {
      const g = gestures();
      expect(g.down(1, 'mouse', { x: 10, y: 10 }, 0, button)).toEqual([]);
      expect(g.state.mode.kind).toBe('idle');
    }
  });

  test('other pointers are ignored while one draws', () => {
    const g = gestures();
    g.down(1, 'mouse', { x: 10, y: 10 }, 0);
    expect(g.down(2, 'pen', { x: 50, y: 50 }, 8)).toEqual([]);
    expect(g.move(2, 'pen', { x: 60, y: 50 }, 16)).toEqual([]);
    expect(g.move(1, 'mouse', { x: 20, y: 10 }, 16)).toEqual(['extend']);
  });
});

describe('panning', () => {
  test('middle button pans by whole pixels from where it started', () => {
    const g = gestures();
    expect(g.down(1, 'mouse', { x: 100, y: 100 }, 0, 1)).toEqual([]);
    expect(isNavigating(g.state)).toBe(true);
    expect(g.move(1, 'mouse', { x: 130.4, y: 90.6 }, 16)).toEqual(['view']);
    expect(g.view).toMatchObject({ zoom: 8, panX: 70, panY: 11 });
    expect(g.up(1, 'mouse', { x: 130, y: 90 }, 32)).toEqual([]);
    expect(isNavigating(g.state)).toBe(false);
  });

  test('held space turns a primary press into a pan', () => {
    const g = gestures();
    expect(g.spaceDown(1, { x: 100, y: 100 }, 0)).toEqual([]);
    g.move(1, 'mouse', { x: 90, y: 100 }, 16);
    expect(g.view).toMatchObject({ panX: 30, panY: 20 });
    expect(g.log).not.toContain('begin');
  });
});

describe('pinch', () => {
  test('keeps the document point under the starting midpoint beneath the fingers', () => {
    const g = gestures();
    g.down(1, 'touch', { x: 100, y: 300 }, 0);
    g.down(2, 'touch', { x: 200, y: 300 }, 20);
    const anchor = screenToDocument(view, { x: 150, y: 300 });
    g.move(1, 'touch', { x: 60, y: 350 }, 40);
    g.move(2, 'touch', { x: 260, y: 350 }, 40);
    expect(g.view.zoom).toBeCloseTo(16);
    const under = screenToDocument(g.view, { x: 160, y: 350 });
    expect(under.x).toBeCloseTo(anchor.x);
    expect(under.y).toBeCloseTo(anchor.y);
  });

  test('a touch that becomes a pinch quickly leaves no stray pixel', () => {
    const g = gestures();
    g.down(1, 'touch', { x: 100, y: 300 }, 0);
    g.move(1, 'touch', { x: 104, y: 300 }, 30);
    expect(g.down(2, 'touch', { x: 200, y: 300 }, STRAY_MS)).toEqual(['cancel']);
    expect(g.log).not.toContain('end');
  });

  test('an established stroke is kept when a second finger arrives late', () => {
    const g = gestures();
    g.down(1, 'touch', { x: 100, y: 300 }, 0);
    g.move(1, 'touch', { x: 180, y: 300 }, 200);
    expect(g.down(2, 'touch', { x: 300, y: 300 }, STRAY_MS + 1)).toEqual(['end']);
    g.up(1, 'touch', { x: 180, y: 300 }, STRAY_MS + 40);
    g.up(2, 'touch', { x: 300, y: 300 }, STRAY_MS + 50);
    expect(g.log).not.toContain('undo');
  });

  test('ends on the zoom ladder when the fingers lift', () => {
    const g = gestures();
    g.down(1, 'touch', { x: 100, y: 300 }, 0);
    g.down(2, 'touch', { x: 200, y: 300 }, 10);
    g.move(2, 'touch', { x: 230, y: 300 }, 40);
    g.up(1, 'touch', { x: 100, y: 300 }, 400);
    expect(g.up(2, 'touch', { x: 230, y: 300 }, 410)).toEqual([]);
    expect(g.log.at(-1)).toBe('settle');
  });

  test('a two-finger pan keeps the exact zoom and settles with the view it started from', () => {
    let state: GestureState = initialGestureState;
    let current: Viewport = { ...view, zoom: 11, fittedZoom: 11 };
    const start = current;
    const settles: GestureCommand[] = [];
    const send = (event: GestureEvent) => {
      const step = stepGesture(state, event, current);
      state = step.state;
      for (const command of step.commands) {
        if (command.type === 'view') current = command.viewport;
        if (command.type === 'settle') settles.push(command);
      }
    };
    const pointer = (id: number, x: number, time: number) => ({
      id,
      kind: 'touch' as const,
      point: { x, y: 300 },
      time,
    });
    send({ type: 'down', pointer: pointer(1, 100, 0), button: 0, space: false });
    send({ type: 'down', pointer: pointer(2, 200, 10), button: 0, space: false });
    send({ type: 'move', pointer: pointer(1, 160, 30) });
    send({ type: 'move', pointer: pointer(2, 260, 40) });
    expect(current.zoom).toBe(11);
    expect(current.panX).toBe(start.panX + 60);
    send({ type: 'up', pointer: pointer(1, 160, 400), cancelled: false });
    expect(settles).toEqual([{ type: 'settle', at: { x: 210, y: 300 }, start }]);
  });

  test('a finger left behind after a pinch cannot draw, and neither can a new one', () => {
    const g = gestures();
    g.down(1, 'touch', { x: 100, y: 300 }, 0);
    g.down(2, 'touch', { x: 200, y: 300 }, 10);
    g.move(2, 'touch', { x: 260, y: 300 }, 40);
    expect(g.up(1, 'touch', { x: 100, y: 300 }, 400)).toEqual(['settle']);
    expect(g.move(2, 'touch', { x: 300, y: 300 }, 420)).toEqual([]);
    expect(g.down(3, 'touch', { x: 50, y: 50 }, 430)).toEqual([]);
    g.up(2, 'touch', { x: 300, y: 300 }, 440);
    g.up(3, 'touch', { x: 50, y: 50 }, 450);
    expect(g.down(4, 'touch', { x: 50, y: 50 }, 460)).toEqual(['begin']);
  });
});

describe('taps', () => {
  test('a two-finger tap undoes and restores the view it started from', () => {
    const g = gestures();
    g.down(1, 'touch', { x: 100, y: 300 }, 0);
    g.down(2, 'touch', { x: 200, y: 300 }, 30);
    g.move(2, 'touch', { x: 204, y: 302 }, 60);
    expect(g.view.zoom).not.toBe(view.zoom);
    g.up(1, 'touch', { x: 100, y: 300 }, 120);
    expect(g.up(2, 'touch', { x: 204, y: 302 }, 140)).toEqual(['view', 'undo']);
    expect(g.view).toEqual(view);
    expect(g.log).toEqual(['begin', 'cancel', 'view', 'view', 'undo']);
  });

  test('a three-finger tap redoes', () => {
    const g = gestures();
    g.down(1, 'touch', { x: 100, y: 300 }, 0);
    g.down(2, 'touch', { x: 200, y: 300 }, 20);
    g.down(3, 'touch', { x: 300, y: 300 }, 40);
    g.up(3, 'touch', { x: 300, y: 300 }, 150);
    g.up(1, 'touch', { x: 100, y: 300 }, 160);
    expect(g.up(2, 'touch', { x: 200, y: 300 }, 170)).toEqual(['view', 'redo']);
  });

  test('a slow tap is not an undo', () => {
    const g = gestures();
    g.down(1, 'touch', { x: 100, y: 300 }, 0);
    g.down(2, 'touch', { x: 200, y: 300 }, 20);
    g.up(1, 'touch', { x: 100, y: 300 }, TAP_MS + 1);
    g.up(2, 'touch', { x: 200, y: 300 }, TAP_MS + 2);
    expect(g.log).not.toContain('undo');
  });

  test('a tap whose fingers moved is not an undo', () => {
    const g = gestures();
    g.down(1, 'touch', { x: 100, y: 300 }, 0);
    g.down(2, 'touch', { x: 200, y: 300 }, 20);
    g.move(1, 'touch', { x: 100, y: 330 }, 60);
    g.up(1, 'touch', { x: 100, y: 330 }, 100);
    g.up(2, 'touch', { x: 200, y: 300 }, 110);
    expect(g.log).not.toContain('undo');
  });

  test('a cancelled finger is not an undo', () => {
    const g = gestures();
    g.down(1, 'touch', { x: 100, y: 300 }, 0);
    g.down(2, 'touch', { x: 200, y: 300 }, 20);
    g.up(1, 'touch', { x: 100, y: 300 }, 100, true);
    g.up(2, 'touch', { x: 200, y: 300 }, 110, true);
    expect(g.log).not.toContain('undo');
  });
});

describe('pen and palm', () => {
  test('once a pen is seen, one finger pans instead of drawing', () => {
    const g = gestures();
    g.down(1, 'pen', { x: 10, y: 10 }, 0);
    g.up(1, 'pen', { x: 10, y: 10 }, 20);
    expect(g.down(2, 'touch', { x: 100, y: 100 }, 100)).toEqual([]);
    expect(isNavigating(g.state)).toBe(true);
    expect(g.move(2, 'touch', { x: 120, y: 100 }, 116)).toEqual(['view']);
  });

  test('a palm that lands during a pen stroke changes nothing', () => {
    const g = gestures();
    g.down(1, 'pen', { x: 10, y: 10 }, 0);
    expect(g.down(2, 'touch', { x: 200, y: 400 }, 40)).toEqual([]);
    expect(g.down(3, 'touch', { x: 240, y: 420 }, 50)).toEqual([]);
    expect(g.move(2, 'touch', { x: 260, y: 400 }, 60)).toEqual([]);
    expect(g.move(1, 'pen', { x: 20, y: 10 }, 60)).toEqual(['extend']);
    g.up(2, 'touch', { x: 260, y: 400 }, 70);
    g.up(3, 'touch', { x: 240, y: 420 }, 80);
    expect(g.up(1, 'pen', { x: 20, y: 10 }, 90)).toEqual(['end']);
    expect(g.log).toEqual(['begin', 'extend', 'end']);
  });

  test('a resting palm never blocks the pen', () => {
    const g = gestures();
    g.down(9, 'pen', { x: 0, y: 0 }, 0);
    g.up(9, 'pen', { x: 0, y: 0 }, 10);
    g.down(2, 'touch', { x: 200, y: 400 }, 100);
    g.move(2, 'touch', { x: 230, y: 400 }, 120);
    expect(g.down(1, 'pen', { x: 10, y: 10 }, 200)).toEqual(['begin']);
    expect(g.move(2, 'touch', { x: 260, y: 400 }, 210)).toEqual([]);
    expect(g.move(1, 'pen', { x: 20, y: 10 }, 216)).toEqual(['extend']);
  });

  test('the first pen rolls back a palm stroke that landed just before it', () => {
    const g = gestures();
    g.down(2, 'touch', { x: 200, y: 400 }, 0);
    g.move(2, 'touch', { x: 203, y: 401 }, 400);
    expect(g.down(1, 'pen', { x: 10, y: 10 }, 500)).toEqual(['cancel', 'begin']);
    expect(g.state.penSeen).toBe(true);
  });

  test('the first pen keeps a deliberate finger stroke', () => {
    const g = gestures();
    g.down(2, 'touch', { x: 200, y: 400 }, 0);
    g.move(2, 'touch', { x: 300, y: 400 }, 400);
    expect(g.down(1, 'pen', { x: 10, y: 10 }, 500)).toEqual(['end', 'begin']);
  });

  test('a pen interrupting a pinch settles the view and takes over', () => {
    const g = gestures();
    g.down(2, 'touch', { x: 100, y: 300 }, 0);
    g.down(3, 'touch', { x: 200, y: 300 }, 10);
    g.move(3, 'touch', { x: 260, y: 300 }, 40);
    expect(g.down(1, 'pen', { x: 10, y: 10 }, 400)).toEqual(['settle', 'begin']);
    expect(g.up(2, 'touch', { x: 100, y: 300 }, 420)).toEqual([]);
  });

  test('two fingers still tap to undo after a pen is seen', () => {
    const g = gestures();
    g.down(1, 'pen', { x: 10, y: 10 }, 0);
    g.up(1, 'pen', { x: 10, y: 10 }, 20);
    g.down(2, 'touch', { x: 100, y: 300 }, 100);
    g.down(3, 'touch', { x: 200, y: 300 }, 110);
    g.up(2, 'touch', { x: 100, y: 300 }, 200);
    expect(g.up(3, 'touch', { x: 200, y: 300 }, 210)).toEqual(['view', 'undo']);
  });
});
