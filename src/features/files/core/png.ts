import { MAX_DOCUMENT_SIDE, type DocumentColorSpace } from '../../document';
import { classifyColorTag } from './colorTag';
import { ImportError } from './contracts';

/** The maximum side length we'll ever produce on export, so an unreasonable scale fails clearly
 *  instead of allocating hundreds of megabytes. 4096 (max document side) x 16 covers every
 *  integer scale the editor exposes with headroom. */
const MAX_EXPORT_SIDE = 65536;

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

interface Ihdr {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

export interface DecodedPng {
  width: number;
  height: number;
  /** Packed ABGR-in-uint32 matching BitmapDocument.pixels, little-endian bytes are RGBA. */
  pixels: Uint32Array;
  /** The PNG's embedded color tag, classified against the spec's own precedence (cICP, then
   *  iCCP, then sRGB, defaulting to sRGB when none is present). `'unknown-icc'` means the PNG
   *  carries real color information we can't map onto either of Pixels' two document color
   *  spaces ourselves; the caller (`import.ts`) is the one with access to the browser's own
   *  color management for that rare case, so `pixels` here stay the untouched, exact decode. */
  colorTag: DocumentColorSpace | 'unknown-icc';
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encodes packed document pixels as an 8-bit RGBA PNG. Scale is an integer upscale using
 * nearest-neighbor replication. Rows are generated and streamed into the compressor one at a
 * time, so an 8x export of a 1024x1024 document never allocates a 256 MB buffer.
 */
export async function encodePng(
  width: number,
  height: number,
  pixels: Uint32Array,
  scale = 1,
  colorSpace: DocumentColorSpace = 'srgb',
): Promise<Uint8Array> {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new RangeError(`Export scale must be a positive integer, got ${scale}`);
  }
  const outWidth = width * scale;
  const outHeight = height * scale;
  if (outWidth > MAX_EXPORT_SIDE || outHeight > MAX_EXPORT_SIDE) {
    throw new RangeError(
      `Export size ${outWidth} x ${outHeight} exceeds the ${MAX_EXPORT_SIDE}px side limit. Choose a smaller scale.`,
    );
  }
  const sourceBytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length * 4);
  const rowBytes = outWidth * 4;
  const idat = await deflateZlib(generateFilteredRows(sourceBytes, width, height, scale, rowBytes));
  return assemblePng(outWidth, outHeight, idat, colorSpace);
}

/** Yields one filter-tagged, already-upscaled scanline at a time (source row reused across scale copies). */
function* generateFilteredRows(
  sourceBytes: Uint8Array,
  width: number,
  height: number,
  scale: number,
  rowBytes: number,
): Generator<Uint8Array> {
  const row = new Uint8Array(rowBytes + 1); // leading filter-type byte, always 0 (None)
  const pixelRow = row.subarray(1);
  for (let y = 0; y < height; y++) {
    const sourceOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const pixelOffset = sourceOffset + x * 4;
      const outBase = x * scale * 4;
      for (let sx = 0; sx < scale; sx++) {
        const offset = outBase + sx * 4;
        pixelRow[offset] = sourceBytes[pixelOffset]!;
        pixelRow[offset + 1] = sourceBytes[pixelOffset + 1]!;
        pixelRow[offset + 2] = sourceBytes[pixelOffset + 2]!;
        pixelRow[offset + 3] = sourceBytes[pixelOffset + 3]!;
      }
    }
    for (let sy = 0; sy < scale; sy++) yield row;
  }
}

async function deflateZlib(rows: Generator<Uint8Array>): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  })();
  // Batch rows into ~1 MiB writes: one `write()` per scanline measurably dominates encode time
  // (thousands of awaited stream calls for a large document), while batching keeps peak memory
  // bounded regardless of image size, preserving the point of streaming in the first place.
  const BATCH_BYTES = 1 << 20;
  let batch = new Uint8Array(BATCH_BYTES);
  let batchLength = 0;
  for (const row of rows) {
    if (batchLength + row.length > batch.length) {
      await writer.write(batch.subarray(0, batchLength) as unknown as BufferSource);
      batchLength = 0;
      if (row.length > batch.length) batch = new Uint8Array(row.length); // grow for an unusually wide row
    }
    batch.set(row, batchLength);
    batchLength += row.length;
  }
  if (batchLength > 0) {
    await writer.write(batch.subarray(0, batchLength) as unknown as BufferSource);
  }
  await writer.close();
  await pump;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** cICP code points (ITU-T H.273), as PNG requires: identity matrix (RGB, not YCbCr) and full
 *  range. Verified against a real macOS-tagged Display P3 screenshot, which writes exactly these
 *  four bytes. primaries 1 (BT.709) + transfer 13 (sRGB) is the matching sRGB tagging. */
const CICP_DISPLAY_P3 = new Uint8Array([12, 13, 0, 1]);

function assemblePng(
  width: number,
  height: number,
  idat: Uint8Array,
  colorSpace: DocumentColorSpace,
): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none
  // sRGB is the plain, widely-understood tag for the common case. Display P3 gets a cICP chunk
  // instead: a tool that doesn't understand cICP simply ignores it and falls back to treating the
  // file as untagged (assumed sRGB) - a known, deliberate tradeoff over embedding a full ICC
  // profile, which every color-managed reader (including this app) already handles via cICP.
  const colorChunk =
    colorSpace === 'display-p3'
      ? chunk('cICP', CICP_DISPLAY_P3)
      : chunk('sRGB', new Uint8Array([0]));
  const chunks = [
    chunk('IHDR', ihdr),
    colorChunk,
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = SIGNATURE.length + chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  let offset = SIGNATURE.length;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeUint32BE(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeUint32BE(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export async function decodePng(input: Uint8Array | ArrayBuffer): Promise<DecodedPng> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  verifySignature(bytes);

  let ihdr: Ihdr | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];
  let cicp: Uint8Array | null = null;
  let iccp: Uint8Array | null = null;
  let srgb: Uint8Array | null = null;
  let offset = SIGNATURE.length;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw corrupt('The PNG is truncated in the middle of a chunk.');
    const length = readUint32BE(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw corrupt('The PNG is truncated in the middle of a chunk.');
    const data = bytes.subarray(dataStart, dataEnd);
    const storedCrc = readUint32BE(bytes, dataEnd);
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== storedCrc) {
      throw corrupt(`The PNG's "${type}" chunk failed its checksum.`);
    }
    if (type === 'IHDR') ihdr = parseIhdr(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idatChunks.push(data);
    else if (type === 'cICP') cicp = data;
    else if (type === 'iCCP') iccp = data;
    else if (type === 'sRGB') srgb = data;
    else if (type === 'IEND') break;
    offset = dataEnd + 4;
  }

  if (!ihdr) throw corrupt('The PNG is missing its header.');
  if (ihdr.width > MAX_DOCUMENT_SIDE || ihdr.height > MAX_DOCUMENT_SIDE) {
    throw tooLarge(
      `This PNG is ${ihdr.width} x ${ihdr.height}. Pixels opens images up to ${MAX_DOCUMENT_SIDE} x ${MAX_DOCUMENT_SIDE}.`,
    );
  }
  if (ihdr.interlace !== 0 && ihdr.interlace !== 1) {
    throw corrupt(`The PNG has an invalid interlace method (${ihdr.interlace}).`);
  }
  if (ihdr.colorType === 3 && !palette) throw corrupt('The PNG is missing its color palette.');

  const idat = concatBytes(idatChunks);
  let raw: Uint8Array;
  try {
    raw = await inflateZlib(idat);
  } catch {
    throw corrupt('The PNG\u2019s compressed pixel data is invalid.');
  }

  const pixels = decodeImage(raw, ihdr, palette, trns);
  const colorTag = await classifyColorTag({ cicp, iccp, srgb });
  return { width: ihdr.width, height: ihdr.height, pixels, colorTag };
}

/** One of Adam7's seven reduced images, in pass order: starting offset and stride on each axis. */
const ADAM7_PASSES: ReadonlyArray<{
  xStart: number;
  yStart: number;
  xStep: number;
  yStep: number;
}> = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
];

/** Decodes every scanline (interlaced or not) straight into the final packed RGBA buffer. A
 *  non-interlaced image is treated as one "pass" covering the whole image at step 1,1, so the
 *  same unfilter/scatter path handles both. */
function decodeImage(
  raw: Uint8Array,
  ihdr: Ihdr,
  palette: Uint8Array | null,
  trns: Uint8Array | null,
): Uint32Array {
  if (ihdr.interlace === 0 && ihdr.bitDepth === 8 && ihdr.colorType === 6) {
    return decodeRgba8(raw, ihdr.width, ihdr.height);
  }
  if (ihdr.interlace === 0 && ihdr.bitDepth === 8 && ihdr.colorType === 2) {
    return decodeRgb8(raw, ihdr.width, ihdr.height, trns);
  }
  const pixels = new Uint32Array(ihdr.width * ihdr.height);
  const outBytes = new Uint8Array(pixels.buffer);
  if (ihdr.interlace === 0) {
    const { scanlines } = unfilterPass(raw, 0, ihdr, ihdr.width, ihdr.height);
    writePass(scanlines, ihdr, ihdr.width, ihdr.height, 0, 0, 1, 1, palette, trns, outBytes);
  } else {
    let offset = 0;
    for (const pass of ADAM7_PASSES) {
      const passWidth = Math.ceil((ihdr.width - pass.xStart) / pass.xStep);
      const passHeight = Math.ceil((ihdr.height - pass.yStart) / pass.yStep);
      // A pass can be empty for small images (e.g. a 4px-wide image has nothing in pass 4+); PNG
      // stores zero scanlines for it, so skip straight to the next pass without consuming bytes.
      if (passWidth <= 0 || passHeight <= 0) continue;
      const { scanlines, consumed } = unfilterPass(raw, offset, ihdr, passWidth, passHeight);
      writePass(
        scanlines,
        ihdr,
        passWidth,
        passHeight,
        pass.xStart,
        pass.yStart,
        pass.xStep,
        pass.yStep,
        palette,
        trns,
        outBytes,
      );
      offset += consumed;
    }
  }
  return pixels;
}

/** The common screenshot/photo format is already RGBA byte-for-byte. Unfilter each row straight
 * into the final pixel buffer instead of materializing scanlines and expanding them again. */
function decodeRgba8(raw: Uint8Array, width: number, height: number): Uint32Array {
  const rowBytes = width * 4;
  const stride = rowBytes + 1;
  if (raw.length < stride * height) throw corrupt('The PNG pixel data is truncated.');
  const pixels = new Uint32Array(width * height);
  const out = new Uint8Array(pixels.buffer);
  let previous: Uint8Array | null = null;
  for (let y = 0; y < height; y++) {
    const offset = y * stride;
    const filter = raw[offset]!;
    const source = raw.subarray(offset + 1, offset + stride);
    const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    if (filter === 0) row.set(source);
    else unfilterRow(filter, source, row, previous, 4);
    previous = row;
  }
  return pixels;
}

/** RGB scanlines need alpha expansion, but no bit-depth scaling or per-pixel format dispatch. */
function decodeRgb8(
  raw: Uint8Array,
  width: number,
  height: number,
  trns: Uint8Array | null,
): Uint32Array {
  const rowBytes = width * 3;
  const stride = rowBytes + 1;
  if (raw.length < stride * height) throw corrupt('The PNG pixel data is truncated.');
  const pixels = new Uint32Array(width * height);
  let previous: Uint8Array | null = null;
  let row: Uint8Array = new Uint8Array(rowBytes);
  const spare: Uint8Array = new Uint8Array(rowBytes);
  const key =
    trns && trns.length >= 6
      ? [readUint16BE(trns, 0), readUint16BE(trns, 2), readUint16BE(trns, 4)]
      : null;
  for (let y = 0; y < height; y++) {
    const offset = y * stride;
    const filter = raw[offset]!;
    const source = raw.subarray(offset + 1, offset + stride);
    if (filter === 0) row.set(source);
    else unfilterRow(filter, source, row, previous, 3);
    for (let x = 0; x < width; x++) {
      const i = x * 3;
      const r = row[i]!;
      const g = row[i + 1]!;
      const b = row[i + 2]!;
      const alpha = key && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
      pixels[y * width + x] = (alpha << 24) | (b << 16) | (g << 8) | r;
    }
    const old = previous;
    previous = row;
    row = old ?? spare;
  }
  return pixels;
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  })();
  await writer.write(data as unknown as BufferSource); // lib.dom types BufferSource as ArrayBuffer-only; our input is always a plain-buffer Uint8Array
  await writer.close();
  await pump;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function verifySignature(bytes: Uint8Array): void {
  if (bytes.length < 8) throw corrupt("This file isn't a valid PNG.");
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw unsupported('This file is not a PNG.');
  }
}

function parseIhdr(data: Uint8Array): Ihdr {
  if (data.length < 13) throw corrupt('The PNG header is invalid.');
  const width = readUint32BE(data, 0);
  const height = readUint32BE(data, 4);
  const bitDepth = data[8]!;
  const colorType = data[9]!;
  const compression = data[10]!;
  const filterMethod = data[11]!;
  const interlace = data[12]!;
  if (width < 1 || height < 1) throw corrupt('The PNG has invalid dimensions.');
  if (compression !== 0 || filterMethod !== 0) {
    throw unsupported('This PNG uses an unsupported compression or filter method.');
  }
  if (![1, 2, 4, 8, 16].includes(bitDepth)) {
    throw corrupt(`The PNG has an invalid bit depth (${bitDepth}).`);
  }
  channelsFor(colorType); // validates colorType itself
  const allowedDepths =
    colorType === 0 ? [1, 2, 4, 8, 16] : colorType === 3 ? [1, 2, 4, 8] : [8, 16];
  if (!allowedDepths.includes(bitDepth)) {
    throw corrupt(
      `The PNG has bit depth ${bitDepth} with an incompatible color type (${colorType}).`,
    );
  }
  return { width, height, bitDepth, colorType, interlace };
}

function channelsFor(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // grayscale
    case 2:
      return 3; // rgb
    case 3:
      return 1; // palette index
    case 4:
      return 2; // gray+alpha
    case 6:
      return 4; // rgba
    default:
      throw corrupt(`The PNG uses an unsupported color type (${colorType}).`);
  }
}

/** Unfilters `height` scanlines of one pass (the whole image, for a non-interlaced PNG, or one
 *  of Adam7's seven reduced images), starting at byte `offset` in the inflated stream. `width` is
 *  that pass's own pixel width, which is narrower than the image for every Adam7 pass but the
 *  first. Returns the contiguous unfiltered bytes plus how many input bytes they consumed, so the
 *  caller can advance to the next pass. */
function unfilterPass(
  raw: Uint8Array,
  offset: number,
  ihdr: Ihdr,
  width: number,
  height: number,
): { scanlines: Uint8Array; consumed: number } {
  const channels = channelsFor(ihdr.colorType);
  const bitsPerPixel = channels * ihdr.bitDepth;
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const stride = rowBytes + 1;
  const consumed = stride * height;
  if (offset + consumed > raw.length) throw corrupt('The PNG pixel data is truncated.');
  const out = new Uint8Array(rowBytes * height);
  let prevRow: Uint8Array | null = null;
  for (let y = 0; y < height; y++) {
    const rowOffset = offset + y * stride;
    const filterType = raw[rowOffset]!;
    const src = raw.subarray(rowOffset + 1, rowOffset + 1 + rowBytes);
    const dst = out.subarray(y * rowBytes, y * rowBytes + rowBytes);
    unfilterRow(filterType, src, dst, prevRow, bytesPerPixel);
    prevRow = dst;
  }
  return { scanlines: out, consumed };
}

function unfilterRow(
  filterType: number,
  src: Uint8Array,
  dst: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
): void {
  for (let i = 0; i < src.length; i++) {
    const a = i >= bpp ? dst[i - bpp]! : 0;
    const b = prev ? prev[i]! : 0;
    const c = prev && i >= bpp ? prev[i - bpp]! : 0;
    let value = src[i]!;
    switch (filterType) {
      case 0:
        break;
      case 1:
        value = (value + a) & 255;
        break;
      case 2:
        value = (value + b) & 255;
        break;
      case 3:
        value = (value + ((a + b) >> 1)) & 255;
        break;
      case 4:
        value = (value + paeth(a, b, c)) & 255;
        break;
      default:
        throw corrupt(`The PNG uses an unsupported scanline filter (${filterType}).`);
    }
    dst[i] = value;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decodes one pass's scanlines and scatters each sample into the final packed RGBA buffer at
 *  `(xStart + x * xStep, yStart + y * yStep)`. A non-interlaced image calls this once with
 *  `xStep = yStep = 1`, covering every pixel; an Adam7 pass covers only its own sparse subset. */
function writePass(
  scanlines: Uint8Array,
  ihdr: Ihdr,
  width: number,
  height: number,
  xStart: number,
  yStart: number,
  xStep: number,
  yStep: number,
  palette: Uint8Array | null,
  trns: Uint8Array | null,
  outBytes: Uint8Array,
): void {
  const { bitDepth, colorType } = ihdr;
  const channels = channelsFor(colorType);
  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  // Only grayscale and palette ever use depths below 8; every other color type is 8 or 16 bit, so
  // this is exact for every depth actually reached by the bit-packed branch below.
  const maxSample = (1 << bitDepth) - 1;

  const readSample = (row: Uint8Array, pixelIndex: number, channel: number): number => {
    const sampleIndex = pixelIndex * channels + channel;
    if (bitDepth === 16) {
      const byteIndex = sampleIndex * 2;
      return (row[byteIndex]! << 8) | row[byteIndex + 1]!;
    }
    if (bitDepth === 8) return row[sampleIndex]!;
    const bitPos = sampleIndex * bitDepth;
    const byteIndex = bitPos >> 3;
    const shift = 8 - bitDepth - (bitPos & 7);
    return (row[byteIndex]! >> shift) & maxSample;
  };

  // PNG always stores samples at their native bit depth; scale to this document's 8-bit channels
  // with exact rounding rather than truncating, so a 16-bit gradient doesn't band on import.
  const scaleTo8 = (value: number): number =>
    bitDepth === 16
      ? Math.round((value * 255) / 65535)
      : bitDepth === 8
        ? value
        : Math.round((value * 255) / maxSample);

  // tRNS for color types 0 and 2 is a single native-depth sample (or RGB triple) naming the exact
  // color that's transparent, stored as a 2-byte value per channel regardless of bit depth; compare
  // against the raw, unscaled sample so a sub-8-bit or 16-bit key still matches precisely.
  const grayKey = colorType === 0 && trns && trns.length >= 2 ? readUint16BE(trns, 0) : null;
  const rgbKey =
    colorType === 2 && trns && trns.length >= 6
      ? ([readUint16BE(trns, 0), readUint16BE(trns, 2), readUint16BE(trns, 4)] as const)
      : null;

  for (let y = 0; y < height; y++) {
    const row = scanlines.subarray(y * rowBytes, y * rowBytes + rowBytes);
    const destY = yStart + y * yStep;
    for (let x = 0; x < width; x++) {
      const destX = xStart + x * xStep;
      const outOffset = (destY * ihdr.width + destX) * 4;
      switch (colorType) {
        case 0: {
          const raw = readSample(row, x, 0);
          const value = scaleTo8(raw);
          outBytes[outOffset] = value;
          outBytes[outOffset + 1] = value;
          outBytes[outOffset + 2] = value;
          outBytes[outOffset + 3] = grayKey !== null && raw === grayKey ? 0 : 255;
          break;
        }
        case 2: {
          const r = readSample(row, x, 0);
          const g = readSample(row, x, 1);
          const b = readSample(row, x, 2);
          outBytes[outOffset] = scaleTo8(r);
          outBytes[outOffset + 1] = scaleTo8(g);
          outBytes[outOffset + 2] = scaleTo8(b);
          outBytes[outOffset + 3] =
            rgbKey && r === rgbKey[0] && g === rgbKey[1] && b === rgbKey[2] ? 0 : 255;
          break;
        }
        case 3: {
          const index = readSample(row, x, 0);
          const paletteOffset = index * 3;
          if (!palette || paletteOffset + 2 >= palette.length) {
            throw corrupt('The PNG references a palette index that does not exist.');
          }
          outBytes[outOffset] = palette[paletteOffset]!;
          outBytes[outOffset + 1] = palette[paletteOffset + 1]!;
          outBytes[outOffset + 2] = palette[paletteOffset + 2]!;
          outBytes[outOffset + 3] = trns && index < trns.length ? trns[index]! : 255;
          break;
        }
        case 4: {
          const gray = readSample(row, x, 0);
          const alpha = readSample(row, x, 1);
          const value = scaleTo8(gray);
          outBytes[outOffset] = value;
          outBytes[outOffset + 1] = value;
          outBytes[outOffset + 2] = value;
          outBytes[outOffset + 3] = scaleTo8(alpha);
          break;
        }
        case 6: {
          const r = readSample(row, x, 0);
          const g = readSample(row, x, 1);
          const b = readSample(row, x, 2);
          const a = readSample(row, x, 3);
          outBytes[outOffset] = scaleTo8(r);
          outBytes[outOffset + 1] = scaleTo8(g);
          outBytes[outOffset + 2] = scaleTo8(b);
          outBytes[outOffset + 3] = scaleTo8(a);
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Byte and CRC helpers
// ---------------------------------------------------------------------------

function corrupt(message: string): ImportError {
  return new ImportError('corrupt', message);
}
function unsupported(message: string): ImportError {
  return new ImportError('unsupported-format', message);
}
function tooLarge(message: string): ImportError {
  return new ImportError('too-large', message);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 255;
  bytes[offset + 1] = (value >>> 16) & 255;
  bytes[offset + 2] = (value >>> 8) & 255;
  bytes[offset + 3] = value & 255;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]!);
  return s;
}

let crcTable: Int32Array | null = null;
function getCrcTable(): Int32Array {
  if (crcTable) return crcTable;
  // Eight tables process a whole machine word pair per loop without sacrificing PNG's CRC.
  const table = new Int32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = table[n]!;
    for (let k = 1; k < 8; k++) {
      c = table[c & 255]! ^ (c >>> 8);
      table[k * 256 + n] = c;
    }
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  let i = 0;
  const end = bytes.length - 8;
  for (; i <= end; i += 8) {
    const first =
      crc ^ (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24));
    crc =
      table[7 * 256 + (first & 255)]! ^
      table[6 * 256 + ((first >>> 8) & 255)]! ^
      table[5 * 256 + ((first >>> 16) & 255)]! ^
      table[4 * 256 + (first >>> 24)]! ^
      table[3 * 256 + bytes[i + 4]!]! ^
      table[2 * 256 + bytes[i + 5]!]! ^
      table[256 + bytes[i + 6]!]! ^
      table[bytes[i + 7]!]!;
  }
  for (; i < bytes.length; i++) crc = table[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
