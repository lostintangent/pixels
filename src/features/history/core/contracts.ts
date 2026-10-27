import type { BitmapDocument, PixelRect } from '../../document';

/** Capture before the first write to each touched tile in one user operation. */
export interface HistoryTransaction {
  capture(rect: PixelRect): void;
  /** Keep only changed 64 px blocks from an earlier full capture when sparse. */
  narrowFullCapture(changedTiles: Uint8Array, dirty: PixelRect): void;
  commit(): boolean;
  cancel(): void;
}

/** A feature can join the pixel undo stack without becoming a history dependency. */
export interface HistoryExternalState {
  snapshot(): unknown;
  restore(snapshot: unknown): void;
  equals(before: unknown, after: unknown): boolean;
  byteSize(snapshot: unknown): number;
}

export type HistoryChange = PixelRect | { document: BitmapDocument };

export interface DocumentHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly usedBytes: number;
  readonly maxBytes: number;
  begin(document: BitmapDocument, external?: HistoryExternalState): HistoryTransaction;
  /** A dimension change swaps whole document objects in the same ordered stack. */
  pushReplacement(before: BitmapDocument, after: BitmapDocument): void;
  undo(document: BitmapDocument): HistoryChange | null;
  redo(document: BitmapDocument): HistoryChange | null;
  clear(): void;
}
