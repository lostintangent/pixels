import type { DocumentId } from './contracts';

/**
 * Tracks saves currently in flight (or about to run) per document id, so a `load()` for that id
 * can wait for them instead of racing a write and reading stale or partial tiles. This is what
 * makes "leave a document, come back before its debounce would have fired" safe without the
 * editor needing to coordinate anything itself: leaving always flushes, and loading always waits.
 */
const inFlight = new Map<DocumentId, Promise<void>>();

/** Registers a save attempt. Never rejects the registry entry itself: a failed save is reported
 *  through the caller's own `onStatus`, and shouldn't make an unrelated load throw. */
export function trackPendingSave(id: DocumentId, save: Promise<unknown>): void {
  const settled = save.then(
    () => undefined,
    () => undefined,
  );
  inFlight.set(id, settled);
  void settled.then(() => {
    if (inFlight.get(id) === settled) inFlight.delete(id);
  });
}

/** Waits for any save currently registered for this document id. A no-op if there is none. */
export async function waitForPendingSave(id: DocumentId): Promise<void> {
  await inFlight.get(id);
}
