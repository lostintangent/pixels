import { findAnnotationsFor } from '../annotations/model';
import type { BitmapDocument } from '../document';
import { encodePngOffMainThread } from './runtime/pngWorkerClient';

/** Exports a document as an 8-bit RGBA PNG, at 1x or an integer upscale. Runs off the main thread:
 *  worst-case pixel content can take tens of milliseconds to deflate, and export must never jank
 *  the canvas the user is looking at while it waits. Committed shapes (if any) are baked into the
 *  exported bytes in the worker, so the file matches exactly what the canvas shows; an in-progress
 *  preview shape (not yet committed) is intentionally excluded, same as autosave. */
export async function exportPng(
  document: BitmapDocument,
  options: { scale?: number } = {},
): Promise<Uint8Array> {
  const shapes = findAnnotationsFor(document)?.snapshot() ?? [];
  return encodePngOffMainThread(
    document.width,
    document.height,
    document.pixels,
    options.scale ?? 1,
    document.colorSpace,
    shapes,
  );
}
