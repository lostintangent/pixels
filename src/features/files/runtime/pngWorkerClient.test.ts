import { afterAll, describe, expect, test } from 'bun:test';
import type { Annotation } from '../../annotations';
import { packRgba } from '../../document';
import { ImportError } from '../core/contracts';
import { decodePng, encodePng } from '../core/png';
import {
  convertUnknownIccPngToDisplayP3OffMainThread,
  decodePngOffMainThread,
  encodePngOffMainThread,
  terminatePngWorkerClient,
} from './pngWorkerClient';

afterAll(() => {
  terminatePngWorkerClient();
});

const rectangle: Annotation = {
  id: 'r1',
  kind: 'rectangle',
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
  width: 1,
  color: packRgba(255, 0, 0, 255),
};

describe('encodePngOffMainThread', () => {
  test('matches encodePng byte-for-byte for the same input', async () => {
    const pixels = new Uint32Array([
      packRgba(10, 20, 30, 128),
      packRgba(255, 0, 0, 0),
      packRgba(0, 255, 0, 1),
      packRgba(0, 0, 255, 255),
    ]);
    const direct = await encodePng(2, 2, pixels);
    const offMainThread = await encodePngOffMainThread(2, 2, pixels.slice());
    expect([...offMainThread]).toEqual([...direct]);
  });

  test('round-trips through decodePng at an integer scale', async () => {
    const pixels = new Uint32Array([packRgba(1, 2, 3, 255), packRgba(4, 5, 6, 255)]);
    const bytes = await encodePngOffMainThread(2, 1, pixels, 3);
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(6);
    expect(decoded.height).toBe(3);
  });

  test('does not mutate or detach the caller’s pixels', async () => {
    const pixels = new Uint32Array([packRgba(7, 7, 7, 255), packRgba(8, 8, 8, 255)]);
    const before = [...pixels];
    await encodePngOffMainThread(2, 1, pixels);
    expect([...pixels]).toEqual(before); // still readable: proves it was copied, not transferred
  });

  test('concurrent encodes resolve to their own bytes, never swapped with another request', async () => {
    const solidRed = new Uint32Array(64).fill(packRgba(255, 0, 0, 255));
    const solidBlue = new Uint32Array(64).fill(packRgba(0, 0, 255, 255));
    const [redBytes, blueBytes] = await Promise.all([
      encodePngOffMainThread(8, 8, solidRed),
      encodePngOffMainThread(8, 8, solidBlue),
    ]);
    const [redDecoded, blueDecoded] = await Promise.all([
      decodePng(redBytes),
      decodePng(blueBytes),
    ]);
    expect(redDecoded.pixels[0]).toBe(packRgba(255, 0, 0, 255));
    expect(blueDecoded.pixels[0]).toBe(packRgba(0, 0, 255, 255));
  });

  test('a rejection surfaces the same message an invalid scale produces from encodePng directly', async () => {
    const pixels = new Uint32Array([packRgba(1, 1, 1, 1)]);
    let offMainThreadError: unknown;
    try {
      await encodePngOffMainThread(1, 1, pixels, 0);
    } catch (error) {
      offMainThreadError = error;
    }
    let directError: unknown;
    try {
      await encodePng(1, 1, pixels, 0);
    } catch (error) {
      directError = error;
    }
    expect(offMainThreadError).toBeInstanceOf(RangeError);
    expect((offMainThreadError as Error).message).toBe((directError as Error).message);
  });

  test('an empty (or omitted) shapes list is byte-identical to the no-shapes call', async () => {
    const pixels = new Uint32Array([packRgba(1, 2, 3, 255), packRgba(4, 5, 6, 255)]);
    const omitted = await encodePngOffMainThread(2, 1, pixels.slice());
    const explicitlyEmpty = await encodePngOffMainThread(2, 1, pixels.slice(), 1, 'srgb', []);
    expect([...explicitlyEmpty]).toEqual([...omitted]);
  });

  test(
    'a non-empty shapes list rejects with a clear error under bun test (no OffscreenCanvas), ' +
      'rather than hanging or crossing the worker — real browsers always have OffscreenCanvas ' +
      'in a worker, so this path only ever exercises the error, never silently drops the shape',
    async () => {
      const pixels = new Uint32Array([packRgba(1, 2, 3, 255), packRgba(4, 5, 6, 255)]);
      let error: unknown;
      try {
        await encodePngOffMainThread(2, 1, pixels, 1, 'srgb', [rectangle]);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/OffscreenCanvas/);
    },
  );

  test('runs alongside a plain encode without crossing up which request gets flattened', async () => {
    const pixels = new Uint32Array([packRgba(7, 8, 9, 255), packRgba(10, 11, 12, 255)]);
    const [plain, flattenedRejection] = await Promise.allSettled([
      encodePngOffMainThread(2, 1, pixels.slice()),
      encodePngOffMainThread(2, 1, pixels.slice(), 1, 'srgb', [rectangle]),
    ]);
    expect(plain.status).toBe('fulfilled');
    expect(flattenedRejection.status).toBe('rejected');
  });
});

describe('decodePngOffMainThread', () => {
  test('matches decodePng byte-for-byte for the same input', async () => {
    const pixels = new Uint32Array([
      packRgba(10, 20, 30, 128),
      packRgba(255, 0, 0, 0),
      packRgba(0, 255, 0, 1),
      packRgba(0, 0, 255, 255),
    ]);
    const bytes = await encodePng(2, 2, pixels);
    const direct = await decodePng(bytes);
    const offMainThread = await decodePngOffMainThread(bytes.slice());
    expect(offMainThread.width).toBe(direct.width);
    expect(offMainThread.height).toBe(direct.height);
    expect([...offMainThread.pixels]).toEqual([...direct.pixels]);
  });

  test('does not mutate or detach the caller’s bytes', async () => {
    const pixels = new Uint32Array([packRgba(9, 9, 9, 255), packRgba(1, 2, 3, 10)]);
    const bytes = await encodePng(2, 1, pixels);
    const before = [...bytes];
    await decodePngOffMainThread(bytes);
    expect([...bytes]).toEqual(before); // still readable: proves it was copied, not transferred
  });

  test('concurrent decodes resolve to their own pixels, never swapped with another request', async () => {
    const solidRed = new Uint32Array(64).fill(packRgba(255, 0, 0, 255));
    const solidBlue = new Uint32Array(64).fill(packRgba(0, 0, 255, 255));
    const [redBytes, blueBytes] = await Promise.all([
      encodePng(8, 8, solidRed),
      encodePng(8, 8, solidBlue),
    ]);
    const [redDecoded, blueDecoded] = await Promise.all([
      decodePngOffMainThread(redBytes),
      decodePngOffMainThread(blueBytes),
    ]);
    expect(redDecoded.pixels[0]).toBe(packRgba(255, 0, 0, 255));
    expect(blueDecoded.pixels[0]).toBe(packRgba(0, 0, 255, 255));
  });

  test('a rejection surfaces as the same ImportError, reason preserved, that decodePng produces directly', async () => {
    const corrupt = new Uint8Array([1, 2, 3, 4]); // not a PNG signature at all
    let offMainThreadError: unknown;
    try {
      await decodePngOffMainThread(corrupt);
    } catch (error) {
      offMainThreadError = error;
    }
    let directError: unknown;
    try {
      await decodePng(corrupt);
    } catch (error) {
      directError = error;
    }
    expect(directError).toBeInstanceOf(ImportError);
    expect(offMainThreadError).toBeInstanceOf(ImportError);
    expect((offMainThreadError as ImportError).reason).toBe((directError as ImportError).reason);
    expect((offMainThreadError as ImportError).message).toBe((directError as Error).message);
  });
});

describe('convertUnknownIccPngToDisplayP3OffMainThread', () => {
  test(
    'resolves null under bun test (no OffscreenCanvas/createImageBitmap), the same as a direct, ' +
      'main-thread call to the underlying conversion — proving the round trip through the real ' +
      'worker (request, convertUnknownIcc branch, response) completes rather than hanging or throwing',
    async () => {
      const pixels = new Uint32Array([packRgba(1, 2, 3, 255)]);
      const bytes = await encodePng(1, 1, pixels);
      const result = await convertUnknownIccPngToDisplayP3OffMainThread(bytes.slice(), 1, 1);
      expect(result).toBeNull();
    },
  );

  test('does not mutate or detach the caller’s bytes', async () => {
    const pixels = new Uint32Array([packRgba(4, 5, 6, 255)]);
    const bytes = await encodePng(1, 1, pixels);
    const before = [...bytes];
    await convertUnknownIccPngToDisplayP3OffMainThread(bytes, 1, 1);
    expect([...bytes]).toEqual(before); // still readable: proves it was copied, not transferred
  });

  test('runs alongside encode/decode requests on the same worker without crossing up responses', async () => {
    const pixels = new Uint32Array([packRgba(7, 8, 9, 255), packRgba(10, 11, 12, 255)]);
    const bytes = await encodePng(2, 1, pixels);
    const [convertResult, decodeResult, encodeResult] = await Promise.all([
      convertUnknownIccPngToDisplayP3OffMainThread(bytes.slice(), 2, 1),
      decodePngOffMainThread(bytes.slice()),
      encodePngOffMainThread(2, 1, pixels.slice()),
    ]);
    expect(convertResult).toBeNull();
    expect([...decodeResult.pixels]).toEqual([...pixels]);
    expect([...encodeResult]).toEqual([...bytes]);
  });
});

describe('recovering from a worker that fails to load', () => {
  // A real failed worker script (a flaky network dropping the request, or a server restart that
  // changed chunk hashes under an open tab) never delivers a `message` for anything already
  // posted to it, and never will for anything posted after, either. This stub reproduces exactly
  // that shape rather than a convenient stand-in: the first instance created fires a single
  // `error` event and then goes silent forever, matching a worker whose script never finished
  // loading. Every instance after that wraps a real `pngWorker.ts` worker, so recovery is proven
  // by real decode/encode output, not just by a promise settling.
  class FlakyWorker extends EventTarget {
    static instancesCreated = 0;
    private readonly real?: Worker;
    constructor(url: string | URL, options?: WorkerOptions) {
      super();
      FlakyWorker.instancesCreated++;
      if (FlakyWorker.instancesCreated === 1) {
        queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', { message: 'boom' })));
        return;
      }
      this.real = new RealWorker(url, options);
      this.real.addEventListener('message', (event) => {
        this.dispatchEvent(new MessageEvent('message', { data: (event as MessageEvent).data }));
      });
      this.real.addEventListener('error', (event) => {
        this.dispatchEvent(new ErrorEvent('error', { message: (event as ErrorEvent).message }));
      });
    }
    postMessage(data: unknown, transfer?: Transferable[]): void {
      this.real?.postMessage(data, transfer ?? []);
    }
    terminate(): void {
      this.real?.terminate();
    }
  }

  const RealWorker = globalThis.Worker;

  test('a load failure rejects what was in flight, and the next call gets a working worker', async () => {
    terminatePngWorkerClient(); // start from no cached client, regardless of test order
    FlakyWorker.instancesCreated = 0;
    globalThis.Worker = FlakyWorker as unknown as typeof Worker;
    try {
      const pixels = new Uint32Array([packRgba(1, 2, 3, 255)]);
      let firstCallError: unknown;
      try {
        await encodePngOffMainThread(1, 1, pixels.slice());
      } catch (error) {
        firstCallError = error;
      }
      expect(firstCallError).toBeInstanceOf(Error);

      // The dead worker must not still be cached: a second call has to create a fresh one.
      const bytes = await encodePngOffMainThread(1, 1, pixels.slice());
      expect(FlakyWorker.instancesCreated).toBe(2);
      const decoded = await decodePng(bytes);
      expect(decoded.pixels[0]).toBe(packRgba(1, 2, 3, 255));

      // The recovered (real) worker keeps working for further calls too.
      const bytes2 = await encodePngOffMainThread(1, 1, pixels.slice());
      expect([...bytes2]).toEqual([...bytes]);
      expect(FlakyWorker.instancesCreated).toBe(2);
    } finally {
      globalThis.Worker = RealWorker;
      terminatePngWorkerClient();
    }
  });
});
