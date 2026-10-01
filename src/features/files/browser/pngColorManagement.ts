/** Converts PNG bytes carrying real color information we can't classify ourselves (an ICC
 *  profile matching neither of our `'srgb'`/`'display-p3'` shorthand checks in `core/colorTag.ts`)
 *  into Display P3 pixels, using the browser's own full ICC color management. We don't implement
 *  general ICC transforms (XYZ matrices, TRC curves) ourselves, so this is the only place that
 *  work can happen: `createImageBitmap` decodes the PNG with its embedded profile intact, and
 *  drawing it into a `display-p3` canvas lets the browser do the real conversion. P3 (not sRGB)
 *  is the target because it's the wider of Pixels' two document color spaces, so an unusual
 *  profile's own gamut is less likely to clip than it would converting straight to sRGB.
 *
 *  Returns `null` (never throws) when the DOM APIs this needs aren't available — e.g. under
 *  `bun test`, or a non-browser host. The caller then keeps the already-decoded pixels, exact but
 *  untagged as plain sRGB: the image still opens, just without the extra color correction a
 *  genuinely obscure embedded profile would otherwise get. */
export async function convertUnknownIccPngToDisplayP3(
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<Uint32Array | null> {
  if (typeof createImageBitmap === 'undefined' || typeof globalThis.document === 'undefined') {
    return null;
  }
  try {
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const result = ctx.getImageData(0, 0, width, height, { colorSpace: 'display-p3' });
    return new Uint32Array(result.data.buffer, result.data.byteOffset, width * height).slice();
  } catch {
    return null;
  }
}
