import { afterAll, describe, expect, test } from 'bun:test';
import { packRgba } from '../../document';
import { ImportError } from '../core/contracts';
import { decodePng, encodePng } from '../core/png';
import {
  decodePngOffMainThread,
  encodePngOffMainThread,
  terminatePngWorkerClient,
} from './pngWorkerClient';

afterAll(() => {
  terminatePngWorkerClient();
});

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
