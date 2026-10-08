import type { BitmapDocument } from './contracts';
import { createBitmapDocument } from './bitmap';

export type CanvasAnchor =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

export function canvasAnchorOffset(
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  anchor: CanvasAnchor,
): { x: number; y: number } {
  // Truncation keeps odd grow and shrink offsets inverse, with the extra pixel at right/bottom.
  return {
    x: anchor.endsWith('left')
      ? 0
      : anchor.endsWith('right')
        ? width - sourceWidth
        : Math.trunc((width - sourceWidth) / 2),
    y: anchor.startsWith('top')
      ? 0
      : anchor.startsWith('bottom')
        ? height - sourceHeight
        : Math.trunc((height - sourceHeight) / 2),
  };
}

export function resizeDocument(
  document: BitmapDocument,
  width: number,
  height: number,
  anchor: CanvasAnchor = 'center',
): BitmapDocument {
  const output = createBitmapDocument(
    document.id,
    width,
    height,
    document.name,
    document.colorSpace,
  );
  const { x: offsetX, y: offsetY } = canvasAnchorOffset(
    document.width,
    document.height,
    width,
    height,
    anchor,
  );
  const fromX = Math.max(0, -offsetX);
  const fromY = Math.max(0, -offsetY);
  const toX = Math.max(0, offsetX);
  const toY = Math.max(0, offsetY);
  const copyWidth = Math.min(document.width - fromX, width - toX);
  const copyHeight = Math.min(document.height - fromY, height - toY);
  if (copyWidth > 0 && copyHeight > 0) {
    for (let row = 0; row < copyHeight; row++) {
      const source = (fromY + row) * document.width + fromX;
      const target = (toY + row) * width + toX;
      output.pixels.set(document.pixels.subarray(source, source + copyWidth), target);
    }
  }
  output.revision = document.revision + 1;
  return output;
}
