import type { DocumentColorSpace } from '../core/contracts';

/** Convert raw RGBA bytes for a paste into a document with another color space. */
export function convertPixelColorSpace(
  pixels: Uint32Array,
  width: number,
  height: number,
  from: DocumentColorSpace,
  to: DocumentColorSpace,
): Uint32Array {
  if (from === to) return pixels;
  const source = globalThis.document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceCtx = source.getContext('2d', { colorSpace: from });
  const target = globalThis.document.createElement('canvas');
  target.width = width;
  target.height = height;
  const targetCtx = target.getContext('2d', { colorSpace: to });
  if (!sourceCtx || !targetCtx) throw new Error('Canvas color conversion is unavailable');
  const bytes = new Uint8ClampedArray(
    pixels.buffer as ArrayBuffer,
    pixels.byteOffset,
    pixels.byteLength,
  );
  sourceCtx.putImageData(new ImageData(bytes, width, height, { colorSpace: from }), 0, 0);
  targetCtx.drawImage(source, 0, 0);
  const result = targetCtx.getImageData(0, 0, width, height, { colorSpace: to });
  return new Uint32Array(result.data.buffer, result.data.byteOffset, width * height).slice();
}
