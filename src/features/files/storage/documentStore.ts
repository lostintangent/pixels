import type {
  DocumentId,
  DocumentSnapshot,
  DocumentStore,
  DocumentSummary,
  LoadedDocument,
  TileSnapshot,
} from '../core/contracts';
import { writeTile } from '../core/tiles';

const DB_NAME = 'pixels-files';
const DB_VERSION = 1;
const DOCUMENTS_STORE = 'documents';
const TILES_STORE = 'tiles';
const TILES_BY_ID_INDEX = 'by_id';

interface DocumentRecord {
  id: DocumentId;
  name: string;
  width: number;
  height: number;
  updatedAt: number;
  thumbnail: Uint8Array;
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

/** Deletes every stored tile for a document id, used before a full resave replaces the whole grid. */
function deleteAllTiles(tx: IDBTransaction, id: DocumentId): Promise<void> {
  return new Promise((resolve, reject) => {
    const index = tx.objectStore(TILES_STORE).index(TILES_BY_ID_INDEX);
    const cursorRequest = index.openCursor(IDBKeyRange.only(id));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
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
}

// A real, confirmed browser behavior (not something application code can restructure around): an
// immediate `location.reload()` can discard a page before an already-queued IndexedDB
// transaction's commit reaches durable storage, even when every `put` was submitted synchronously
// the instant `pagehide` fired — closing the page instead reliably lets that same commit land.
// `localStorage.setItem` is a genuinely synchronous, blocking write with no such gap, so it
// survives exactly the teardown IndexedDB doesn't. This is a pure safety net for that one narrow
// window, not a second primary write path — capped in size so a large simultaneous edit just
// forgoes it rather than risking `localStorage`'s much smaller quota.
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
    // Stashed first, before this function's first await: submitting `documents.put`/`tiles.put`
    // synchronously (below) already reaches IndexedDB the instant a `pagehide` flush runs, but a
    // reload can still discard the page before that queued transaction's commit lands. This
    // synchronous fallback has no such gap — see its definition above.
    stashForCrashRecovery(snapshot);
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

    if (snapshot.fullResave) await deleteAllTiles(tx, snapshot.id);

    const record: DocumentRecord = {
      id: snapshot.id,
      name: snapshot.name,
      width: snapshot.width,
      height: snapshot.height,
      updatedAt: snapshot.updatedAt,
      // Keep whatever thumbnail is already known (or a blank placeholder for a brand-new
      // document) until the real one resolves below — it's a preview icon, not document data.
      thumbnail: lastKnownThumbnail.get(snapshot.id) ?? new Uint8Array(0),
    };
    documents.put(record);
    for (const tile of snapshot.tiles) {
      const tileRecord: TileRecord = {
        id: snapshot.id,
        tx: tile.tx,
        ty: tile.ty,
        pixels: tile.pixels,
      };
      tiles.put(tileRecord);
    }
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
    await deleteAllTiles(tx, id);
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
        // The crash-recovery fallback caught tiles a `pagehide` flush queued for IndexedDB but
        // whose commit the page's own teardown never let land (see `stashForCrashRecovery`).
        // Rebuild from whatever IndexedDB already has — unless that recovered flush was itself a
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

        const recoverySnapshot: DocumentSnapshot = {
          id,
          name: recovery.name,
          width,
          height,
          updatedAt: recovery.updatedAt,
          tiles: recoveredTiles,
          fullResave: !record || recovery.fullResave,
          thumbnailPixels: { width: 0, height: 0, pixels: new Uint32Array(0) },
        };
        await writes.run(id, () =>
          saveNow(recoverySnapshot, lastKnownThumbnail.get(id) ?? new Uint8Array(0)),
        );
        clearCrashRecovery(id);
        return { id, name: recovery.name, width, height, pixels };
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
