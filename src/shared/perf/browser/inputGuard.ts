import type { Page } from 'playwright';

export interface InputPath {
  kind: 'load' | 'stroke' | 'pan';
  first: { x: number; y: number };
  last?: { x: number; y: number };
  pointerType: 'mouse' | 'touch';
}

interface InputIncident {
  event: string;
  at: number;
  x?: number;
  y?: number;
  button?: number;
  pointerType?: string;
  focused: boolean;
  visibility: DocumentVisibilityState;
}

type GuardWindow = Window & {
  __pixelsInputGuard?: {
    path: InputPath;
    incidents: InputIncident[];
    observed: Record<string, number>;
  };
};

/** The Chrome harness and a person's HID both produce trusted DOM events. A planned
 * path lets us reject unrelated input without adding logging to every traced move. */
export async function armInputGuard(page: Page, path: InputPath): Promise<void> {
  await page.evaluate((expected) => {
    const root = window as GuardWindow;
    if (!root.__pixelsInputGuard) {
      const state = {
        path: expected,
        incidents: [] as InputIncident[],
        observed: { pointerdown: 0, pointermove: 0, pointerup: 0 } as Record<string, number>,
      };
      root.__pixelsInputGuard = state;
      const record = (event: string, source?: PointerEvent) => {
        if (state.incidents.length >= 12) return;
        state.incidents.push({
          event,
          at: Math.round(performance.now()),
          ...(source && {
            x: Math.round(source.clientX),
            y: Math.round(source.clientY),
            button: source.button,
            pointerType: source.pointerType,
          }),
          focused: document.hasFocus(),
          visibility: document.visibilityState,
        });
      };
      const near = (event: PointerEvent, point: { x: number; y: number }, gap = 3) =>
        Math.abs(event.clientX - point.x) <= gap && Math.abs(event.clientY - point.y) <= gap;
      const onPointer = (event: PointerEvent) => {
        if (!event.isTrusted) return;
        state.observed[event.type] = (state.observed[event.type] ?? 0) + 1;
        const { path } = state;
        if (event.pointerType !== path.pointerType) {
          record(event.type, event);
          return;
        }
        if (path.kind === 'load') {
          if (
            event.type === 'pointermove' &&
            (near(event, { x: 0, y: 0 }) || near(event, path.first))
          )
            return;
          if (event.type !== 'pointermove' && near(event, path.first)) return;
        } else if (path.kind === 'stroke' && path.last) {
          if (event.type === 'pointerdown' && near(event, path.first)) return;
          if (event.type === 'pointerup' && near(event, path.last)) return;
          const dx = path.last.x - path.first.x;
          const dy = path.last.y - path.first.y;
          const progress =
            Math.abs(dx) >= Math.abs(dy)
              ? (event.clientX - path.first.x) / dx
              : (event.clientY - path.first.y) / dy;
          if (
            event.type === 'pointermove' &&
            progress >= -0.01 &&
            progress <= 1.01 &&
            Math.abs(event.clientX - (path.first.x + progress * dx)) < 3 &&
            Math.abs(event.clientY - (path.first.y + progress * dy)) < 3
          )
            return;
        } else if (path.kind === 'pan') {
          const dx = event.clientX - path.first.x;
          const dy = event.clientY - path.first.y;
          if (path.pointerType === 'mouse') {
            if (event.type !== 'pointermove') {
              if (event.button === 1 && near(event, path.first)) return;
            } else if (
              near(event, path.first) ||
              Math.abs((dx / 100) ** 2 + ((dy + 60) / 60) ** 2 - 1) < 0.12
            )
              return;
          } else if (
            (Math.abs(dx + 60) < 3 && Math.abs(dy) < 3) ||
            Math.abs(((dx - 60) / 40) ** 2 + ((dy + 30) / 30) ** 2 - 1) < 0.25
          )
            return;
        }
        record(event.type, event);
      };
      for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
        window.addEventListener(name, onPointer as EventListener, true);
      window.addEventListener(
        'keydown',
        (event) => {
          if (event.isTrusted) record(`keydown ${event.key}`);
        },
        true,
      );
      window.addEventListener(
        'wheel',
        (event) => {
          if (event.isTrusted) record('wheel');
        },
        true,
      );
      window.addEventListener('blur', () => record('blur'), true);
      document.addEventListener('visibilitychange', () => record('visibilitychange'), true);
    }
    root.__pixelsInputGuard.path = expected;
    root.__pixelsInputGuard.incidents.length = 0;
    root.__pixelsInputGuard.observed = { pointerdown: 0, pointermove: 0, pointerup: 0 };
    if (!document.hasFocus() || document.visibilityState !== 'visible') {
      root.__pixelsInputGuard.incidents.push({
        event: 'window was not focused and visible at gesture start',
        at: Math.round(performance.now()),
        focused: document.hasFocus(),
        visibility: document.visibilityState,
      });
    }
  }, path);
}

export async function assertCleanInput(page: Page, phase: string): Promise<void> {
  const incidents = await page.evaluate(() => {
    const guard = (window as GuardWindow).__pixelsInputGuard;
    if (!guard) throw new Error('Input guard was not armed');
    const found = guard.incidents.splice(0);
    if (!document.hasFocus() || document.visibilityState !== 'visible')
      found.push({
        event: 'window was not focused and visible at gesture end',
        at: Math.round(performance.now()),
        focused: document.hasFocus(),
        visibility: document.visibilityState,
      });
    return found;
  });
  if (incidents.length)
    throw new Error(`${phase}: foreign input or window focus change: ${JSON.stringify(incidents)}`);
}

export async function observedInput(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...(window as GuardWindow).__pixelsInputGuard?.observed }));
}
