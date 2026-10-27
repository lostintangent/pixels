import type { BitmapDocument, PackedColor, PixelPoint } from '../../document';
import type { DocumentHistory } from '../../history';
import { beginLinePreview, FillWorkspace, floodFill, LinePreviewWorkspace } from '../../tools';
import type { Brush } from '../../tools/model';

/** Fill and Line load on first use. Each keeps one workspace for the life of the session. */
export type PaintExtras = ReturnType<typeof createPaintExtras>;

export function createPaintExtras() {
  const fillWorkspace = new FillWorkspace();
  const lineWorkspace = new LinePreviewWorkspace();
  return {
    fill(document: BitmapDocument, at: PixelPoint, color: PackedColor, history: DocumentHistory) {
      return floodFill(document, { at, color }, history, fillWorkspace);
    },
    line(document: BitmapDocument, at: PixelPoint, brush: Brush, history: DocumentHistory) {
      return beginLinePreview(document, at, brush, history, lineWorkspace);
    },
  };
}
