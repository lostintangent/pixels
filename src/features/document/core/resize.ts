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
  const offsetX = anchor.endsWith('left')
    ? 0
    : anchor.endsWith('right')
      ? width - document.width
      : Math.floor((width - document.width) / 2);
  const offsetY = anchor.startsWith('top')
    ? 0
    : anchor.startsWith('bottom')
      ? height - document.height
      : Math.floor((height - document.height) / 2);
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
