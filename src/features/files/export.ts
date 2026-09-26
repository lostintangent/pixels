import type { BitmapDocument } from '../document';
import { encodePngOffMainThread } from './runtime/pngWorkerClient';

/** Exports a document as an 8-bit RGBA PNG, at 1x or an integer upscale. Runs off the main thread:
 *  worst-case pixel content can take tens of milliseconds to deflate, and export must never jank
 *  the canvas the user is looking at while it waits. */
export async function exportPng(
  document: BitmapDocument,
  options: { scale?: number } = {},
): Promise<Uint8Array> {
  return encodePngOffMainThread(
    document.width,
    document.height,
    document.pixels,
    options.scale ?? 1,
  );
}
