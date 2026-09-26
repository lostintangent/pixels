/// <reference lib="webworker" />
import { encodePng } from '../core/png';

interface EncodeRequest {
  id: number;
  width: number;
  height: number;
  scale: number;
  pixels: ArrayBuffer;
}

interface EncodeSuccess {
  id: number;
  bytes: ArrayBuffer;
}

interface EncodeFailure {
  id: number;
  error: { name: string; message: string };
}

export type EncodeResponse = EncodeSuccess | EncodeFailure;

/**
 * Runs the PNG codec's deflate step off the main thread. Worst-case (near-random) pixel content
 * can take tens of milliseconds under `CompressionStream`, which would otherwise be a long task
 * blocking input and paint; a dedicated worker removes it from the main thread entirely.
 */
self.addEventListener('message', (event: MessageEvent<EncodeRequest>) => {
  const { id, width, height, scale, pixels } = event.data;
  void encodePng(width, height, new Uint32Array(pixels), scale).then(
    (bytes) => {
      // `.slice()` guarantees an exactly-sized, standalone buffer, safe to transfer regardless of
      // whether `bytes` happens to be a view over a larger backing buffer.
      const owned = bytes.slice().buffer as ArrayBuffer;
      const response: EncodeSuccess = { id, bytes: owned };
      (self as unknown as Worker).postMessage(response, [owned]);
    },
    (error: unknown) => {
      const response: EncodeFailure = {
        id,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      };
      (self as unknown as Worker).postMessage(response);
    },
  );
});
