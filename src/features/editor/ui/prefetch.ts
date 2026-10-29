import { preloadColorPicker } from '../../palette';
import { preloadPaintExtras, preloadShapeController } from '../session/session';
import { preloadDialogs } from './dialogs';
import { preloadMenus } from './menus';

/** How long input must pause before background work may start. */
const QUIET_MS = 1000;
const INPUT = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;

let scheduled = false;

/**
 * Warms every deferred surface once the editor has painted and the person has paused, so a first
 * open is instant without competing with the first load or a stroke. Fetching and evaluating the
 * chunks takes main-thread time, so any input restarts the wait. A press on a trigger still loads
 * its surface at once. Runs once per page.
 */
export function prefetchWhenIdle(): void {
  if (scheduled) return;
  scheduled = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waitingForOnline = false;

  const run = () => {
    if (!navigator.onLine) {
      if (!waitingForOnline) {
        waitingForOnline = true;
        window.addEventListener('online', resume, { once: true });
      }
      return;
    }
    for (const type of INPUT) window.removeEventListener(type, wait, true);
    preloadMenus();
    preloadDialogs();
    preloadColorPicker();
    preloadPaintExtras();
    preloadShapeController();
    void import('../../annotations').catch(() => {});
  };
  const idle = () =>
    typeof requestIdleCallback === 'function'
      ? requestIdleCallback(run, { timeout: QUIET_MS })
      : run();
  function wait() {
    clearTimeout(timer);
    timer = setTimeout(idle, QUIET_MS);
  }
  function resume() {
    waitingForOnline = false;
    wait();
  }

  for (const type of INPUT) window.addEventListener(type, wait, { capture: true, passive: true });
  requestAnimationFrame(wait);
}
