import { preloadColorPicker } from '../../palette';
import { preloadDialogs } from './dialogs';
import { preloadMenus } from './menus';
import { preloadToasts } from './toasts';

let scheduled = false;

/**
 * Warms every deferred surface once the editor has painted and the main thread is quiet, so a
 * first open is instant without any of it counting toward the first load. Runs once per page.
 */
export function prefetchWhenIdle(): void {
  if (scheduled) return;
  scheduled = true;
  const idle = (run: () => void) =>
    typeof requestIdleCallback === 'function'
      ? requestIdleCallback(run, { timeout: 2000 })
      : setTimeout(run, 200);
  requestAnimationFrame(() =>
    idle(() => {
      preloadMenus();
      preloadToasts();
      preloadDialogs();
      preloadColorPicker();
    }),
  );
}
