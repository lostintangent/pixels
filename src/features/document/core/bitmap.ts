import type {
  BitmapDocument,
  DocumentColorSpace,
  PackedColor,
  PixelPoint,
  PixelRect,
} from './contracts';

export const MAX_DOCUMENT_SIDE = 4096;

export function packRgba(red: number, green: number, blue: number, alpha = 255): PackedColor {
  return (((alpha & 255) << 24) | ((blue & 255) << 16) | ((green & 255) << 8) | (red & 255)) >>> 0;
}

export function createBitmapDocument(
  id: string,
  width: number,
  height: number,
  name = 'Untitled',
  colorSpace: DocumentColorSpace = 'srgb',
  initialPixels?: Uint32Array,
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
  if (
    initialPixels &&
    (initialPixels.length !== width * height ||
      initialPixels.byteOffset !== 0 ||
      initialPixels.buffer.byteLength !== width * height * 4)
  ) {
    throw new RangeError('Initial pixel buffer must exactly match the canvas dimensions');
  }
  // A decoded PNG arrives as a transferred buffer. Adopt it instead of allocating and
  // copying a second full-size buffer on the browser's main thread.
  const pixels = initialPixels ?? new Uint32Array(width * height);
  const listeners = new Set<(rect: PixelRect, revision: number) => void>();
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
  const document: BitmapDocument = {
    id,
    name,
    colorSpace,
    width,
    height,
    pixels,
    rgbaBytes: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    revision: 0,
    events,
  };
  return document;
}

export function getPixel(document: BitmapDocument, at: PixelPoint): PackedColor | null {
  if (at.x < 0 || at.y < 0 || at.x >= document.width || at.y >= document.height) return null;
  return document.pixels[at.y * document.width + at.x] ?? null;
}
