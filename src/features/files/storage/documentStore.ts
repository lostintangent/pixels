import type { DocumentColorSpace } from '../../document';
import type {
  DocumentId,
  DocumentSnapshot,
  DocumentStore,
  DocumentSummary,
  LoadedDocument,
  TileSnapshot,
} from '../core/contracts';
import { buildThumbnail, writeTile } from '../core/tiles';
import { encodePngOffMainThread } from '../runtime/pngWorkerClient';

const DB_NAME = 'pixels-files';
const DB_VERSION = 1;
const DOCUMENTS_STORE = 'documents';
const TILES_STORE = 'tiles';
const TILES_BY_ID_INDEX = 'by_id';
// Every tile `.put()` up to this many per transaction can queue in one synchronous task with no
// yield; a save with fewer dirty tiles than this (the common case: one stroke's worth) behaves
// exactly as before. Chosen so the slowest realistic batch (a 4096x4096 full resave, 4096 tiles)
// splits into roughly 8 yields — enough to keep each task comfortably under a 50ms budget without
// adding meaningful task-switch overhead to the common small-save path.
const SAVE_BATCH_TILE_COUNT = 512;

interface DocumentRecord {
  id: DocumentId;
  name: string;
  width: number;
  height: number;
  updatedAt: number;
  thumbnail: Uint8Array;
  /** Missing on a record written before color tagging landed; `load()` defaults it to `'srgb'`,
   *  the color space every document was implicitly in before this field existed. */
  colorSpace?: DocumentColorSpace;
}

interface TileRecord {
  id: DocumentId;
  tx: number;
  ty: number;
  pixels: Uint8Array;
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCUMENTS_STORE)) {
        db.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(TILES_STORE)) {
        const tiles = db.createObjectStore(TILES_STORE, { keyPath: ['id', 'tx', 'ty'] });
        tiles.createIndex(TILES_BY_ID_INDEX, 'id', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Deletes every stored tile for a document id, used before a full resave replaces the whole grid.
 *  A single range delete on the primary key (`[id, tx, ty]`) rather than an awaited cursor walk:
 *  `[id, []]` sorts above every real `[id, tx, ty]` key (IndexedDB orders a number below an array
 *  in the same slot), so the bound below always covers exactly this id's tiles. Issued
 *  synchronously alongside the puts below, so nothing here forces its own await before the
 *  transaction's explicit `commit()`. */
function deleteAllTiles(tx: IDBTransaction, id: DocumentId): void {
  tx.objectStore(TILES_STORE).delete(IDBKeyRange.bound([id], [id, []]));
}

const BASE64_CHUNK = 0x2000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface CrashRecoveryPayload {
  updatedAt: number;
  name: string;
  width: number;
  height: number;
  fullResave: boolean;
  tiles: { tx: number; ty: number; pixels: string }[];
  colorSpace: DocumentColorSpace;
}

// Measured directly, with the journal disabled, against real Chromium: once `saveNow` issues its
// `put`s and commits the transaction explicitly (rather than waiting for the microtask queue to
// idle into an implicit auto-commit), a `location.reload()` reliably lets that commit land —
// reload's data loss was this store's own commit timing, not a browser quirk reload specifically
// exposes. Actually *closing* the page is the case that still loses it: the same test shows an
// already-committed transaction can be discarded 5 of 5 on close, even with the explicit commit
// and even with a pause before reopening. `localStorage.setItem` is a genuinely synchronous,
// blocking write with no such gap, so it covers exactly the teardown IndexedDB doesn't survive on
// close. This is a pure safety net for that one narrow window, not a second primary write path —
// capped in size so a large simultaneous edit just forgoes it rather than risking `localStorage`'s
// much smaller quota, and only ever written at the moment the page is actually exiting (see
// `attachAutosave`'s pagehide/hidden handling), never on every routine debounced save.
const CRASH_RECOVERY_MAX_BYTES = 1.5 * 1024 * 1024;

function crashRecoveryKey(id: DocumentId): string {
  return `pixels-files-crash-recovery:${id}`;
}

function stashForCrashRecovery(snapshot: DocumentSnapshot): void {
  if (typeof localStorage === 'undefined') return;
  const totalBytes = snapshot.tiles.reduce((sum, tile) => sum + tile.pixels.byteLength, 0);
  if (totalBytes > CRASH_RECOVERY_MAX_BYTES) return;
  try {
    const payload: CrashRecoveryPayload = {
      updatedAt: snapshot.updatedAt,
      name: snapshot.name,
      width: snapshot.width,
      height: snapshot.height,
      fullResave: snapshot.fullResave,
      tiles: snapshot.tiles.map((tile) => ({
        tx: tile.tx,
        ty: tile.ty,
        pixels: bytesToBase64(tile.pixels),
      })),
      colorSpace: snapshot.colorSpace,
    };
    localStorage.setItem(crashRecoveryKey(snapshot.id), JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage disabled: the fallback just doesn't apply this time.
  }
}

function readCrashRecovery(id: DocumentId): CrashRecoveryPayload | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(crashRecoveryKey(id));
    return raw ? (JSON.parse(raw) as CrashRecoveryPayload) : null;
  } catch {
    return null;
  }
}

function clearCrashRecovery(id: DocumentId): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(crashRecoveryKey(id));
  } catch {
    // ignore
  }
}

/**
 * Chains every write for a document id after the last one registered for that same id, so `load`
 * can wait on a single promise that only resolves once every write that happened-before it has
 * actually committed — instead of quietly depending on IndexedDB serializing same-scope readwrite
 * transactions in creation order. A write that fails still lets the next one for the id proceed
 * (the id must never wedge), but `load` never throws because of it: only the caller of the failed
 * write itself sees that rejection.
 */
class WriteChain {
  private readonly chains = new Map<DocumentId, Promise<void>>();

  run(id: DocumentId, operation: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(id, settled);
    void settled.then(() => {
      if (this.chains.get(id) === settled) this.chains.delete(id);
    });
    return result;
  }

  /** Resolves once every write already chained for `id` has settled. A no-op if there is none. */
  async settle(id: DocumentId): Promise<void> {
    await this.chains.get(id);
  }
}

/** A cheap, one-shot thumbnail for a document recovered from the crash journal that never had a
 *  real one — recovery is rare, so this never needed its own fast path; it already goes through
 *  the same off-main-thread encoder every other save uses. */
async function buildRecoveredThumbnail(
  pixels: Uint8Array,
  width: number,
  height: number,
  colorSpace: DocumentColorSpace,
): Promise<Uint8Array> {
  const pixels32 = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length / 4);
  const thumbnailPixels = buildThumbnail(pixels32, width, height);
  return encodePngOffMainThread(
    thumbnailPixels.width,
    thumbnailPixels.height,
    thumbnailPixels.pixels,
    1,
    colorSpace,
  );
}

/** Real IndexedDB persistence. Under `bun test`, `fake-indexeddb/auto` provides the same global.
 *  `databaseName` defaults to the app's single database; tests override it for isolation. */
export function createDocumentStore(options: { databaseName?: string } = {}): DocumentStore {
  const dbPromise = openDatabase(options.databaseName ?? DB_NAME);
  const writes = new WriteChain();
  // Mirrors each document's last known thumbnail bytes in memory so `saveNow` can carry the
  // existing preview forward without an IndexedDB read of its own — any such read is itself an
  // async gap ahead of the tile write it would gate, the exact hazard this store exists to avoid
  // on a `pagehide` flush. Seeded by `load()`; updated whenever a real thumbnail is patched in.
  const lastKnownThumbnail = new Map<DocumentId, Uint8Array>();

  async function saveNow(
    snapshot: DocumentSnapshot,
    thumbnail: Uint8Array | Promise<Uint8Array>,
  ): Promise<void> {
    // Open the transaction and write pixel data as soon as the database itself is ready. `dbPromise`
    // resolves once, early, and is never the bottleneck — but the thumbnail is a PNG-worker round
    // trip that can still be in flight when the page is torn down. A `pagehide` flush that awaited
    // it here (as this used to) could lose an entire stroke to a reload that lands before the
    // worker replies, even though the tiles themselves were ready to write all along. Treating the
    // thumbnail as optional keeps this write's real data on the synchronous, survives-teardown path.
    const db = await dbPromise;
    const tx = db.transaction([DOCUMENTS_STORE, TILES_STORE], 'readwrite');
    const documents = tx.objectStore(DOCUMENTS_STORE);
    const tiles = tx.objectStore(TILES_STORE);

    if (snapshot.fullResave) deleteAllTiles(tx, snapshot.id);

    const record: DocumentRecord = {
      id: snapshot.id,
      name: snapshot.name,
      width: snapshot.width,
      height: snapshot.height,
      updatedAt: snapshot.updatedAt,
      // Keep whatever thumbnail is already known (or a blank placeholder for a brand-new
      // document) until the real one resolves below — it's a preview icon, not document data.
      thumbnail: lastKnownThumbnail.get(snapshot.id) ?? new Uint8Array(0),
      colorSpace: snapshot.colorSpace,
    };
    documents.put(record);
    // Queuing every tile `.put()` in one synchronous loop is exactly what makes a large full
    // resave (thousands of tiles) one long main-thread task: each `.put()` structured-clones its
    // tile synchronously, back to back, with nothing to let the browser schedule a frame or input
    // in between. Awaiting one request every SAVE_BATCH_TILE_COUNT tiles splits that into several
    // much smaller tasks instead — IndexedDB request completions are dispatched as separate tasks,
    // not microtasks, so this is a real yield, not just an `await` that resolves in the same tick.
    // The transaction stays open and atomic across those yields (verified directly against real
    // Chromium: a request made from inside an earlier request's success handler keeps a
    // transaction active), so a crash mid-save still aborts the whole thing rather than leaving a
    // partial tile grid — the same all-or-nothing guarantee as before, just spread over more,
    // smaller tasks. A save with few dirty tiles (the overwhelmingly common case: one stroke's
    // worth) never crosses the batch boundary, so it stays exactly as before: one synchronous loop,
    // zero added yields.
    let tileCount = 0;
    for (const tile of snapshot.tiles) {
      const tileRecord: TileRecord = {
        id: snapshot.id,
        tx: tile.tx,
        ty: tile.ty,
        pixels: tile.pixels,
      };
      const request = tiles.put(tileRecord);
      tileCount++;
      if (tileCount % SAVE_BATCH_TILE_COUNT === 0) await requestToPromise(request);
    }
    // Commits the instant every put above is queued, instead of leaving it to auto-commit once
    // the microtask queue drains: that implicit drain is exactly the gap a fast reload could win
    // (see the comment on `CRASH_RECOVERY_MAX_BYTES` above).
    tx.commit();
    await transactionDone(tx);
    // This write is now durably committed in IndexedDB; the crash-recovery fallback would only
    // ever be needed to cover for exactly this line never being reached.
    clearCrashRecovery(snapshot.id);

    // Fire-and-forget: patch in the real thumbnail once the worker replies, in its own
    // transaction. This never blocks the write above (or a `pagehide` flush racing it) on the
    // round trip; if the page dies before it settles, the document just keeps its prior preview.
    void patchThumbnail(snapshot.id, thumbnail);
  }

  async function patchThumbnail(
    id: DocumentId,
    thumbnail: Uint8Array | Promise<Uint8Array>,
  ): Promise<void> {
    try {
      const resolvedThumbnail = await thumbnail;
      lastKnownThumbnail.set(id, resolvedThumbnail);
      const db = await dbPromise;
      const tx = db.transaction(DOCUMENTS_STORE, 'readwrite');
      const store = tx.objectStore(DOCUMENTS_STORE);
      const current = (await requestToPromise(store.get(id))) as DocumentRecord | undefined;
      if (current) store.put({ ...current, thumbnail: resolvedThumbnail });
      await transactionDone(tx);
    } catch {
      // Best-effort: a failed or aborted thumbnail patch just leaves the previous preview in place.
    }
  }

  async function renameNow(id: DocumentId, name: string): Promise<void> {
    const db = await dbPromise;
    const tx = db.transaction(DOCUMENTS_STORE, 'readwrite');
    const store = tx.objectStore(DOCUMENTS_STORE);
    const existing = await requestToPromise(store.get(id));
    if (existing) store.put({ ...existing, name, updatedAt: Date.now() });
    await transactionDone(tx);
  }

  async function removeNow(id: DocumentId): Promise<void> {
    const db = await dbPromise;
    const tx = db.transaction([DOCUMENTS_STORE, TILES_STORE], 'readwrite');
    tx.objectStore(DOCUMENTS_STORE).delete(id);
    deleteAllTiles(tx, id);
    tx.commit();
    await transactionDone(tx);
    lastKnownThumbnail.delete(id);
    clearCrashRecovery(id);
  }

  return {
    save(snapshot: DocumentSnapshot, thumbnail: Uint8Array | Promise<Uint8Array>): Promise<void> {
      // If a write is already in flight for this id, `thumbnail` sits unreferenced until this
      // save's turn comes up in the chain — nothing has awaited or attached to it yet. Attach a
      // no-op catch immediately so a rejection in the meantime doesn't surface as an unhandled
      // rejection; `saveNow` still awaits the same promise for its actual value (or failure)
      // once its turn comes, so a real failure still propagates to this call's caller normally.
      Promise.resolve(thumbnail).catch(() => {});
      return writes.run(snapshot.id, () => saveNow(snapshot, thumbnail));
    },

    stashForRecovery(snapshot: DocumentSnapshot): void {
      stashForCrashRecovery(snapshot);
    },

    rename(id: DocumentId, name: string): Promise<void> {
      return writes.run(id, () => renameNow(id, name));
    },

    async load(id: DocumentId): Promise<LoadedDocument | null> {
      // Wait for every write already chained for this id before reading, so a route with
      // `gcTime: 0` re-reading right after a navigation-triggered flush can't observe a partial
      // or stale write.
      await writes.settle(id);
      const db = await dbPromise;
      const tx = db.transaction([DOCUMENTS_STORE, TILES_STORE], 'readonly');
      const record = (await requestToPromise(tx.objectStore(DOCUMENTS_STORE).get(id))) as
        | DocumentRecord
        | undefined;
      if (record) lastKnownThumbnail.set(id, record.thumbnail);
      const index = tx.objectStore(TILES_STORE).index(TILES_BY_ID_INDEX);
      const tileRecords = (await requestToPromise(
        index.getAll(IDBKeyRange.only(id)),
      )) as TileRecord[];
      await transactionDone(tx);

      const recovery = readCrashRecovery(id);
      if (recovery && (!record || recovery.updatedAt > record.updatedAt)) {
        // The crash-recovery fallback caught every tile not yet confirmed committed for this id
        // at the moment the page actually exited (see `attachAutosave`'s pagehide/hidden
        // handling) — covering exactly the close-page teardown IndexedDB itself can't always
        // survive (see the comment on `CRASH_RECOVERY_MAX_BYTES` above). Rebuild from whatever IndexedDB already has — unless that recovered flush was itself a
        // full resave, in which case the old grid is stale and only the recovered tiles apply —
        // then persist the recovered state now that there's a live page to do it durably, and
        // only then retire the fallback entry.
        const { width, height } = recovery;
        const pixels = new Uint8Array(width * height * 4);
        if (record && !recovery.fullResave) {
          for (const tile of tileRecords) writeTile(pixels, width, height, tile);
        }
        const recoveredTiles: TileSnapshot[] = recovery.tiles.map((tile) => ({
          tx: tile.tx,
          ty: tile.ty,
          pixels: base64ToBytes(tile.pixels),
        }));
        for (const tile of recoveredTiles) writeTile(pixels, width, height, tile);

        const recoveryColorSpace: DocumentColorSpace =
          recovery.colorSpace ?? record?.colorSpace ?? 'srgb';
        const recoverySnapshot: DocumentSnapshot = {
          id,
          name: recovery.name,
          width,
          height,
          updatedAt: recovery.updatedAt,
          tiles: recoveredTiles,
          fullResave: !record || recovery.fullResave,
          thumbnailPixels: { width: 0, height: 0, pixels: new Uint32Array(0) },
          colorSpace: recoveryColorSpace,
        };
        // A document that crashed before its first real thumbnail ever computed has nothing in
        // `lastKnownThumbnail` to carry forward: give it a real one now (a cheap, one-shot
        // encode) instead of leaving Recent Documents showing a blank tile until the next edit.
        const thumbnail =
          lastKnownThumbnail.get(id) ??
          (await buildRecoveredThumbnail(pixels, width, height, recoveryColorSpace));
        await writes.run(id, () => saveNow(recoverySnapshot, thumbnail));
        clearCrashRecovery(id);
        return { id, name: recovery.name, width, height, pixels, colorSpace: recoveryColorSpace };
      }
      if (recovery) clearCrashRecovery(id);

      if (!record) return null;
      const pixels = new Uint8Array(record.width * record.height * 4);
      for (const tile of tileRecords) {
        writeTile(pixels, record.width, record.height, tile);
      }
      return {
        id: record.id,
        name: record.name,
        width: record.width,
        height: record.height,
        pixels,
        colorSpace: record.colorSpace ?? 'srgb',
      };
    },

    remove(id: DocumentId): Promise<void> {
      return writes.run(id, () => removeNow(id));
    },

    async listRecents(): Promise<DocumentSummary[]> {
      const db = await dbPromise;
      const tx = db.transaction(DOCUMENTS_STORE, 'readonly');
      const records = (await requestToPromise(
        tx.objectStore(DOCUMENTS_STORE).getAll(),
      )) as DocumentRecord[];
      await transactionDone(tx);
      return records
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((record) => ({
          id: record.id,
          name: record.name,
          width: record.width,
          height: record.height,
          updatedAt: record.updatedAt,
          thumbnail: new Blob([record.thumbnail as BlobPart], { type: 'image/png' }),
        }));
    },
  };
}
