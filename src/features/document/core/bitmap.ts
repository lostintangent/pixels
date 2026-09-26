import type { BitmapDocument, PackedColor, PixelPoint, PixelRect } from './contracts';

export const MAX_DOCUMENT_SIDE = 4096;

export function packRgba(red: number, green: number, blue: number, alpha = 255): PackedColor {
  return (((alpha & 255) << 24) | ((blue & 255) << 16) | ((green & 255) << 8) | (red & 255)) >>> 0;
}

export function createBitmapDocument(
  id: string,
  width: number,
  height: number,
  name = 'Untitled',
): BitmapDocument {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DOCUMENT_SIDE ||
    height > MAX_DOCUMENT_SIDE
  ) {
    throw new RangeError(`Canvas dimensions must be integers from 1 to ${MAX_DOCUMENT_SIDE}`);
  }
  const buffer = new ArrayBuffer(width * height * 4);
  const listeners = new Set<(rect: PixelRect, revision: number) => void>();
  let document: BitmapDocument;
  const events = {
    subscribe(listener: (rect: PixelRect, revision: number) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate(rect: PixelRect) {
      document.revision++;
      for (const listener of listeners) listener(rect, document.revision);
    },
  };
  document = {
    id,
    name,
    width,
    height,
    pixels: new Uint32Array(buffer),
    rgbaBytes: new Uint8ClampedArray(buffer),
    revision: 0,
    events,
  };
  return document;
}

export function getPixel(document: BitmapDocument, at: PixelPoint): PackedColor | null {
  if (at.x < 0 || at.y < 0 || at.x >= document.width || at.y >= document.height) return null;
  return document.pixels[at.y * document.width + at.x] ?? null;
}
