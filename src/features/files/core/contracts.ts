import type { Annotation } from '../../annotations/model';
import type { DocumentColorSpace } from '../../document';

/** File IO is intentionally outside the pixel hot path. */
export type DocumentId = string;

export type ImportErrorReason = 'too-large' | 'corrupt' | 'unsupported-format';

/** Message is a plain sentence the UI can show directly, no code-to-copy mapping needed. */
export class ImportError extends Error {
  readonly reason: ImportErrorReason;
  constructor(reason: ImportErrorReason, message: string) {
    super(message);
    this.name = 'ImportError';
    this.reason = reason;
  }
}

/** Only one reason today: IndexedDB couldn't make room for the write. Kept as a union (not a
 *  bare boolean) so a later distinction — say, a document too big for any quota versus one that
 *  would fit if something else were deleted first — can be added without changing callers that
 *  already narrow on `instanceof SaveError`. */
export type SaveErrorReason = 'storage-full';

/** Thrown by `DocumentStore.save`/`rename` in place of the raw `DOMException` IndexedDB produces
 *  when a write can't fit. The image or rename itself was never the problem, so, like
 *  `ImportError`, `message` is a plain sentence the UI shows as-is — one that doesn't blame the
 *  file. See `classifyStorageError` in `storage/documentStore.ts` for which underlying error
 *  names this covers and why. */
export class SaveError extends Error {
  readonly reason: SaveErrorReason;
  constructor(reason: SaveErrorReason, message: string) {
    super(message);
    this.name = 'SaveError';
    this.reason = reason;
  }
}

/** 64x64 keeps a full-document 4096x4096 write under 4,096 small puts, and a single-pixel edit at 16 KB. */
export const TILE_SIZE = 64;

export interface TileCoord {
  tx: number;
  ty: number;
}

/** Always TILE_SIZE x TILE_SIZE RGBA bytes; edge tiles pad with zero past the live document bounds. */
export interface TileSnapshot extends TileCoord {
  pixels: Uint8Array;
}

/** Built synchronously from the live document before any await, so a later buffer swap can't corrupt it. */
export interface DocumentSnapshot {
  id: DocumentId;
  name: string;
  width: number;
  height: number;
  updatedAt: number;
  /** Already-extracted tile bytes for an incremental (dirty-tile) save — cheap, since it's only
   *  ever a handful of tiles. Empty when `fullResave` is true; see `fullResaveBytes` instead. */
  tiles: TileSnapshot[];
  /** True when every tile must be written and any stale tiles from a previous, larger size removed. */
  fullResave: boolean;
  /** Every committed shape, captured synchronously alongside pixels (not tiled — there's always
   *  just one current list, regardless of `fullResave`). Empty for a document with no shapes, or
   *  one no gesture has ever touched this session (see `findAnnotationsFor`). */
  shapes: Annotation[];
  /** Only set when `fullResave` is true: one synchronous copy of the whole live buffer, captured
   *  before any await so a later stroke or undo swapping the document's buffer can't corrupt it —
   *  the same guarantee eager per-tile extraction gave, but without paying for splitting every
   *  tile out of it (thousands, at a large canvas) in one unbroken task before the first write.
   *  Whoever persists this snapshot extracts tiles from it lazily, via `extractAllTiles`. */
  fullResaveBytes?: Uint8Array;
  /** Raw, already-detached thumbnail pixels. PNG-encoding happens after the snapshot, off the
   *  live buffer. `scale` is the document-to-thumbnail factor `buildThumbnail` picked, so shapes
   *  (in document-space coordinates) can be mapped into this smaller canvas before encoding. */
  thumbnailPixels: { width: number; height: number; pixels: Uint32Array; scale: number };
  colorSpace: DocumentColorSpace;
}

export interface DocumentSummary {
  id: DocumentId;
  name: string;
  width: number;
  height: number;
  updatedAt: number;
  thumbnail: Blob;
}

export interface LoadedDocument {
  id: DocumentId;
  name: string;
  width: number;
  height: number;
  /** Raw RGBA bytes, width * height * 4, reassembled from tiles. */
  pixels: Uint8Array;
  colorSpace: DocumentColorSpace;
  /** Already validated with `isValidAnnotation`; a record with corrupt entries just drops them,
   *  never fails the whole load. Empty for a document with no shapes. */
  shapes: Annotation[];
}

export interface DocumentStore {
  /**
   * `thumbnail` is PNG bytes encoded from a detached snapshot copy. Pass the encode's promise
   * straight through rather than awaiting it first: `save` reserves this id's place in the
   * store's write order the instant it's called, before it awaits anything, so a `load(id)`
   * issued right after — even while the thumbnail is still encoding — correctly waits for it.
   */
  save(snapshot: DocumentSnapshot, thumbnail: Uint8Array | Promise<Uint8Array>): Promise<void>;
  /**
   * A synchronous, `localStorage`-backed fallback for the one narrow teardown window a
   * synchronously-committed IndexedDB write still can't cover: the browser discarding an
   * already-committed transaction when the page actually closes (not reloads). Call this only
   * from an exit signal (`pagehide`, or `visibilitychange` going hidden) with every tile not yet
   * confirmed committed for the id — never from a routine debounced save, which already reaches
   * IndexedDB on its own.
   */
  stashForRecovery(snapshot: DocumentSnapshot): void;
  rename(id: DocumentId, name: string): Promise<void>;
  load(id: DocumentId): Promise<LoadedDocument | null>;
  remove(id: DocumentId): Promise<void>;
  listRecents(): Promise<DocumentSummary[]>;
}

export type AutosaveStatus = 'saved' | 'saving' | 'error';

export interface AutosaveClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface AutosaveOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  clock?: AutosaveClock;
  onStatus?: (status: AutosaveStatus, error?: unknown) => void;
}
