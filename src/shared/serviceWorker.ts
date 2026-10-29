import { reportUpdate } from './chunkErrors';

/**
 * Registers the playground's service worker after the editor's first paint, at idle, so an
 * offline launch or a deploy swap can't strand an open tab. `navigator.serviceWorker` is missing
 * over the tailnet's plain HTTP, like `crypto.randomUUID`, so this is feature-detected. A plain
 * `vite build` (used by `perf`, `golden`, and the other production-preview harnesses) serves from
 * `/` and has no `sw.js` at all; `build:playground`'s non-root base is the only build that emits
 * one, so checking `BASE_URL` is the same signal the build plugin uses to decide whether to emit
 * it, without a separate flag to keep in sync.
 */
export function registerServiceWorker(scope: string = import.meta.env.BASE_URL ?? '/'): void {
  if (!('serviceWorker' in navigator)) return;
  if (scope === '/') return;
  const schedule =
    typeof requestIdleCallback === 'function'
      ? requestIdleCallback
      : (fn: () => void) => setTimeout(fn, 1);
  schedule(() => void register(scope));
}

/** A tab left open across a deploy still rechecks for a new version, but no more than this often. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

async function register(scope: string): Promise<void> {
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register(`${scope}sw.js`, {
      scope,
      // The worker's own file must always reach the network, or the browser could never notice a
      // new version once this one is cached.
      updateViaCache: 'none',
    });
  } catch {
    return;
  }

  // A reload before this editor opened can leave a version already waiting.
  const waiting = registration.waiting;
  if (waiting && navigator.serviceWorker.controller) reportUpdate(activateWaiting(waiting));

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // A controller only exists once some version has already activated, so this status change
      // is a later deploy, not this tab's own first install.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        reportUpdate(activateWaiting(installing));
      }
    });
  });

  // The browser only checks `sw.js` again on navigation, so a tab that never navigates (a phone
  // left open) would never hear about a deploy. Rechecking whenever it becomes visible again,
  // throttled, catches that without polling in the background while it's hidden.
  if (typeof document !== 'undefined') {
    let lastChecked = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastChecked < UPDATE_CHECK_INTERVAL_MS) return;
      lastChecked = now;
      void registration.update();
    });
  }
}

/**
 * A new worker waits rather than taking over, so an open tab's already-fetched lazy chunks keep
 * resolving against the cache version they loaded against. Reload opts in explicitly: `activate`
 * messages the waiting worker to skip waiting, then reloads once `controllerchange` confirms it
 * is serving the new version. A plain reload wouldn't activate it at all.
 *
 * `self.clients.claim()` in the worker's own `activate` hands every open tab to a new version at
 * once, so a second tab's Reload can find this same worker already active, with no further
 * `controllerchange` ever coming (that event already fired, silently, before this tab's listener
 * existed). Reloading immediately in that case avoids waiting forever for an event that already
 * happened.
 */
function activateWaiting(worker: ServiceWorker): () => void {
  return () => {
    if (navigator.serviceWorker.controller === worker) {
      location.reload();
      return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
      once: true,
    });
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
}
