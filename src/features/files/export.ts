import type { BitmapDocument } from '../document';
import { encodePng } from './core/png';

/** Exports a document as an 8-bit RGBA PNG, at 1x or an integer upscale. */
export async function exportPng(
  document: BitmapDocument,
  options: { scale?: number } = {},
): Promise<Uint8Array> {
  return encodePng(document.width, document.height, document.pixels, options.scale ?? 1);
}
