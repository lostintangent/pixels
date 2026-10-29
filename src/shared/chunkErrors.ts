/**
 * A part of Pixels that loads on demand (a dialog, a tool, a worker) can fail to arrive: the
 * device went offline, or a deploy replaced the hashed file the open tab asks for. Loaders call
 * `reportLoadFailure` when a user intent fails that way, and the editor explains it once.
 */
type Listener = (error: unknown) => void;

const listeners = new Set<Listener>();

export function reportLoadFailure(error: unknown): void {
  if (listeners.size === 0) console.error(error);
  for (const listener of listeners) listener(error);
}

/** Returns the unsubscribe. */
export function onLoadFailure(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Chromium, Firefox, WebKit, and Vite's CSS preload, in that order.
const LOAD_FAILURE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** Whether an error means code never arrived, as opposed to code that ran and threw. */
export function isLoadFailure(error: unknown): boolean {
  return error instanceof Error && LOAD_FAILURE.test(error.message);
}
