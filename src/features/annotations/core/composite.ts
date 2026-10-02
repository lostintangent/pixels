/** Source-over an annotation-only RGBA layer without touching pixels where its alpha is zero. */
export function compositeAnnotationLayer(base: Uint32Array, layer: Uint8ClampedArray): Uint32Array {
  if (layer.byteLength !== base.byteLength)
    throw new RangeError('Shape layer size must match pixels');
  const output = base.slice();
  const destination = new Uint8ClampedArray(output.buffer);
  for (let index = 0; index < layer.length; index += 4) {
    const sourceAlpha = layer[index + 3]!;
    if (sourceAlpha === 0) continue;
    const destinationAlpha = destination[index + 3]!;
    if (sourceAlpha === 255 || destinationAlpha === 0) {
      destination[index] = layer[index]!;
      destination[index + 1] = layer[index + 1]!;
      destination[index + 2] = layer[index + 2]!;
      destination[index + 3] = sourceAlpha;
      continue;
    }
    const remaining = 255 - sourceAlpha;
    const outputAlpha = sourceAlpha + (destinationAlpha * remaining) / 255;
    const destinationWeight = (destinationAlpha * remaining) / 255;
    destination[index] =
      (layer[index]! * sourceAlpha + destination[index]! * destinationWeight) / outputAlpha;
    destination[index + 1] =
      (layer[index + 1]! * sourceAlpha + destination[index + 1]! * destinationWeight) / outputAlpha;
    destination[index + 2] =
      (layer[index + 2]! * sourceAlpha + destination[index + 2]! * destinationWeight) / outputAlpha;
    destination[index + 3] = outputAlpha;
  }
  return output;
}
