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

/** Real IndexedDB persistence. Under `bun test`, `fake-indexeddb/auto` provides the same global.
 *  `databaseName` defaults to the app's single database; tests override it for isolation. */
export function createDocumentStore(options: { databaseName?: string } = {}): DocumentStore {
  const dbPromise = openDatabase(options.databaseName ?? DB_NAME);

  return {
    async save(snapshot: DocumentSnapshot, thumbnail: Uint8Array): Promise<void> {
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
        thumbnail,
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
    },

    async rename(id: DocumentId, name: string): Promise<void> {
      const db = await dbPromise;
      const tx = db.transaction(DOCUMENTS_STORE, 'readwrite');
      const store = tx.objectStore(DOCUMENTS_STORE);
      const existing = await requestToPromise(store.get(id));
      if (existing) store.put({ ...existing, name, updatedAt: Date.now() });
      await transactionDone(tx);
    },

    async load(id: DocumentId): Promise<LoadedDocument | null> {
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

    async remove(id: DocumentId): Promise<void> {
      const db = await dbPromise;
      const tx = db.transaction([DOCUMENTS_STORE, TILES_STORE], 'readwrite');
      tx.objectStore(DOCUMENTS_STORE).delete(id);
      await deleteAllTiles(tx, id);
      await transactionDone(tx);
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
