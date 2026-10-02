import { describe, expect, test } from 'bun:test';
import { classifyColorTag, type PngColorTag } from './colorTag';

/** Real cICP chunk bytes captured from a macOS Display P3 screenshot, generated with
 *  `sips -m "Display P3.icc" --out ... test.png` and parsed byte-for-byte out of the resulting
 *  PNG. primaries=12 (P3-D65), transfer=13 (sRGB/IEC 61966-2-1), matrix=0 (RGB, not YCbCr),
 *  full_range=1. */
const CICP_DISPLAY_P3 = new Uint8Array([12, 13, 0, 1]);
/** The documented H.273 sRGB pairing (primaries=1/BT.709). Not independently observed from a
 *  real file (a real sRGB PNG generated the same way skips cICP and uses only a plain `sRGB`
 *  chunk), but honored if some other tool ever emits it. */
const CICP_SRGB = new Uint8Array([1, 13, 0, 1]);

/** The real, complete `iCCP` chunk payload (profile name + compression method byte + compressed
 *  ICC profile) captured from the same macOS-tagged Display P3 PNG above. The embedded profile is
 *  byte-identical to `/System/Library/ColorSync/Profiles/Display P3.icc` and uses an ICC v4
 *  `mluc` (multi-localized-unicode) `desc` tag reading "Display P3". */
const REAL_P3_ICCP_CHUNK_BASE64 =
  'a0NHQ29sb3JTcGFjZURpc3BsYXlQMwAAKJF9kLFLw1AQxr9WpaB1EB0cHDKJQ5SSCro4tBVEcQhVweqUvqapkMZHkiIFN/+Bgv+BCs5uFoc6OjgIopPo5uSk4KLleS+JpCJ6j+N+fO+74zggOW5wbvcDqDu+W1zKK5ulLSX1jAS9IAzm8Zyur0r+rj/j/T703k7LWb///43Biukxqp+UGcZdH0ioxPqezyXvE4+5tBRxS7IV8onkcsjngWe9WCC+JlZYzagQvxCr5R7d6uG63WDRDnL7tOlsrMk5lBNYxA48cNgw0IQCHdk//LOBv4BdcjfhUp+FGnzqyZEiJ5jEy3DAMAOVWEOGUpN3ju53F91PjbWDJ2ChI4S4iLWVDnA2Rydrx9rUPDAyBFy1ueEagdRHmaxWgddTYLgEjN5Qz7ZXzWrh9uk8MPAoxNskkDoEui0hPo6E6B5T8wNw6XwBA6diEw==';

const SRGB_CHUNK = new Uint8Array([0]); // rendering intent: perceptual

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
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
  await writer.write(data as unknown as BufferSource);
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

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

/** Builds a minimal, legacy ICC v2 profile with exactly one ASCII-typed `desc` tag - the same
 *  layout macOS's own `sRGB Profile.icc` uses (confirmed by parsing it directly), just enough
 *  structure for `classifyColorTag` to find and read the description. */
function buildLegacyAsciiProfile(description: string): Uint8Array {
  const asciiCount = description.length + 1; // includes the null terminator, per the spec
  const tagDataSize = 12 + asciiCount; // type(4) + reserved(4) + count(4) + ascii
  const tagTableStart = 128 + 4;
  const tagDataStart = tagTableStart + 12; // one tag table entry
  const profile = new Uint8Array(tagDataStart + tagDataSize);
  writeUint32BE(profile, 128, 1); // tag count
  writeAscii(profile, tagTableStart, 'desc');
  writeUint32BE(profile, tagTableStart + 4, tagDataStart);
  writeUint32BE(profile, tagTableStart + 8, tagDataSize);
  writeAscii(profile, tagDataStart, 'desc');
  writeUint32BE(profile, tagDataStart + 8, asciiCount);
  writeAscii(profile, tagDataStart + 12, description);
  // null terminator already zero: `new Uint8Array` is zero-initialized
  return profile;
}

async function buildIccpChunk(description: string, name = 'Test Profile'): Promise<Uint8Array> {
  const profile = buildLegacyAsciiProfile(description);
  const compressed = await deflateZlib(profile);
  const out = new Uint8Array(name.length + 2 + compressed.length);
  writeAscii(out, 0, name);
  out[name.length] = 0; // null terminator
  out[name.length + 1] = 0; // compression method: zlib
  out.set(compressed, name.length + 2);
  return out;
}

async function classify(chunks: {
  cicp?: Uint8Array | null;
  iccp?: Uint8Array | null;
  srgb?: Uint8Array | null;
}): Promise<PngColorTag> {
  return classifyColorTag({
    cicp: chunks.cicp ?? null,
    iccp: chunks.iccp ?? null,
    srgb: chunks.srgb ?? null,
  });
}

describe('classifyColorTag', () => {
  test('no color chunk at all defaults to sRGB, matching the PNG spec', async () => {
    expect(await classify({})).toBe('srgb');
  });

  test('a plain sRGB chunk classifies as sRGB', async () => {
    expect(await classify({ srgb: SRGB_CHUNK })).toBe('srgb');
  });

  test('the real Display P3 cICP code points classify as display-p3', async () => {
    expect(await classify({ cicp: CICP_DISPLAY_P3 })).toBe('display-p3');
  });

  test('the documented sRGB cICP code points classify as sRGB', async () => {
    expect(await classify({ cicp: CICP_SRGB })).toBe('srgb');
  });

  test('an unrecognized cICP combination is unknown-icc, not a silent sRGB guess', async () => {
    // Rec. 2020 primaries/transfer: real color information, just not one of our two spaces.
    expect(await classify({ cicp: new Uint8Array([9, 16, 0, 1]) })).toBe('unknown-icc');
  });

  test('a cICP chunk using YCbCr matrix coefficients is unknown-icc: not plain RGB', async () => {
    expect(await classify({ cicp: new Uint8Array([1, 13, 1, 1]) })).toBe('unknown-icc');
  });

  test('a cICP chunk with limited (non-full) range is unknown-icc', async () => {
    expect(await classify({ cicp: new Uint8Array([1, 13, 0, 0]) })).toBe('unknown-icc');
  });

  test('the real, captured Display P3 iCCP chunk (mluc desc tag) classifies as display-p3', async () => {
    const iccp = base64ToBytes(REAL_P3_ICCP_CHUNK_BASE64);
    expect(await classify({ iccp })).toBe('display-p3');
  });

  test('an iCCP chunk describing sRGB (legacy ASCII desc tag) classifies as sRGB', async () => {
    const iccp = await buildIccpChunk('sRGB IEC61966-2.1');
    expect(await classify({ iccp })).toBe('srgb');
  });

  test('an iCCP chunk with an unrecognized description is unknown-icc', async () => {
    const iccp = await buildIccpChunk('Adobe RGB (1998)');
    expect(await classify({ iccp })).toBe('unknown-icc');
  });

  test('a DCI-P3 profile is unknown-icc, not classified as display-p3 by a loose "p3" substring match', async () => {
    const iccp = await buildIccpChunk('DCI(P3)');
    expect(await classify({ iccp })).toBe('unknown-icc');
  });

  test('a corrupt iCCP chunk (truncated, no name terminator) is unknown-icc, not a crash', async () => {
    expect(await classify({ iccp: new Uint8Array([1, 2, 3]) })).toBe('unknown-icc');
  });

  test('cICP takes precedence over iCCP, as a real Display P3 screenshot carries both', async () => {
    const srgbIccp = await buildIccpChunk('sRGB IEC61966-2.1');
    expect(await classify({ cicp: CICP_DISPLAY_P3, iccp: srgbIccp })).toBe('display-p3');
  });

  test('iCCP takes precedence over sRGB when both are present', async () => {
    const iccp = base64ToBytes(REAL_P3_ICCP_CHUNK_BASE64);
    expect(await classify({ iccp, srgb: SRGB_CHUNK })).toBe('display-p3');
  });
});
