import { encodePng } from '../core/png';
import type { EncodeResponse } from './pngWorker';

export interface PngWorkerClient {
  encode(width: number, height: number, pixels: Uint32Array, scale?: number): Promise<Uint8Array>;
  /** Terminates the underlying worker, if any. Tests use this to avoid leaking workers. */
  terminate(): void;
}

interface PendingEncode {
  resolve(bytes: Uint8Array): void;
  reject(error: unknown): void;
}

function reviveError(error: { name: string; message: string }): Error {
  const revived =
    error.name === 'RangeError'
      ? new RangeError(error.message)
      : error.name === 'TypeError'
        ? new TypeError(error.message)
        : new Error(error.message);
  revived.name = error.name;
  return revived;
}

/** Real worker-backed client: every `encode()` copies its pixels into a fresh, transferable
 *  buffer first, so it never risks detaching the caller's live document buffer. */
function createWorkerBackedClient(): PngWorkerClient {
  const worker = new Worker(new URL('./pngWorker.ts', import.meta.url), { type: 'module' });
  let nextRequestId = 1;
  const pending = new Map<number, PendingEncode>();

  worker.addEventListener('message', (event: MessageEvent<EncodeResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if ('bytes' in response) request.resolve(new Uint8Array(response.bytes));
    else request.reject(reviveError(response.error));
  });
  worker.addEventListener('error', (event: ErrorEvent) => {
    // A worker-level failure (e.g. a load error) can't be correlated to one request; fail every
    // encode still in flight rather than hanging them forever.
    for (const [id, request] of pending) {
      request.reject(new Error(event.message || 'PNG encode worker failed'));
      pending.delete(id);
    }
  });

  return {
    encode(width, height, pixels, scale = 1) {
      const copy = pixels.slice(); // owns its buffer; safe to transfer
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, width, height, scale, pixels: copy.buffer }, [copy.buffer]);
      });
    },
    terminate() {
      worker.terminate();
    },
  };
}

/** No `Worker` global (e.g. a non-browser SSR context): fall back to encoding inline. Behavior is
 *  identical, just without the off-main-thread guarantee. */
function createInlineClient(): PngWorkerClient {
  return {
    encode(width, height, pixels, scale = 1) {
      return encodePng(width, height, pixels, scale);
    },
    terminate() {},
  };
}

let client: PngWorkerClient | undefined;

/** Lazily creates one shared worker for the page's lifetime; encoding is infrequent enough
 *  (autosave, export) that pooling multiple workers would add complexity for no real benefit. */
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
): Promise<Uint8Array> {
  return getClient().encode(width, height, pixels, scale);
}
