import { convertPixelColorSpace, createBitmapDocument, packRgba } from '../../document';
import { annotationsFor } from '../../annotations';
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
    annotationCanvas: document.createElement('canvas'),
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
  const annotationCanvas = document.createElement('canvas');
  const overlayCanvas = document.createElement('canvas');
  const renderer = createCanvasRenderer({
    documentCanvas,
    viewportCanvas,
    annotationCanvas,
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
    const annotationCtx = annotationCanvas.getContext('2d')!;
    const pixel = viewportCtx.getImageData(0, 0, 1, 1, { colorSpace: 'display-p3' }).data;
    return (
      documentCtx.getContextAttributes().colorSpace === 'display-p3' &&
      viewportCtx.getContextAttributes().colorSpace === 'display-p3' &&
      overlayCtx.getContextAttributes().colorSpace === 'display-p3' &&
      annotationCtx.getContextAttributes().colorSpace === 'display-p3' &&
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

/** Compare the composited live overlay with the same pixels after commit. */
export async function checkPreviewGrid(): Promise<Record<string, number>> {
  const width = 24;
  const height = 16;
  const zoom = 10;
  const viewportCanvas = document.createElement('canvas');
  const overlayCanvas = document.createElement('canvas');
  const composite = document.createElement('canvas');
  const scale = window.devicePixelRatio;
  composite.width = width * zoom * scale;
  composite.height = height * zoom * scale;
  const compositeCtx = composite.getContext('2d')!;
  const renderer = createCanvasRenderer({
    documentCanvas: document.createElement('canvas'),
    viewportCanvas,
    annotationCanvas: document.createElement('canvas'),
    overlayCanvas,
  });
  const emptyOverlay = { grid: 'auto' as const, cursor: null, marquee: null, preview: null };
  const capture = async () => {
    await frames();
    compositeCtx.clearRect(0, 0, composite.width, composite.height);
    compositeCtx.drawImage(viewportCanvas, 0, 0);
    compositeCtx.drawImage(overlayCanvas, 0, 0);
    return compositeCtx.getImageData(0, 0, composite.width, composite.height).data.slice();
  };
  const difference = (before: Uint8ClampedArray, after: Uint8ClampedArray) => {
    let max = 0;
    for (let i = 0; i < before.length; i++) max = Math.max(max, Math.abs(before[i]! - after[i]!));
    return max;
  };
  const ink = packRgba(27, 27, 38);
  const errors: Record<string, number> = {};
  try {
    renderer.setViewport({
      zoom,
      panX: 0,
      panY: 0,
      cssWidth: width * zoom,
      cssHeight: height * zoom,
      devicePixelRatio: scale,
    });
    const line = createBitmapDocument('preview-line', width, height);
    const lineBounds = { x: 2, y: 4, width: 12, height: 1 };
    const linePixels = new Uint32Array(lineBounds.width).fill(ink);
    renderer.setDocument(line);
    renderer.setOverlay({ ...emptyOverlay, preview: { bounds: lineBounds, pixels: linePixels } });
    const liveLine = await capture();
    line.pixels.set(linePixels, lineBounds.y * width + lineBounds.x);
    line.events.invalidate(lineBounds);
    renderer.setOverlay(emptyOverlay);
    errors.line = difference(liveLine, await capture());

    for (const [name, targetX] of [
      ['float', 9],
      ['overlapping float', 4],
    ] as const) {
      const bitmap = createBitmapDocument(name, width, height);
      const source = { x: 2, y: 2, width: 4, height: 4 };
      const pixels = new Uint32Array(source.width * source.height);
      for (let y = 0; y < source.height; y++) {
        for (let x = 0; x < source.width; x++) {
          const color = x === 0 || y === 0 ? ink : packRgba(255, 207, 139);
          pixels[y * source.width + x] = color;
          bitmap.pixels[(source.y + y) * width + source.x + x] = color;
        }
      }
      const target = { ...source, x: targetX };
      renderer.setDocument(bitmap);
      renderer.setOverlay({
        ...emptyOverlay,
        sourceClear: source,
        preview: { bounds: target, pixels },
      });
      const liveFloat = await capture();
      for (let y = 0; y < source.height; y++) {
        bitmap.pixels.fill(
          0,
          (source.y + y) * width + source.x,
          (source.y + y) * width + source.x + source.width,
        );
        bitmap.pixels.set(
          pixels.subarray(y * source.width, (y + 1) * source.width),
          (target.y + y) * width + target.x,
        );
      }
      bitmap.events.invalidate({
        x: source.x,
        y: source.y,
        width: targetX + source.width - source.x,
        height: source.height,
      });
      renderer.setOverlay(emptyOverlay);
      errors[name] = difference(liveFloat, await capture());
    }
    return errors;
  } finally {
    renderer.dispose();
  }
}

export async function checkAnnotationLayer(): Promise<{
  passed: boolean;
  primary: number[];
  outside: number[];
  handle: number[];
}> {
  const bitmap = createBitmapDocument('shape-quality', 32, 32, 'Shapes', 'display-p3');
  const annotationCanvas = document.createElement('canvas');
  const overlayCanvas = document.createElement('canvas');
  const renderer = createCanvasRenderer({
    documentCanvas: document.createElement('canvas'),
    viewportCanvas: document.createElement('canvas'),
    annotationCanvas,
    overlayCanvas,
    colorSpace: bitmap.colorSpace,
  });
  try {
    renderer.setDocument(bitmap);
    renderer.setViewport({
      zoom: 1,
      panX: 0,
      panY: 0,
      cssWidth: 40,
      cssHeight: 40,
      devicePixelRatio: 2,
    });
    renderer.setOverlay({
      grid: 'off',
      cursor: null,
      marquee: null,
      preview: null,
      selectedAnnotationId: 'rectangle',
    });
    annotationsFor(bitmap).commit({
      id: 'rectangle',
      kind: 'rectangle',
      start: { x: 4, y: 4 },
      end: { x: 20, y: 20 },
      width: 2,
      color: packRgba(200, 100, 20),
    });
    const ctx = annotationCanvas.getContext('2d')!;
    let stroke = ctx.getImageData(8, 24, 1, 1, { colorSpace: 'display-p3' }).data;
    for (let attempt = 0; stroke[3] === 0 && attempt < 20; attempt++) {
      await frames();
      stroke = ctx.getImageData(8, 24, 1, 1, { colorSpace: 'display-p3' }).data;
    }
    const blank = ctx.getImageData(60, 60, 1, 1, { colorSpace: 'display-p3' }).data;
    const handle = overlayCanvas.getContext('2d')!.getImageData(8, 8, 1, 1).data;
    const primaryOkay =
      ctx.getContextAttributes().colorSpace === 'display-p3' &&
      stroke[0] === 200 &&
      stroke[1] === 100 &&
      stroke[2] === 20 &&
      stroke[3] === 255 &&
      blank[3] === 0 &&
      handle[3]! > 0;
    annotationsFor(bitmap).commit({
      id: 'outside-arrow',
      kind: 'arrow',
      start: { x: 25, y: 16 },
      end: { x: 38, y: 16 },
      width: 2,
      color: packRgba(200, 100, 20),
    });
    renderer.setOverlay({
      grid: 'off',
      cursor: null,
      marquee: null,
      preview: null,
      selectedAnnotationId: 'outside-arrow',
    });
    await frames();
    const overlayPixels = overlayCanvas.getContext('2d')!;
    const beyondImage = overlayPixels.getImageData(65, 32, 1, 1).data;
    const outsideHandle = overlayPixels.getImageData(76, 32, 1, 1).data;
    return {
      passed: primaryOkay && beyondImage[3] === 0 && outsideHandle[3]! > 0,
      primary: Array.from(stroke),
      outside: Array.from(beyondImage),
      handle: Array.from(outsideHandle),
    };
  } finally {
    renderer.dispose();
  }
}
