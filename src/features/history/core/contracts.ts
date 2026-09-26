import type { BitmapDocument, PixelRect } from '../../document';

/** Capture before the first write to each touched tile in one user operation. */
export interface HistoryTransaction {
  capture(rect: PixelRect): void;
  commit(): boolean;
  cancel(): void;
}

export interface DocumentHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly usedBytes: number;
  readonly maxBytes: number;
  begin(label: string, document: BitmapDocument): HistoryTransaction;
  undo(document: BitmapDocument): PixelRect | null;
  redo(document: BitmapDocument): PixelRect | null;
  clear(): void;
}
