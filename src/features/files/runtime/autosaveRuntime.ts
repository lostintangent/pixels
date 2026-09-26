import type { BitmapDocument } from '../../document';
import { createAutosaveScheduler } from '../core/autosave';
import type { AutosaveOptions, DocumentStore, TileCoord } from '../core/contracts';
import { trackPendingSave } from '../core/pendingSaves';
import { snapshotDocument } from '../core/snapshot';
import { tilesForRect } from '../core/tiles';
import { encodePngOffMainThread } from './pngWorkerClient';

/**
 * A single, immediate full save, independent of any live `attachAutosave` subscription. For a
 * one-shot persist-then-navigate flow (New canvas, Open PNG) where there's no ongoing edit
 * session to debounce. Registered as a pending save, so a `loadDocument` for the same id started
 * right after can't race it.
 */
export function saveDocument(document: BitmapDocument, store: DocumentStore): Promise<void> {
  const save = saveDocumentNow(document, store);
  trackPendingSave(document.id, save);
  return save;
}

async function saveDocumentNow(document: BitmapDocument, store: DocumentStore): Promise<void> {
  const snapshot = snapshotDocument(document, [], true);
  const thumbnail = await encodePngOffMainThread(
    snapshot.thumbnailPixels.width,
    snapshot.thumbnailPixels.height,
    snapshot.thumbnailPixels.pixels,
  );
  await store.save(snapshot, thumbnail);
}

export interface Autosave {
  /** Forces an immediate save attempt, bypassing the debounce. Safe to call again after a failure. */
  flush(): Promise<void>;
  /** Unsubscribes and flushes any dirty tiles one last time, so leaving a document never drops an
   *  edit; a `loadDocument` for the same id started right after waits for that flush to commit. */
  dispose(): void;
}

export interface AttachAutosaveOptions extends AutosaveOptions {
  /**
   * Persist the whole document right away instead of waiting for the first edit. Use this for a
   * freshly imported PNG or a document that just changed size (a new `BitmapDocument` object with
   * a new tile grid); leave it false for a brand-new blank canvas (nothing to save until the first
   * stroke) and for a document just loaded unchanged from storage (nothing has changed yet).
   */
  initialResave?: boolean;
}

/**
 * Debounced, off-the-input-path persistence for one live document. Subscribes to its dirty-rect
 * events, tracks touched tiles, and writes through `store` on the schedule from `core/autosave`.
 * A failed save keeps its dirty tiles pending so the next `flush()` (scheduled or manual) retries
 * the same ground, never a partial or stale write.
 */
export function attachAutosave(
  document: BitmapDocument,
  store: DocumentStore,
  options: AttachAutosaveOptions = {},
): Autosave {
  const onStatus = options.onStatus ?? (() => {});
  let dirtyTiles = new Map<string, TileCoord>();
  let fullResavePending = options.initialResave ?? false;
  let disposed = false;

  const unsubscribe = document.events.subscribe((rect) => {
    for (const coord of tilesForRect(rect, document.width, document.height)) {
      dirtyTiles.set(`${coord.tx}:${coord.ty}`, coord);
    }
    scheduler.noteChange();
  });

  async function flush(): Promise<void> {
    if (disposed) return;
    const fullResave = fullResavePending;
    const coords = [...dirtyTiles.values()];
    if (!fullResave && coords.length === 0) return;
    onStatus('saving');
    try {
      const snapshot = snapshotDocument(document, coords, fullResave);
      const thumbnail = await encodePngOffMainThread(
        snapshot.thumbnailPixels.width,
        snapshot.thumbnailPixels.height,
        snapshot.thumbnailPixels.pixels,
      );
      await store.save(snapshot, thumbnail);
      // Only drop pending state once the write actually commits, so a failure keeps retrying.
      dirtyTiles = new Map();
      fullResavePending = false;
      onStatus('saved');
    } catch (error) {
      onStatus('error', error);
      throw error;
    }
  }

  /** Every save attempt, whatever triggers it, is registered so a same-id load can wait for it. */
  function runFlush(): Promise<void> {
    const save = flush();
    trackPendingSave(document.id, save);
    return save;
  }

  const scheduler = createAutosaveScheduler(() => {
    runFlush().catch(() => {
      /* status already reported via onStatus; a scheduled flush must not throw unhandled */
    });
  }, options);

  if (fullResavePending) scheduler.noteChange();

  function flushNow(): void {
    scheduler.cancel();
    runFlush().catch(() => {});
  }
  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) {
    window.addEventListener('pagehide', flushNow);
    window.addEventListener('visibilitychange', flushNow);
  }

  return {
    flush: runFlush,
    dispose() {
      if (disposed) return;
      unsubscribe();
      scheduler.cancel();
      if (hasWindow) {
        window.removeEventListener('pagehide', flushNow);
        window.removeEventListener('visibilitychange', flushNow);
      }
      // Read `disposed` inside flush() is still false at this call, so this final flush runs;
      // only after capturing it do we block any further explicit `.flush()` calls.
      runFlush().catch(() => {});
      disposed = true;
    },
  };
}
