/// <reference lib="webworker" />
import type { Annotation } from '../../annotations';
import type { DocumentColorSpace } from '../../document';
import { createScaledShapeOverlay, flattenShapesForExport } from '../browser/flattenForExport';
import { convertUnknownIccPngToDisplayP3 } from '../browser/pngColorManagement';
import { ImportError, type ImportErrorReason } from '../core/contracts';
import { decodePng, encodePng } from '../core/png';

interface EncodeRequest {
  kind: 'encode';
  id: number;
  width: number;
  height: number;
  scale: number;
  colorSpace: DocumentColorSpace;
  pixels: ArrayBuffer;
  /** Committed shapes to bake into the exported bytes; omitted (or empty) for a document with
   *  none, which is the common case. */
  shapes?: readonly Annotation[];
}

interface DecodeRequest {
  kind: 'decode';
  id: number;
  bytes: ArrayBuffer;
}

interface ConvertUnknownIccRequest {
  kind: 'convertUnknownIcc';
  id: number;
  bytes: ArrayBuffer;
  width: number;
  height: number;
}

interface EncodeSuccess {
  kind: 'encode';
  id: number;
  bytes: ArrayBuffer;
}

interface DecodeSuccess {
  kind: 'decode';
  id: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
  colorTag: DocumentColorSpace | 'unknown-icc';
}

interface ConvertUnknownIccSuccess {
  kind: 'convertUnknownIcc';
  id: number;
  /** `null` when the worker host lacks the APIs this conversion needs (e.g. under `bun test`). */
  pixels: ArrayBuffer | null;
}

interface Failure {
  kind: 'encode' | 'decode' | 'convertUnknownIcc';
  id: number;
  error: { name: string; message: string; reason?: ImportErrorReason };
}

export type EncodeResponse = EncodeSuccess | Failure;
export type DecodeResponse = DecodeSuccess | Failure;
export type ConvertUnknownIccResponse = ConvertUnknownIccSuccess | Failure;

function failureOf(
  kind: 'encode' | 'decode' | 'convertUnknownIcc',
  id: number,
  error: unknown,
): Failure {
  return {
    kind,
    id,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      reason: error instanceof ImportError ? error.reason : undefined,
    },
  };
}

/**
 * Runs the PNG codec off the main thread. Worst-case (near-random) pixel content can take tens
 * of milliseconds under `CompressionStream`/`DecompressionStream`, and a large photo's decode
 * (unfiltering plus per-pixel sample expansion) is squarely main-thread work too — both would
 * otherwise be long tasks blocking input and paint, which a dedicated worker removes entirely.
 */
self.addEventListener(
  'message',
  (event: MessageEvent<EncodeRequest | DecodeRequest | ConvertUnknownIccRequest>) => {
    const request = event.data;
    if (request.kind === 'encode') {
      const { id, width, height, scale, colorSpace, pixels, shapes = [] } = request;
      // At 1×, document resolution *is* output resolution, so shapes are flattened onto the
      // pixels up front exactly as before — the unchanged path a 1× export always took. A scaled
      // export instead keeps the raw pixels and gives `encodePng` an overlay that paints shapes
      // directly at the output scale, in bounded row bands, so their anti-aliased edges stay
      // crisp instead of blurring under a later nearest-neighbor upscale.
      let source: Uint32Array;
      let overlay: ReturnType<typeof createScaledShapeOverlay> | undefined;
      try {
        // Synchronous: a missing canvas API (only possible under `bun test`, never in a real
        // browser worker) throws here, before any promise chain exists to catch it.
        if (scale === 1) {
          source = flattenShapesForExport(
            new Uint32Array(pixels),
            width,
            height,
            colorSpace,
            shapes,
          );
        } else {
          source = new Uint32Array(pixels);
          if (shapes.length) overlay = createScaledShapeOverlay(shapes, colorSpace, scale);
        }
      } catch (error) {
        (self as unknown as Worker).postMessage(failureOf('encode', id, error));
        return;
      }
      void encodePng(width, height, source, scale, colorSpace, overlay).then(
        (bytes) => {
          // `.slice()` guarantees an exactly-sized, standalone buffer, safe to transfer regardless
          // of whether `bytes` happens to be a view over a larger backing buffer.
          const owned = bytes.slice().buffer as ArrayBuffer;
          const response: EncodeSuccess = { kind: 'encode', id, bytes: owned };
          (self as unknown as Worker).postMessage(response, [owned]);
        },
        (error: unknown) => {
          (self as unknown as Worker).postMessage(failureOf('encode', id, error));
        },
      );
    } else if (request.kind === 'decode') {
      const { id, bytes } = request;
      void decodePng(bytes).then(
        (decoded) => {
          const owned = decoded.pixels.buffer as ArrayBuffer;
          const response: DecodeSuccess = {
            kind: 'decode',
            id,
            width: decoded.width,
            height: decoded.height,
            pixels: owned,
            colorTag: decoded.colorTag,
          };
          (self as unknown as Worker).postMessage(response, [owned]);
        },
        (error: unknown) => {
          (self as unknown as Worker).postMessage(failureOf('decode', id, error));
        },
      );
    } else {
      const { id, bytes, width, height } = request;
      void convertUnknownIccPngToDisplayP3(new Uint8Array(bytes), width, height).then(
        (pixels) => {
          const owned = pixels ? (pixels.slice().buffer as ArrayBuffer) : null;
          const response: ConvertUnknownIccSuccess = {
            kind: 'convertUnknownIcc',
            id,
            pixels: owned,
          };
          (self as unknown as Worker).postMessage(response, owned ? [owned] : []);
        },
        (error: unknown) => {
          (self as unknown as Worker).postMessage(failureOf('convertUnknownIcc', id, error));
        },
      );
    }
  },
);
