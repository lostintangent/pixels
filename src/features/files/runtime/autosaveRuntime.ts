import { watchAnnotationSet } from '../../annotations/model';
import type { BitmapDocument } from '../../document';
import { createAutosaveScheduler } from '../core/autosave';
import type { AutosaveOptions, DocumentStore, TileCoord } from '../core/contracts';
import { snapshotDocument } from '../core/snapshot';
import { scaleAnnotationsForThumbnail, tilesForRect } from '../core/tiles';
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
    1,
    snapshot.colorSpace,
    scaleAnnotationsForThumbnail(snapshot.shapes, snapshot.thumbnailPixels.scale),
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
  // Bumped each time a flush actually starts a write. If an older flush is still writing when a
  // newer one starts, the older one finishing later must not report "saved" (or "error"): only
  // the newest started flush's own outcome should reach `onStatus`, since an older completion no
  // longer reflects whether the document is actually fully persisted.
  let latestGeneration = 0;
  // True when some flush's failure merged its tiles back into `dirtyTiles` and no later flush has
  // started since (and thus taken ownership of them). If the newest flush then succeeds anyway —
  // because it was already in flight when that failure happened, so its own captured tiles never
  // included the failed ones — its success must not be reported as "saved": that ground is still
  // sitting unsaved with nothing scheduled to retry it, and the UI needs to keep offering Retry.
  let failedGround = false;
  let failedGroundError: unknown;
  // Every tile dirtied since the last moment we knew for certain zero writes for this document
  // were outstanding — a superset of `dirtyTiles` that, unlike it, is never cleared just because
  // some flush captured it. Only dropped once `inFlightFlushes` returns to zero on a success, i.e.
  // once IndexedDB is known to hold every one of these tiles. This is what an exit stash reads:
  // if an earlier stroke's save is still in flight when the page exits, its tiles stay in here
  // even though a later flush already took `dirtyTiles` from under it for a newer stroke.
  let pendingTiles = new Map<string, TileCoord>();
  let pendingFullResave = options.initialResave ?? false;
  let inFlightFlushes = 0;
  // Shapes have no per-tile diff: a 'commit' change (add, edit, delete, or an undo/redo that
  // restores a prior list — all of which route through `AnnotationSet.replace`/`commit`/`remove`,
  // every one of which emits 'commit') means "the current shape list differs from what's
  // persisted," independent of whether any pixel tile is also dirty. `'preview'` changes (a
  // shape still being dragged) are deliberately not included — see `AttachAutosaveOptions`.
  let shapesDirty = false;
  let pendingShapesDirty = false;
  let unsubscribeShapes: (() => void) | null = null;
  // A document with no shapes ever drawn this session has no `AnnotationSet` yet; `watchAnnotationSet`
  // fires once a gesture (or a loader hydrating persisted shapes) creates one, however late that is.
  // Declared after `unsubscribeShapes` itself: `watchAnnotationSet` calls its listener synchronously
  // when a set already exists, which would otherwise assign into `unsubscribeShapes` before its own
  // `let` had run.
  const unwatchShapes = watchAnnotationSet(document, (set) => {
    unsubscribeShapes = set.subscribe((change) => {
      if (change.kind !== 'commit') return;
      shapesDirty = true;
      pendingShapesDirty = true;
      scheduler.noteChange();
    });
  });

  const unsubscribe = document.events.subscribe((rect) => {
    for (const coord of tilesForRect(rect, document.width, document.height)) {
      dirtyTiles.set(`${coord.tx}:${coord.ty}`, coord);
      pendingTiles.set(`${coord.tx}:${coord.ty}`, coord);
    }
    scheduler.noteChange();
  });

  async function flush(): Promise<void> {
    if (disposed) return;
    const fullResave = fullResavePending;
    if (!fullResave && dirtyTiles.size === 0 && !shapesDirty) return;
    // Take ownership of exactly what's dirty right now, then hand the live state a fresh map
    // immediately — before this function's first await — so an edit that lands while this save
    // is in flight accumulates in the new map instead of being wiped out when this save
    // completes and the *old* reference would otherwise get cleared out from under it.
    const captured = dirtyTiles;
    const coords = [...captured.values()];
    dirtyTiles = new Map();
    fullResavePending = false;
    const capturedShapesDirty = shapesDirty;
    shapesDirty = false;
    // This flush now owns every tile that's currently dirty, including any an earlier failure
    // already merged back (if that merge-back landed before this line ran): its own outcome will
    // account for them, so any pending "failed ground" carried by an in-between failure is moot.
    failedGround = false;
    const generation = ++latestGeneration;
    inFlightFlushes++;
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
        1,
        snapshot.colorSpace,
        scaleAnnotationsForThumbnail(snapshot.shapes, snapshot.thumbnailPixels.scale),
      );
      await store.save(snapshot, thumbnail);
      inFlightFlushes--;
      // Only once every write for this document (this one and any older one still finishing) has
      // actually committed do we know IndexedDB truly holds everything this flush captured — but
      // an edit can land on `dirtyTiles` while this very flush was in flight, and that edit was
      // never part of what just committed. So this can't just clear to empty: it has to reset to
      // whatever `dirtyTiles`/`fullResavePending` hold right now, which is exactly the tiles no
      // committed write accounts for yet (nothing, if none landed during the flush).
      if (inFlightFlushes === 0) {
        pendingTiles = new Map(dirtyTiles);
        pendingFullResave = fullResavePending;
        pendingShapesDirty = shapesDirty;
      }
      // A newer flush may have started (and possibly already finished) while this one was
      // writing. Only the newest started flush's outcome should reach the UI: this write did
      // commit, but reporting "saved" here would be a lie if a later write is still pending — or
      // if an older flush that was already in flight when this one started later failed and left
      // ground this attempt never touched.
      if (generation === latestGeneration) {
        onStatus(failedGround ? 'error' : 'saved', failedGround ? failedGroundError : undefined);
      }
    } catch (error) {
      inFlightFlushes--;
      // This attempt's ground wasn't saved: put it back, merged with whatever's accumulated
      // since, so the next flush (scheduled or manual) retries all of it, not just the newest.
      for (const [key, coord] of captured) {
        if (!dirtyTiles.has(key)) dirtyTiles.set(key, coord);
      }
      if (fullResave) {
        fullResavePending = true;
        pendingFullResave = true;
      }
      if (capturedShapesDirty) {
        shapesDirty = true;
        pendingShapesDirty = true;
      }
      failedGround = true;
      failedGroundError = error;
      if (generation === latestGeneration) onStatus('error', error);
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
  // Synchronous, so it runs to completion even if the page is torn down before this task's next
  // tick — unlike `flush()`, which chains behind any write already in flight for this id and so
  // could still be waiting its turn when the page actually exits. Reads `pendingTiles`, not just
  // whatever `dirtyTiles` holds right now, so an earlier stroke's save that's still in flight
  // stays covered even though `flush()` already took `dirtyTiles` out from under it for a newer
  // one. `document` here is the local `BitmapDocument` parameter, not the DOM global — the actual
  // `visibilityState` check below goes through `globalThis.document` for that reason.
  function stashForExit(): void {
    if (pendingTiles.size === 0 && !pendingFullResave && !pendingShapesDirty) return;
    const snapshot = snapshotDocument(document, pendingTiles.values(), pendingFullResave);
    store.stashForRecovery(snapshot);
  }
  function handlePageHide(): void {
    stashForExit();
    flushNow();
  }
  function handleVisibilityChange(): void {
    // Fires on becoming visible too; the journal is only worth its cost on the way to being
    // hidden, the one transition that can precede an actual close.
    if (globalThis.document?.visibilityState === 'hidden') stashForExit();
    flushNow();
  }
  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) {
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('visibilitychange', handleVisibilityChange);
  }

  return {
    flush,
    dispose() {
      if (disposed) return;
      unsubscribe();
      unwatchShapes();
      unsubscribeShapes?.();
      scheduler.cancel();
      if (hasWindow) {
        window.removeEventListener('pagehide', handlePageHide);
        window.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      // Read `disposed` inside flush() is still false at this call, so this final flush runs;
      // only after capturing it do we block any further explicit `.flush()` calls. `store.save`
      // chains this after any write already in flight for the id, so it's still ordered correctly.
      // This is an ordinary in-app teardown (switching documents, navigating away within the
      // app), not a page exit, so it never stashes to the crash journal.
      flush().catch(() => {});
      disposed = true;
    },
  };
}
