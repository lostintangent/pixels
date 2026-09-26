import type { BitmapDocument } from '../../document';
import { createAutosaveScheduler } from '../core/autosave';
import type { AutosaveOptions, DocumentStore, TileCoord } from '../core/contracts';
import { snapshotDocument } from '../core/snapshot';
import { tilesForRect } from '../core/tiles';
import { encodePngOffMainThread } from './pngWorkerClient';

/**
 * A single, immediate full save, independent of any live `attachAutosave` subscription. For a
 * one-shot persist-then-navigate flow (New canvas, Open PNG) where there's no ongoing edit
 * session to debounce. `store` itself chains this after any write already in flight for the same
 * id and makes a following `load` wait for it — but only from the instant `store.save` is called,
 * so the thumbnail encode's promise is handed to it directly, unawaited, rather than resolved
 * first: that reserves this id's place in the write order synchronously, before this function's
 * first await, instead of leaving a gap a same-id `load` right after could race.
 */
export async function saveDocument(document: BitmapDocument, store: DocumentStore): Promise<void> {
  const snapshot = snapshotDocument(document, [], true);
  const thumbnail = encodePngOffMainThread(
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
    if (!fullResave && dirtyTiles.size === 0) return;
    // Take ownership of exactly what's dirty right now, then hand the live state a fresh map
    // immediately — before this function's first await — so an edit that lands while this save
    // is in flight accumulates in the new map instead of being wiped out when this save
    // completes and the *old* reference would otherwise get cleared out from under it.
    const captured = dirtyTiles;
    const coords = [...captured.values()];
    dirtyTiles = new Map();
    fullResavePending = false;
    onStatus('saving');
    try {
      const snapshot = snapshotDocument(document, coords, fullResave);
      // Handed to `store.save` unawaited: the call below reserves this id's place in the
      // store's write order the instant it runs, before this function's first suspension, so a
      // `load` for the same id issued right after `flush()` (even fire-and-forget, as `dispose`
      // does) is guaranteed to wait for it — encoding included.
      const thumbnail = encodePngOffMainThread(
        snapshot.thumbnailPixels.width,
        snapshot.thumbnailPixels.height,
        snapshot.thumbnailPixels.pixels,
      );
      await store.save(snapshot, thumbnail);
      onStatus('saved');
    } catch (error) {
      // This attempt's ground wasn't saved: put it back, merged with whatever's accumulated
      // since, so the next flush (scheduled or manual) retries all of it, not just the newest.
      for (const [key, coord] of captured) {
        if (!dirtyTiles.has(key)) dirtyTiles.set(key, coord);
      }
      if (fullResave) fullResavePending = true;
      onStatus('error', error);
      throw error;
    }
  }

  const scheduler = createAutosaveScheduler(() => {
    flush().catch(() => {
      /* status already reported via onStatus; a scheduled flush must not throw unhandled */
    });
  }, options);

  if (fullResavePending) scheduler.noteChange();

  function flushNow(): void {
    scheduler.cancel();
    flush().catch(() => {});
  }
  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) {
    window.addEventListener('pagehide', flushNow);
    window.addEventListener('visibilitychange', flushNow);
  }

  return {
    flush,
    dispose() {
      if (disposed) return;
      unsubscribe();
      scheduler.cancel();
      if (hasWindow) {
        window.removeEventListener('pagehide', flushNow);
        window.removeEventListener('visibilitychange', flushNow);
      }
      // Read `disposed` inside flush() is still false at this call, so this final flush runs;
      // only after capturing it do we block any further explicit `.flush()` calls. `store.save`
      // chains this after any write already in flight for the id, so it's still ordered correctly.
      flush().catch(() => {});
      disposed = true;
    },
  };
}
