import { createBitmapDocument, type BitmapDocument, MAX_DOCUMENT_SIDE } from '../document';
import { ImportError } from './core/contracts';
import { decodePngOffMainThread } from './runtime/pngWorkerClient';

/**
 * Decodes a PNG and builds a live document from it. Byte-in only: the file picker, drag and
 * drop, and clipboard paste handlers all convert their input to bytes and call this one path.
 * Decoding runs off the main thread (see `pngWorkerClient`), so opening a large photo never
 * becomes a long task on the thread the user is interacting with.
 */
export async function importPng(
  source: Uint8Array | ArrayBuffer | Blob,
  id: string,
  name = 'Untitled',
): Promise<BitmapDocument> {
  const bytes = await toBytes(source);
  const decoded = await decodePngOffMainThread(bytes);
  if (decoded.width > MAX_DOCUMENT_SIDE || decoded.height > MAX_DOCUMENT_SIDE) {
    throw new ImportError(
      'too-large',
      `This PNG is ${decoded.width} x ${decoded.height}. Pixels opens images up to ${MAX_DOCUMENT_SIDE} x ${MAX_DOCUMENT_SIDE}.`,
    );
  }
  const document = createBitmapDocument(id, decoded.width, decoded.height, name);
  document.pixels.set(decoded.pixels);
  return document;
}

async function toBytes(source: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(await source.arrayBuffer());
}
