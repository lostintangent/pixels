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
  tiles: TileSnapshot[];
  /** True when every tile must be written and any stale tiles from a previous, larger size removed. */
  fullResave: boolean;
  /** Raw, already-detached thumbnail pixels. PNG-encoding happens after the snapshot, off the live buffer. */
  thumbnailPixels: { width: number; height: number; pixels: Uint32Array };
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
