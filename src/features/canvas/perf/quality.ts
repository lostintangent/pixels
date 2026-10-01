import { convertPixelColorSpace, createBitmapDocument, packRgba } from '../../document';
import { createCanvasRenderer } from '../render/renderer';

const SIDE = 512;
const OUTPUT = SIDE / 2;

function areaReferenceError(
  source: Uint8ClampedArray,
  actual: Uint8ClampedArray,
  outputSide: number,
  scale: number,
): number {
  let error = 0;
  for (let y = 0; y < outputSide; y++) {
    const top = y / scale;
    const bottom = (y + 1) / scale;
    for (let x = 0; x < outputSide; x++) {
      const left = x / scale;
      const right = (x + 1) / scale;
      for (let channel = 0; channel < 3; channel++) {
        let weighted = 0;
        for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
          const height = Math.min(bottom, sy + 1) - Math.max(top, sy);
          for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
            const width = Math.min(right, sx + 1) - Math.max(left, sx);
            weighted += source[(sy * SIDE + sx) * 4 + channel]! * width * height;
          }
        }
        const expected = weighted / ((right - left) * (bottom - top));
        error += Math.abs(actual[(y * outputSide + x) * 4 + channel]! - expected);
      }
    }
  }
  return error / (outputSide * outputSide * 3);
}

function frames(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** The real renderer at 25% CSS zoom on a 2× display, checked against 2×2 area averages. */
export async function checkZoomOutQuality(): Promise<Record<string, number>> {
  const bitmap = createBitmapDocument('zoom-quality', SIDE, SIDE);
  const viewportCanvas = document.createElement('canvas');
  const renderer = createCanvasRenderer({
    documentCanvas: document.createElement('canvas'),
    viewportCanvas,
    overlayCanvas: document.createElement('canvas'),
  });
  renderer.setDocument(bitmap);
  renderer.setViewport({
    zoom: 0.25,
    panX: 0,
    panY: 0,
    cssWidth: 128,
    cssHeight: 128,
    devicePixelRatio: 2,
  });
  const errors: Record<string, number> = {};
  const measure = async (
    name: string,
    fill: () => void,
    dirty = { x: 0, y: 0, width: SIDE, height: SIDE },
  ) => {
    fill();
    bitmap.events.invalidate(dirty);
    await frames();
    const actual = viewportCanvas.getContext('2d')!.getImageData(0, 0, OUTPUT, OUTPUT).data;
    let absoluteError = 0;
    for (let y = 0; y < OUTPUT; y++) {
      for (let x = 0; x < OUTPUT; x++) {
        for (let channel = 0; channel < 3; channel++) {
          const index = (y * 2 * SIDE + x * 2) * 4 + channel;
          const expected =
            (bitmap.rgbaBytes[index]! +
              bitmap.rgbaBytes[index + 4]! +
              bitmap.rgbaBytes[index + SIDE * 4]! +
              bitmap.rgbaBytes[index + SIDE * 4 + 4]!) /
            4;
          absoluteError += Math.abs(actual[(y * OUTPUT + x) * 4 + channel]! - expected);
        }
      }
    }
    errors[name] = absoluteError / (OUTPUT * OUTPUT * 3);
  };
  try {
    await measure('1px stripes', () => {
      for (let y = 0; y < SIDE; y++) {
        for (let x = 0; x < SIDE; x++) {
          const index = (y * SIDE + x) * 4;
          const value = x & 1 ? 255 : 0;
          bitmap.rgbaBytes[index] = value;
          bitmap.rgbaBytes[index + 1] = value;
          bitmap.rgbaBytes[index + 2] = value;
          bitmap.rgbaBytes[index + 3] = 255;
        }
      }
    });
    await measure(
      '1px dirty update',
      () => {
        bitmap.pixels[100 * SIDE + 100] = packRgba(255, 255, 255);
      },
      { x: 100, y: 100, width: 1, height: 1 },
    );
    const changedPixel = viewportCanvas.getContext('2d')!.getImageData(50, 50, 1, 1).data;
    errors['dirty changed pixel'] = Math.abs(changedPixel[0]! - 191.25);
    await measure('gradient', () => {
      for (let y = 0; y < SIDE; y++) {
        for (let x = 0; x < SIDE; x++) {
          const index = (y * SIDE + x) * 4;
          bitmap.rgbaBytes[index] = x / 2;
          bitmap.rgbaBytes[index + 1] = y / 2;
          bitmap.rgbaBytes[index + 2] = (x + y) / 4;
          bitmap.rgbaBytes[index + 3] = 255;
        }
      }
    });
    const textCanvas = document.createElement('canvas');
    textCanvas.width = SIDE;
    textCanvas.height = SIDE;
    const ctx = textCanvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, SIDE, SIDE);
    ctx.fillStyle = '#000';
    ctx.font = '14px sans-serif';
    for (let y = 14; y < SIDE; y += 18) ctx.fillText('Pixels small text 0123456789', 2, y);
    await measure('small text', () =>
      bitmap.rgbaBytes.set(ctx.getImageData(0, 0, SIDE, SIDE).data),
    );
    ctx.fillRect(0, 101, SIDE, 1);
    ctx.fillRect(137, 0, 1, SIDE);
    bitmap.rgbaBytes.set(ctx.getImageData(0, 0, SIDE, SIDE).data);
    bitmap.events.invalidate({ x: 0, y: 0, width: SIDE, height: SIDE });
    for (const scale of [1.1, 1.2]) {
      const zoom = scale / 2;
      renderer.setViewport({
        zoom,
        panX: 0,
        panY: 0,
        cssWidth: Math.ceil(SIDE * zoom),
        cssHeight: Math.ceil(SIDE * zoom),
        devicePixelRatio: 2,
      });
      await frames();
      const outputSide = Math.floor(SIDE * scale);
      const actual = viewportCanvas
        .getContext('2d')!
        .getImageData(0, 0, outputSide, outputSide).data;
      errors[`text and lines ${scale}x`] = areaReferenceError(
        bitmap.rgbaBytes,
        actual,
        outputSide,
        scale,
      );
    }
    return errors;
  } finally {
    renderer.dispose();
  }
}

export async function checkP3Canvas(): Promise<boolean> {
  const bitmap = createBitmapDocument('p3-quality', 1, 1, 'P3', 'display-p3');
  bitmap.rgbaBytes.set([200, 100, 20, 255]);
  const documentCanvas = document.createElement('canvas');
  const viewportCanvas = document.createElement('canvas');
  const overlayCanvas = document.createElement('canvas');
  const renderer = createCanvasRenderer({
    documentCanvas,
    viewportCanvas,
    overlayCanvas,
    colorSpace: bitmap.colorSpace,
  });
  try {
    renderer.setDocument(bitmap);
    renderer.setViewport({
      zoom: 1,
      panX: 0,
      panY: 0,
      cssWidth: 1,
      cssHeight: 1,
      devicePixelRatio: 1,
    });
    await frames();
    const documentCtx = documentCanvas.getContext('2d')!;
    const viewportCtx = viewportCanvas.getContext('2d')!;
    const overlayCtx = overlayCanvas.getContext('2d')!;
    const pixel = viewportCtx.getImageData(0, 0, 1, 1, { colorSpace: 'display-p3' }).data;
    return (
      documentCtx.getContextAttributes().colorSpace === 'display-p3' &&
      viewportCtx.getContextAttributes().colorSpace === 'display-p3' &&
      overlayCtx.getContextAttributes().colorSpace === 'display-p3' &&
      pixel[0] === 200 &&
      pixel[1] === 100 &&
      pixel[2] === 20 &&
      pixel[3] === 255
    );
  } finally {
    renderer.dispose();
  }
}

export function checkColorConversion(): number {
  const source = new Uint32Array([packRgba(100, 120, 140)]);
  if (convertPixelColorSpace(source, 1, 1, 'srgb', 'srgb') !== source) return Infinity;
  const p3 = convertPixelColorSpace(source, 1, 1, 'srgb', 'display-p3');
  const restored = convertPixelColorSpace(p3, 1, 1, 'display-p3', 'srgb');
  const bytes = new Uint8Array(restored.buffer);
  return Math.max(Math.abs(bytes[0]! - 100), Math.abs(bytes[1]! - 120), Math.abs(bytes[2]! - 140));
}
