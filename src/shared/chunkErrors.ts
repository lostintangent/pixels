/**
 * A part of Pixels that loads on demand (a dialog, a tool, a worker) can fail to arrive: the
 * device went offline, or a deploy replaced the hashed file the open tab asks for. Loaders call
 * `reportLoadFailure` when a user intent fails that way, and the service worker calls
 * `reportUpdate` when a new version is waiting. The editor explains each one once.
 */
export type Interruption =
  | { kind: 'failed'; error: unknown }
  /** `activate` hands the page to the new version, for example by reloading. */
  | { kind: 'updated'; activate: () => void };

type Listener = (interruption: Interruption) => void;

const listeners = new Set<Listener>();
let update: Interruption | undefined;
let save: (() => Promise<void>) | undefined;

function notify(interruption: Interruption): void {
  if (listeners.size === 0) console.error(interruption);
  for (const listener of listeners) listener(interruption);
}

export function reportLoadFailure(error: unknown): void {
  notify({ kind: 'failed', error });
}

/** An update stays pending, so an editor that opens later still offers it. */
export function reportUpdate(activate: () => void): void {
  update = { kind: 'updated', activate };
  notify(update);
}

/** Returns the unsubscribe. */
export function onInterruption(listener: Listener): () => void {
  listeners.add(listener);
  if (update) listener(update);
  return () => void listeners.delete(listener);
}

/** Registers what must be stored before the page goes away. Returns the unregister. */
export function saveBeforeReload(flush: () => Promise<void>): () => void {
  save = flush;
  return () => {
    if (save === flush) save = undefined;
  };
}

/**
 * Stores every edit, then reloads. A load failure first checks that Pixels answers, since a reload
 * while offline loses the tab, and resolves false without reloading when it doesn't. An update
 * passes `activate` and skips that check, because its waiting worker already holds the new
 * version. Rejects, without reloading, when an edit can't be stored.
 */
export async function reloadPixels(activate?: () => void): Promise<boolean> {
  if (!activate)
    try {
      if (!(await fetch(import.meta.env.BASE_URL ?? '/', { cache: 'no-store' })).ok) return false;
    } catch {
      return false;
    }
  await save?.();
  (activate ?? (() => location.reload()))();
  return true;
}

const WORKER_LOAD_FAILURE = 'A worker script failed to load';

// Chromium, Firefox, WebKit, Vite's CSS preload, and `workerError`, in that order.
const LOAD_FAILURE = new RegExp(
  [
    'Failed to fetch dynamically imported module',
    'error loading dynamically imported module',
    'Importing a module script failed',
    'Unable to preload CSS',
    WORKER_LOAD_FAILURE,
  ].join('|'),
  'i',
);

/** Whether an error means code never arrived, as opposed to code that ran and threw. */
export function isLoadFailure(error: unknown): boolean {
  return error instanceof Error && LOAD_FAILURE.test(error.message);
}

/**
 * The error a worker's `error` event stands for. A script that threw arrives as an `ErrorEvent`
 * with its message. A script that never arrived (offline, or replaced by a deploy) arrives as a
 * bare `Event`, which becomes a load failure.
 */
export function workerError(event: Event): Error {
  const message = 'message' in event && typeof event.message === 'string' ? event.message : '';
  return new Error(message || WORKER_LOAD_FAILURE);
}
