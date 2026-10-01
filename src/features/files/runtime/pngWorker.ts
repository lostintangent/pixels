/// <reference lib="webworker" />
import type { DocumentColorSpace } from '../../document';
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
}

interface DecodeRequest {
  kind: 'decode';
  id: number;
  bytes: ArrayBuffer;
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

interface Failure {
  kind: 'encode' | 'decode';
  id: number;
  error: { name: string; message: string; reason?: ImportErrorReason };
}

export type EncodeResponse = EncodeSuccess | Failure;
export type DecodeResponse = DecodeSuccess | Failure;

function failureOf(kind: 'encode' | 'decode', id: number, error: unknown): Failure {
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
self.addEventListener('message', (event: MessageEvent<EncodeRequest | DecodeRequest>) => {
  const request = event.data;
  if (request.kind === 'encode') {
    const { id, width, height, scale, colorSpace, pixels } = request;
    void encodePng(width, height, new Uint32Array(pixels), scale, colorSpace).then(
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
  } else {
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
  }
});
