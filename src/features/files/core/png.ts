import { MAX_DOCUMENT_SIDE } from '../../document';
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
  return assemblePng(outWidth, outHeight, idat);
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
  for (const row of rows) await writer.write(row as unknown as BufferSource); // lib.dom types BufferSource as ArrayBuffer-only; our chunks are always plain-buffer Uint8Arrays
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

function assemblePng(width: number, height: number, idat: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none
  const srgb = new Uint8Array([0]); // rendering intent: perceptual
  const chunks = [
    chunk('IHDR', ihdr),
    chunk('sRGB', srgb),
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
  let paletteAlpha: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];
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
    else if (type === 'tRNS') paletteAlpha = data;
    else if (type === 'IDAT') idatChunks.push(data);
    else if (type === 'IEND') break;
    offset = dataEnd + 4;
  }

  if (!ihdr) throw corrupt('The PNG is missing its header.');
  if (ihdr.width > MAX_DOCUMENT_SIDE || ihdr.height > MAX_DOCUMENT_SIDE) {
    throw tooLarge(
      `This PNG is ${ihdr.width} x ${ihdr.height}. Pixels opens images up to ${MAX_DOCUMENT_SIDE} x ${MAX_DOCUMENT_SIDE}.`,
    );
  }
  if (ihdr.interlace !== 0) {
    throw unsupported('This PNG uses interlacing, which Pixels does not support yet.');
  }
  if (ihdr.bitDepth === 16) {
    throw unsupported('This PNG uses 16 bits per channel, which Pixels does not support yet.');
  }
  if (ihdr.colorType === 3 && !palette) throw corrupt('The PNG is missing its color palette.');

  const idat = concatBytes(idatChunks);
  let raw: Uint8Array;
  try {
    raw = await inflateZlib(idat);
  } catch {
    throw corrupt('The PNG\u2019s compressed pixel data is invalid.');
  }

  const scanlines = unfilter(raw, ihdr);
  const pixels = buildPixels(scanlines, ihdr, palette, paletteAlpha);
  return { width: ihdr.width, height: ihdr.height, pixels };
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
  if (bytes.length < 8) throw corrupt('The file is too small to be a PNG.');
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

function unfilter(raw: Uint8Array, ihdr: Ihdr): Uint8Array {
  const channels = channelsFor(ihdr.colorType);
  const bitsPerPixel = channels * ihdr.bitDepth;
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const rowBytes = Math.ceil((ihdr.width * bitsPerPixel) / 8);
  const stride = rowBytes + 1;
  if (raw.length < stride * ihdr.height) throw corrupt('The PNG pixel data is truncated.');
  const out = new Uint8Array(rowBytes * ihdr.height);
  let prevRow: Uint8Array | null = null;
  for (let y = 0; y < ihdr.height; y++) {
    const filterType = raw[y * stride]!;
    const src = raw.subarray(y * stride + 1, y * stride + 1 + rowBytes);
    const dst = out.subarray(y * rowBytes, y * rowBytes + rowBytes);
    unfilterRow(filterType, src, dst, prevRow, bytesPerPixel);
    prevRow = dst;
  }
  return out;
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

function buildPixels(
  scanlines: Uint8Array,
  ihdr: Ihdr,
  palette: Uint8Array | null,
  trns: Uint8Array | null,
): Uint32Array {
  const { width, height, bitDepth, colorType } = ihdr;
  const pixels = new Uint32Array(width * height);
  const outBytes = new Uint8Array(pixels.buffer);
  const channels = channelsFor(colorType);
  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const maxSample = (1 << bitDepth) - 1;

  const readSample = (row: Uint8Array, index: number): number => {
    if (bitDepth === 8) return row[index]!;
    const bitPos = index * bitDepth;
    const byteIndex = bitPos >> 3;
    const shift = 8 - bitDepth - (bitPos & 7);
    return (row[byteIndex]! >> shift) & maxSample;
  };

  for (let y = 0; y < height; y++) {
    const row = scanlines.subarray(y * rowBytes, y * rowBytes + rowBytes);
    for (let x = 0; x < width; x++) {
      const outOffset = (y * width + x) * 4;
      switch (colorType) {
        case 0: {
          const raw = readSample(row, x);
          const value = bitDepth === 8 ? raw : Math.round((raw * 255) / maxSample);
          outBytes[outOffset] = value;
          outBytes[outOffset + 1] = value;
          outBytes[outOffset + 2] = value;
          outBytes[outOffset + 3] = 255;
          break;
        }
        case 2: {
          const base = x * 3;
          outBytes[outOffset] = row[base]!;
          outBytes[outOffset + 1] = row[base + 1]!;
          outBytes[outOffset + 2] = row[base + 2]!;
          outBytes[outOffset + 3] = 255;
          break;
        }
        case 3: {
          const index = readSample(row, x);
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
          const base = x * 2;
          const value = row[base]!;
          outBytes[outOffset] = value;
          outBytes[outOffset + 1] = value;
          outBytes[outOffset + 2] = value;
          outBytes[outOffset + 3] = row[base + 1]!;
          break;
        }
        case 6: {
          const base = x * 4;
          outBytes[outOffset] = row[base]!;
          outBytes[outOffset + 1] = row[base + 1]!;
          outBytes[outOffset + 2] = row[base + 2]!;
          outBytes[outOffset + 3] = row[base + 3]!;
          break;
        }
      }
    }
  }
  return pixels;
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

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]!);
  return s;
}

let crcTable: Int32Array | null = null;
function getCrcTable(): Int32Array {
  if (crcTable) return crcTable;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
