import type {
  DocumentId,
  DocumentSnapshot,
  DocumentStore,
  DocumentSummary,
  LoadedDocument,
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

  async function saveNow(
    snapshot: DocumentSnapshot,
    thumbnail: Uint8Array | Promise<Uint8Array>,
  ): Promise<void> {
    // Resolve the thumbnail (and open the database) before touching IndexedDB. Both can run
    // while this write already holds its place in the per-id chain, so nothing else for this id
    // can start — or finish being waited on by `load` — until this write actually commits.
    const [db, resolvedThumbnail] = await Promise.all([dbPromise, thumbnail]);
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
      thumbnail: resolvedThumbnail,
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
  }

  return {
    save(snapshot: DocumentSnapshot, thumbnail: Uint8Array | Promise<Uint8Array>): Promise<void> {
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
      if (!record) return null;
      const index = tx.objectStore(TILES_STORE).index(TILES_BY_ID_INDEX);
      const tileRecords = (await requestToPromise(
        index.getAll(IDBKeyRange.only(id)),
      )) as TileRecord[];
      await transactionDone(tx);

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
