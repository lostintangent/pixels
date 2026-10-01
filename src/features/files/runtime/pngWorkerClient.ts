import type { DocumentColorSpace } from '../../document';
import { ImportError, type ImportErrorReason } from '../core/contracts';
import { decodePng, type DecodedPng, encodePng } from '../core/png';
import type { DecodeResponse, EncodeResponse } from './pngWorker';

export interface PngWorkerClient {
  encode(
    width: number,
    height: number,
    pixels: Uint32Array,
    scale?: number,
    colorSpace?: DocumentColorSpace,
  ): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<DecodedPng>;
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

type Pending = PendingEncode | PendingDecode;

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
function createWorkerBackedClient(): PngWorkerClient {
  const worker = new Worker(new URL('./pngWorker.ts', import.meta.url), { type: 'module' });
  let nextRequestId = 1;
  const pending = new Map<number, Pending>();

  worker.addEventListener('message', (event: MessageEvent<EncodeResponse | DecodeResponse>) => {
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
    }
  });
  worker.addEventListener('error', (event: ErrorEvent) => {
    // A worker-level failure (e.g. a load error) can't be correlated to one request; fail every
    // request still in flight rather than hanging them forever.
    for (const [id, request] of pending) {
      request.reject(new Error(event.message || 'PNG worker failed'));
      pending.delete(id);
    }
  });

  return {
    encode(width, height, pixels, scale = 1, colorSpace: DocumentColorSpace = 'srgb') {
      const copy = pixels.slice(); // owns its buffer; safe to transfer
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { kind: 'encode', resolve, reject });
        worker.postMessage(
          { kind: 'encode', id, width, height, scale, colorSpace, pixels: copy.buffer },
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
    terminate() {
      worker.terminate();
    },
  };
}

/** No `Worker` global (e.g. a non-browser SSR context): fall back to encoding/decoding inline.
 *  Behavior is identical, just without the off-main-thread guarantee. */
function createInlineClient(): PngWorkerClient {
  return {
    encode(width, height, pixels, scale = 1, colorSpace: DocumentColorSpace = 'srgb') {
      return encodePng(width, height, pixels, scale, colorSpace);
    },
    decode(bytes) {
      return decodePng(bytes);
    },
    terminate() {},
  };
}

let client: PngWorkerClient | undefined;

/** Lazily creates one shared worker for the page's lifetime; encoding and decoding are both
 *  infrequent enough (autosave, export, opening a file) that pooling multiple workers would add
 *  complexity for no real benefit. */
function getClient(): PngWorkerClient {
  client ??= typeof Worker === 'undefined' ? createInlineClient() : createWorkerBackedClient();
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
 * a long task on the thread the user is interacting with.
 */
export function encodePngOffMainThread(
  width: number,
  height: number,
  pixels: Uint32Array,
  scale = 1,
  colorSpace: DocumentColorSpace = 'srgb',
): Promise<Uint8Array> {
  return getClient().encode(width, height, pixels, scale, colorSpace);
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
