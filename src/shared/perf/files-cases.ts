import { encodePng } from '../../features/files/model';
import type { PerfCase } from './harness';

/** Blocky pixel-art content: large runs of a handful of repeated colors, exactly what deflate is
 *  good at. This is the common case an artist actually produces. */
function blockyPixels(side: number): Uint32Array {
  const pixels = new Uint32Array(side * side);
  const palette = [0xff206ec9, 0xff191919, 0xffffffff, 0xff4caf50, 0xffff9800];
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      pixels[y * side + x] = palette[((x >> 4) + (y >> 4)) % palette.length]!;
    }
  }
  return pixels;
}

/** Near-random content: deflate's adversarial case, with almost nothing to compress. A document
 *  is unlikely to ever look like this, but a worst-case budget has to cover it anyway. Built from
 *  a fixed-seed LCG rather than `Math.random()`, so every run encodes identical bytes. */
function noisePixels(side: number): Uint32Array {
  const pixels = new Uint32Array(side * side);
  let seed = 42;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = (seed >>> 0) | 0xff000000;
  }
  return pixels;
}

function pngEncodeCase(
  name: string,
  pixels: Uint32Array,
  side: number,
  targetP95Ms: number,
  samples: number,
): PerfCase {
  return {
    name,
    targetP95Ms,
    samples,
    prepare() {},
    reset() {},
    run() {
      return encodePng(side, side, pixels);
    },
  };
}

export const filesPerfCases: PerfCase[] = [
  pngEncodeCase('encodePng blocky pixel-art 1024²', blockyPixels(1024), 1024, 10.5, 50),
  pngEncodeCase(
    'encodePng near-random noise 1024² (worst case; run off the main thread in the browser)',
    noisePixels(1024),
    1024,
    115,
    20,
  ),
];
