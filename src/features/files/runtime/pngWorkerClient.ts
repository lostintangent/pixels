import type { Annotation } from '../../annotations';
import type { DocumentColorSpace } from '../../document';
import { ImportError, type ImportErrorReason } from '../core/contracts';
import type { DecodedPng } from '../core/png';
import type { ConvertUnknownIccResponse, DecodeResponse, EncodeResponse } from './pngWorker';

export interface PngWorkerClient {
  encode(
    width: number,
    height: number,
    pixels: Uint32Array,
    scale?: number,
    colorSpace?: DocumentColorSpace,
    shapes?: readonly Annotation[],
  ): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<DecodedPng>;
  convertUnknownIccToDisplayP3(
    bytes: Uint8Array,
    width: number,
    height: number,
  ): Promise<Uint32Array | null>;
  /** Terminates the underlying worker, if any. Tests use this to avoid leaking workers. */
  terminate(): void;
}

interface PendingEncode {
  kind: 'encode';
  resolve(bytes: Uint8Array): void;
  reject(error: unknown): void;
}

interface PendingDecode {
  kind: 'decode';
  resolve(decoded: DecodedPng): void;
  reject(error: unknown): void;
}

interface PendingConvertUnknownIcc {
  kind: 'convertUnknownIcc';
  resolve(pixels: Uint32Array | null): void;
  reject(error: unknown): void;
}

type Pending = PendingEncode | PendingDecode | PendingConvertUnknownIcc;

function reviveError(error: { name: string; message: string; reason?: ImportErrorReason }): Error {
  if (error.reason) return new ImportError(error.reason, error.message);
  const revived =
    error.name === 'RangeError'
      ? new RangeError(error.message)
      : error.name === 'TypeError'
        ? new TypeError(error.message)
        : new Error(error.message);
  revived.name = error.name;
  return revived;
}

/** Real worker-backed client: every call copies its input into a fresh, transferable buffer
 *  first, so it never risks detaching the caller's live document buffer or the original file
 *  bytes (e.g. a `Blob`'s backing buffer, which some code paths may still reference). */
function createWorkerBackedClient(onFatalError: () => void): PngWorkerClient {
  const worker = new Worker(new URL('./pngWorker.ts', import.meta.url), { type: 'module' });
  let nextRequestId = 1;
  const pending = new Map<number, Pending>();

  worker.addEventListener(
    'message',
    (event: MessageEvent<EncodeResponse | DecodeResponse | ConvertUnknownIccResponse>) => {
      const response = event.data;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if ('error' in response) {
        request.reject(reviveError(response.error));
      } else if (request.kind === 'encode' && response.kind === 'encode') {
        request.resolve(new Uint8Array(response.bytes));
      } else if (request.kind === 'decode' && response.kind === 'decode') {
        request.resolve({
          width: response.width,
          height: response.height,
          pixels: new Uint32Array(response.pixels),
          colorTag: response.colorTag,
        });
      } else if (request.kind === 'convertUnknownIcc' && response.kind === 'convertUnknownIcc') {
        request.resolve(response.pixels ? new Uint32Array(response.pixels) : null);
      }
    },
  );
  worker.addEventListener('error', (event: ErrorEvent) => {
    // A worker-level failure (e.g. a load error, most often a chunk 404 after a deploy, or a
    // flaky network dropping the script request) can't be correlated to one request; fail every
    // request still in flight rather than hanging them forever. The worker that failed to load
    // can never deliver another message either, so it's terminated and dropped from the shared
    // cache here too — otherwise every later call would keep reusing this dead worker, postMessage
    // into it forever, and never settle, which is exactly what left Open stuck on "Opening…".
    for (const [id, request] of pending) {
      request.reject(new Error(event.message || 'PNG worker failed'));
      pending.delete(id);
    }
    worker.terminate();
    onFatalError();
  });

  return {
    encode(
      width,
      height,
      pixels,
      scale = 1,
      colorSpace: DocumentColorSpace = 'srgb',
      shapes: readonly Annotation[],
    ) {
      const copy = pixels.slice(); // owns its buffer; safe to transfer
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { kind: 'encode', resolve, reject });
        worker.postMessage(
          {
            kind: 'encode',
            id,
            width,
            height,
            scale,
            colorSpace,
            pixels: copy.buffer,
            shapes,
          },
          [copy.buffer],
        );
      });
    },
    decode(bytes) {
      // `.slice()` so the transfer can never detach a buffer the caller (or a Blob) still owns.
      const copy = bytes.slice();
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { kind: 'decode', resolve, reject });
        worker.postMessage({ kind: 'decode', id, bytes: copy.buffer }, [copy.buffer]);
      });
    },
    convertUnknownIccToDisplayP3(bytes, width, height) {
      const copy = bytes.slice();
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { kind: 'convertUnknownIcc', resolve, reject });
        worker.postMessage({ kind: 'convertUnknownIcc', id, bytes: copy.buffer, width, height }, [
          copy.buffer,
        ]);
      });
    },
    terminate() {
      worker.terminate();
    },
  };
}

/** No `Worker` global (e.g. a non-browser SSR context): fall back to encoding/decoding inline.
 *  Behavior is identical, just without the off-main-thread guarantee. Every method imports
 *  `core/png` dynamically: real browsers always have `Worker`, so this path is a rare fallback,
 *  and a static import here would pull the whole codec (and its color-tag classifier) into the
 *  main bundle's initial graph for every user, not just the ones who ever hit this branch. */
function createInlineClient(): PngWorkerClient {
  return {
    async encode(
      width,
      height,
      pixels,
      scale = 1,
      colorSpace: DocumentColorSpace = 'srgb',
      shapes: readonly Annotation[],
    ) {
      // A Worker-less host can't flatten shapes (no OffscreenCanvas-in-worker guarantee); this
      // branch is otherwise never reached, since every real browser has `Worker`.
      if (shapes.length) throw new Error('Shape flattening requires a Worker-backed client');
      const { encodePng } = await import('../core/png');
      return encodePng(width, height, pixels, scale, colorSpace);
    },
    async decode(bytes) {
      const { decodePng } = await import('../core/png');
      return decodePng(bytes);
    },
    async convertUnknownIccToDisplayP3(bytes, width, height) {
      const { convertUnknownIccPngToDisplayP3 } = await import('../browser/pngColorManagement');
      return convertUnknownIccPngToDisplayP3(bytes, width, height);
    },
    terminate() {},
  };
}

let client: PngWorkerClient | undefined;

/** Lazily creates one shared worker for the page's lifetime; encoding and decoding are both
 *  infrequent enough (autosave, export, opening a file) that pooling multiple workers would add
 *  complexity for no real benefit. A worker that fails to load (or throws during setup) can never
 *  come back to life, so its `onFatalError` callback drops it from the cache the instant that
 *  happens — comparing against `created` rather than blindly clearing `client`, so a fatal error
 *  from an already-replaced worker (e.g. a test's own `terminatePngWorkerClient()` racing with a
 *  pending `error` event) can't stomp on a newer, healthy one. */
function getClient(): PngWorkerClient {
  if (client) return client;
  const created: PngWorkerClient =
    typeof Worker === 'undefined'
      ? createInlineClient()
      : createWorkerBackedClient(() => {
          if (client === created) client = undefined;
        });
  client = created;
  return client;
}

/** Terminates the shared worker, if one was ever created. Tests use this so a `bun test` run
 *  doesn't accumulate one live worker per test file. */
export function terminatePngWorkerClient(): void {
  client?.terminate();
  client = undefined;
}

/**
 * Encodes a PNG off the main thread. Behaves exactly like `core/png`'s `encodePng`, but the
 * actual deflate work happens in a worker, so a worst-case (near-random) encode can never become
 * a long task on the thread the user is interacting with. When `shapes` is non-empty, they're
 * rasterized and composited onto the pixels in the worker before encoding, so the exported file
 * always matches exactly what the canvas shows.
 */
export function encodePngOffMainThread(
  width: number,
  height: number,
  pixels: Uint32Array,
  scale = 1,
  colorSpace: DocumentColorSpace = 'srgb',
  shapes: readonly Annotation[] = [],
): Promise<Uint8Array> {
  return getClient().encode(width, height, pixels, scale, colorSpace, shapes);
}

/**
 * Decodes a PNG off the main thread. Behaves exactly like `core/png`'s `decodePng`, including
 * rejecting with the same `ImportError` (reason preserved), but the inflate, unfiltering, and
 * per-pixel sample expansion all happen in a worker. A large photo's decode is real main-thread
 * work (unlike a small sprite's), so this is what keeps opening one from ever becoming a long
 * task on the thread the user is interacting with.
 */
export function decodePngOffMainThread(bytes: Uint8Array): Promise<DecodedPng> {
  return getClient().decode(bytes);
}

/**
 * Converts a PNG with an unrecognized embedded ICC profile to Display P3 pixels, using the
 * browser's own color management (`createImageBitmap` + an `OffscreenCanvas`). Runs in the PNG
 * worker, since decoding and re-encoding a full-size bitmap through canvas APIs is real
 * main-thread work at photo sizes. Resolves `null` only when the host has neither `Worker` nor
 * `OffscreenCanvas`/`createImageBitmap`, in which case the caller keeps the already-decoded
 * pixels as plain sRGB rather than failing the import.
 */
export function convertUnknownIccPngToDisplayP3OffMainThread(
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<Uint32Array | null> {
  return getClient().convertUnknownIccToDisplayP3(bytes, width, height);
}
