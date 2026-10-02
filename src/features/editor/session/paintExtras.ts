import type { BitmapDocument, PackedColor, PixelPoint } from '../../document';
import type { DocumentHistory } from '../../history';
import { beginLinePreview, FillWorkspace, floodFill, LinePreviewWorkspace } from '../../tools';
import type { Brush, LinePreview, MutationResult } from '../../tools/model';

export interface PaintExtras {
  fill(
    document: BitmapDocument,
    at: PixelPoint,
    color: PackedColor,
    history: DocumentHistory,
  ): MutationResult;
  line(
    document: BitmapDocument,
    at: PixelPoint,
    brush: Brush,
    history: DocumentHistory,
  ): LinePreview;
}

export function createPaintExtras(): PaintExtras {
  const fillWorkspace = new FillWorkspace();
  const lineWorkspace = new LinePreviewWorkspace();
  return {
    fill(document, at, color, history) {
      return floodFill(document, { at, color }, history, fillWorkspace);
    },
    line(document, at, brush, history) {
      return beginLinePreview(document, at, brush, history, lineWorkspace);
    },
  };
}
