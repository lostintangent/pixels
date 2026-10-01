import type { DocumentColorSpace } from '../../document';

/** Raw bytes of whichever color-tagging chunks a decoded PNG carried, straight off the wire. */
export interface PngColorChunks {
  cicp: Uint8Array | null;
  iccp: Uint8Array | null;
  srgb: Uint8Array | null;
}

export type PngColorTag = DocumentColorSpace | 'unknown-icc';

/** cICP (ITU-T H.273) code points this app recognizes as exactly one of its two document color
 *  spaces. Verified against a real macOS-tagged Display P3 screenshot (`sips -m "Display
 *  P3.icc"`), which writes precisely `[12, 13, 0, 1]`. The sRGB pairing (`[1, 13, 0, 1]`) is the
 *  documented H.273 convention; real sRGB PNGs we generated the same way skip cICP entirely and
 *  use only a plain `sRGB` chunk; this value is honored if some other tool ever emits it. PNG
 *  requires matrix_coefficients 0 (RGB, not YCbCr) and full_range_flag 1 for either to apply. */
const CICP_DISPLAY_P3 = '12,13,0,1';
const CICP_SRGB = '1,13,0,1';

/**
 * Classifies a PNG's embedded color information into one of Pixels' two supported document color
 * spaces, or `'unknown-icc'` when the PNG is real-color-tagged but with information this app
 * can't map onto either space on its own. Follows the PNG spec's own chunk precedence: cICP first
 * (a real macOS Display P3 screenshot carries both cICP and iCCP, and cICP is the cheaper, exact
 * read), then iCCP, then sRGB, defaulting to sRGB when none of the three chunks is present.
 *
 * Precedence means whichever of these is present wins outright, even if this app doesn't
 * recognize *what* it says: a cICP or iCCP chunk we can't classify is real color information the
 * PNG is handing us, not an invitation to fall through to a weaker chunk or guess sRGB - that's
 * exactly the `'unknown-icc'` case the browser's own color management handles instead.
 */
export async function classifyColorTag(chunks: PngColorChunks): Promise<PngColorTag> {
  if (chunks.cicp) return classifyCicp(chunks.cicp);
  if (chunks.iccp) return classifyIccp(chunks.iccp);
  if (chunks.srgb) return 'srgb';
  return 'srgb';
}

function classifyCicp(data: Uint8Array): PngColorTag {
  if (data.length < 4) return 'unknown-icc';
  const [primaries, transfer, matrix, fullRange] = data;
  if (matrix !== 0 || fullRange !== 1) return 'unknown-icc'; // not plain full-range RGB
  const key = `${primaries},${transfer},${matrix},${fullRange}`;
  if (key === CICP_DISPLAY_P3) return 'display-p3';
  if (key === CICP_SRGB) return 'srgb';
  return 'unknown-icc';
}

/** iCCP chunk layout: a Latin-1, null-terminated profile name (<=79 bytes), then a 1-byte
 *  compression method (always 0, meaning zlib/deflate), then the compressed ICC profile. */
async function classifyIccp(data: Uint8Array): Promise<PngColorTag> {
  let nameEnd = 0;
  while (nameEnd < data.length && data[nameEnd] !== 0) nameEnd++;
  if (nameEnd >= data.length) return 'unknown-icc'; // no terminator: malformed
  const compressionMethod = data[nameEnd + 1];
  if (compressionMethod !== 0) return 'unknown-icc'; // only method 0 (zlib) is defined by the spec
  const compressed = data.subarray(nameEnd + 2);
  let profile: Uint8Array;
  try {
    profile = await inflateZlib(compressed);
  } catch {
    return 'unknown-icc'; // corrupt embedded profile: not fatal to the import, just unclassifiable
  }
  const description = readIccDescription(profile);
  if (!description) return 'unknown-icc';
  const lower = description.toLowerCase();
  if (lower.includes('p3')) return 'display-p3';
  if (lower.includes('srgb')) return 'srgb';
  return 'unknown-icc';
}

/** Decompresses a plain zlib/deflate stream (the format `iCCP` always uses per the spec, and the
 *  same one `IDAT` uses). Kept local to this module, separate from `png.ts`'s own copy, so the
 *  two files don't form an import cycle. */
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
  await writer.write(data as unknown as BufferSource);
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

const ICC_HEADER_SIZE = 128;

/** Walks the ICC profile's tag table (starting right after the 128-byte header) to find and
 *  decode the `desc` (profile description) tag, the one human-readable field every real-world
 *  profile carries. */
function readIccDescription(profile: Uint8Array): string | null {
  if (profile.length < ICC_HEADER_SIZE + 4) return null;
  const tagCount = readUint32BE(profile, ICC_HEADER_SIZE);
  const tableStart = ICC_HEADER_SIZE + 4;
  for (let i = 0; i < tagCount; i++) {
    const entryStart = tableStart + i * 12;
    if (entryStart + 12 > profile.length) break;
    const signature = readAscii(profile, entryStart, 4);
    if (signature !== 'desc') continue;
    const tagOffset = readUint32BE(profile, entryStart + 4);
    const tagSize = readUint32BE(profile, entryStart + 8);
    if (tagOffset + tagSize > profile.length) return null;
    return readDescTag(profile.subarray(tagOffset, tagOffset + tagSize));
  }
  return null;
}

/** Handles both real-world `desc` tag type encodings: the legacy ICC v2 ASCII form (confirmed
 *  against macOS's own `sRGB Profile.icc`) and the ICC v4 `mluc` multi-localized-unicode form
 *  (confirmed against macOS's own `Display P3.icc`). Only the first locale record is read: full
 *  locale selection doesn't matter for substring classification. */
function readDescTag(tag: Uint8Array): string | null {
  if (tag.length < 8) return null;
  const type = readAscii(tag, 0, 4);
  if (type === 'desc') {
    if (tag.length < 12) return null;
    const asciiCount = readUint32BE(tag, 8);
    const start = 12;
    const end = Math.min(start + asciiCount, tag.length);
    return readAscii(tag, start, end - start).replace(/\0+$/, '');
  }
  if (type === 'mluc') {
    if (tag.length < 16) return null;
    const recordCount = readUint32BE(tag, 8);
    const recordSize = readUint32BE(tag, 12);
    if (recordCount < 1) return null;
    const recordStart = 16;
    if (recordStart + recordSize > tag.length) return null;
    const stringLength = readUint32BE(tag, recordStart + 4);
    const stringOffset = readUint32BE(tag, recordStart + 8);
    const start = stringOffset; // relative to the start of the tag
    const end = start + stringLength;
    if (end > tag.length) return null;
    return readUtf16BE(tag, start, stringLength);
  }
  return null;
}

function readUtf16BE(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = 0; i + 1 < length; i += 2) {
    const code = (bytes[start + i]! << 8) | bytes[start + i + 1]!;
    out += String.fromCharCode(code);
  }
  return out;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000 +
      ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)) >>>
    0
  );
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}
