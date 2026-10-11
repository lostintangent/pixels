import {
  createBitmapDocument,
  type BitmapDocument,
  type DocumentColorSpace,
  MAX_DOCUMENT_SIDE,
} from '../document';
import { ImportError } from './core/contracts';
import {
  convertUnknownIccPngToDisplayP3OffMainThread,
  decodePngOffMainThread,
} from './runtime/pngWorkerClient';

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
      `This PNG is ${decoded.width} × ${decoded.height}. Pixels opens images up to ${MAX_DOCUMENT_SIDE} × ${MAX_DOCUMENT_SIDE}.`,
    );
  }
  let colorSpace: DocumentColorSpace = 'srgb';
  let pixels = decoded.pixels;
  if (decoded.colorTag === 'unknown-icc') {
    // A real, embedded profile we can't classify ourselves: hand the original bytes to the
    // browser's own ICC color management rather than guessing, off the main thread (a full
    // canvas round-trip at photo sizes is real work). `converted` is `null` only when the host
    // has neither a worker nor the canvas APIs the conversion needs, in which case the
    // already-decoded pixels (exact, just not color-corrected) are kept as plain sRGB.
    const converted = await convertUnknownIccPngToDisplayP3OffMainThread(
      bytes,
      decoded.width,
      decoded.height,
    );
    if (converted) {
      colorSpace = 'display-p3';
      pixels = converted;
    }
  } else {
    colorSpace = decoded.colorTag;
  }
  return createBitmapDocument(id, decoded.width, decoded.height, name, colorSpace, pixels);
}

async function toBytes(source: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(await source.arrayBuffer());
}
