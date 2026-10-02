import { expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { createDocumentHistory } from '../../history';
import { beginStroke, floodFill } from '../../tools';
import { createCanvasRenderer } from './renderer';

class TestContext {
  putImages: Array<{ data: Uint8ClampedArray }> = [];
  drawCount = 0;
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  lineDashOffset = 0;
  imageSmoothingEnabled = false;
  imageSmoothingQuality = 'low';
  fillRect(_x: number, _y: number, _width: number, _height: number) {}
  clearRect() {}
  strokeRect() {}
  setLineDash() {}
  setTransform() {}
  save() {}
  restore() {}
  beginPath() {}
  rect(_x: number, _y: number, _width: number, _height: number) {}
  clip() {}
  moveTo() {}
  lineTo() {}
  stroke() {}
  drawImage() {
    this.drawCount++;
  }
  createPattern() {
    return {} as CanvasPattern;
  }
  putImageData(image: { data: Uint8ClampedArray }) {
    this.putImages.push(image);
  }
}

class TestCanvas {
  width = 0;
  height = 0;
  context = new TestContext();
  contextOptions: CanvasRenderingContext2DSettings | undefined;
  getContext(_type: string, options?: CanvasRenderingContext2DSettings) {
    this.contextOptions = options;
    return this.context;
  }
}

test('full-buffer undo rebinds ImageData, and cursor changes redraw only the overlay', () => {
  const priorDocument = globalThis.document;
  const priorImageData = globalThis.ImageData;
  const priorRaf = globalThis.requestAnimationFrame;
  const priorCancel = globalThis.cancelAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  Object.assign(globalThis, {
    document: { createElement: () => new TestCanvas() },
    ImageData: class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
        public options?: ImageDataSettings,
      ) {}
      get colorSpace() {
        return this.options?.colorSpace ?? 'srgb';
      }
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
  });
  const flush = () => {
    while (frames.length) frames.shift()!(0);
  };
  try {
    const documentCanvas = new TestCanvas();
    const viewportCanvas = new TestCanvas();
    const annotationCanvas = new TestCanvas();
    const overlayCanvas = new TestCanvas();
    const renderer = createCanvasRenderer({
      documentCanvas: documentCanvas as unknown as HTMLCanvasElement,
      viewportCanvas: viewportCanvas as unknown as HTMLCanvasElement,
      annotationCanvas: annotationCanvas as unknown as HTMLCanvasElement,
      overlayCanvas: overlayCanvas as unknown as HTMLCanvasElement,
    });
    const document = createBitmapDocument('render', 2, 2);
    const history = createDocumentHistory();
    const ink = packRgba(12, 34, 56);
    renderer.setDocument(document);
    renderer.setViewport({
      zoom: 8,
      panX: 0,
      panY: 0,
      cssWidth: 32,
      cssHeight: 32,
      devicePixelRatio: 1,
    });
    flush();
    const initialBuffer = document.rgbaBytes.buffer;
    floodFill(document, { at: { x: 0, y: 0 }, color: ink }, history);
    flush();
    history.undo(document);
    expect(document.rgbaBytes.buffer).not.toBe(initialBuffer);
    const stroke = beginStroke(document, { color: ink, size: 1, pixelPerfect: false }, history);
    stroke.extend({ x: 1, y: 1 });
    stroke.end();
    flush();
    expect(document.pixels[3]).toBe(ink);
    expect(documentCanvas.context.putImages.at(-1)?.data.buffer).toBe(document.rgbaBytes.buffer);
    renderer.setViewport({
      zoom: 0.25,
      panX: 0,
      panY: 0,
      cssWidth: 32,
      cssHeight: 32,
      devicePixelRatio: 2,
    });
    flush();
    expect(viewportCanvas.context.imageSmoothingEnabled).toBe(true);
    expect(viewportCanvas.context.imageSmoothingQuality).toBe('high');
    renderer.setViewport({
      zoom: 0.5,
      panX: 0,
      panY: 0,
      cssWidth: 32,
      cssHeight: 32,
      devicePixelRatio: 2,
    });
    flush();
    expect(viewportCanvas.context.imageSmoothingEnabled).toBe(false);
    renderer.setViewport({
      zoom: 0.55,
      panX: 0,
      panY: 0,
      cssWidth: 32,
      cssHeight: 32,
      devicePixelRatio: 2,
    });
    renderer.setOverlay({
      grid: 'off',
      cursor: null,
      marquee: null,
      preview: {
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        pixels: new Uint32Array([ink]),
      },
    });
    flush();
    expect(viewportCanvas.context.imageSmoothingEnabled).toBe(true);
    expect(viewportCanvas.context.imageSmoothingQuality).toBe('low');
    expect(overlayCanvas.context.imageSmoothingEnabled).toBe(true);
    expect(overlayCanvas.context.imageSmoothingQuality).toBe('low');
    const draws = viewportCanvas.context.drawCount;
    const uploads = documentCanvas.context.putImages.length;
    renderer.setOverlay({
      grid: 'off',
      cursor: { x: 1, y: 1, width: 1, height: 1 },
      marquee: null,
      preview: null,
    });
    flush();
    expect(viewportCanvas.context.drawCount).toBe(draws);
    expect(documentCanvas.context.putImages.length).toBe(uploads);
    renderer.dispose();

    const p3DocumentCanvas = new TestCanvas();
    const p3ViewportCanvas = new TestCanvas();
    const p3AnnotationCanvas = new TestCanvas();
    const p3OverlayCanvas = new TestCanvas();
    const p3Renderer = createCanvasRenderer({
      documentCanvas: p3DocumentCanvas as unknown as HTMLCanvasElement,
      viewportCanvas: p3ViewportCanvas as unknown as HTMLCanvasElement,
      annotationCanvas: p3AnnotationCanvas as unknown as HTMLCanvasElement,
      overlayCanvas: p3OverlayCanvas as unknown as HTMLCanvasElement,
      colorSpace: 'display-p3',
    });
    p3Renderer.setDocument(createBitmapDocument('wide', 1, 1, 'Wide', 'display-p3'));
    p3Renderer.setViewport({
      zoom: 1,
      panX: 0,
      panY: 0,
      cssWidth: 1,
      cssHeight: 1,
      devicePixelRatio: 1,
    });
    flush();
    expect(p3DocumentCanvas.contextOptions?.colorSpace).toBe('display-p3');
    expect(p3ViewportCanvas.contextOptions?.colorSpace).toBe('display-p3');
    expect(p3AnnotationCanvas.contextOptions?.colorSpace).toBe('display-p3');
    expect(p3OverlayCanvas.contextOptions?.colorSpace).toBe('display-p3');
    expect((p3DocumentCanvas.context.putImages.at(-1) as ImageData)?.colorSpace).toBe('display-p3');
    p3Renderer.dispose();
  } finally {
    Object.assign(globalThis, {
      document: priorDocument,
      ImageData: priorImageData,
      requestAnimationFrame: priorRaf,
      cancelAnimationFrame: priorCancel,
    });
  }
});

type Box = { x: number; y: number; width: number; height: number };

/** Records where the document edge can paint: hairline rects and the clip around each shadow. */
class EdgeContext extends TestContext {
  shadowColor = 'transparent';
  shadowBlur = 0;
  shadowOffsetY = 0;
  painted: Array<{ kind: 'edge' | 'shadow'; box: Box }> = [];
  private path: Box | null = null;
  private clipBox: Box | null = null;
  private stack: Array<Box | null> = [];
  override save() {
    this.stack.push(this.clipBox);
  }
  override restore() {
    this.clipBox = this.stack.pop() ?? null;
  }
  override rect(x: number, y: number, width: number, height: number) {
    this.path = { x, y, width, height };
  }
  override clip() {
    this.clipBox = this.path;
  }
  override fillRect(x: number, y: number, width: number, height: number) {
    if (this.fillStyle === EDGE) this.painted.push({ kind: 'edge', box: { x, y, width, height } });
    else if (this.shadowColor === SHADOW)
      this.painted.push({
        kind: 'shadow',
        box: this.clipBox ?? { x: -1e9, y: -1e9, width: 2e9, height: 2e9 },
      });
  }
}

const EDGE = 'rgba(255, 255, 255, 0.1)';
const SHADOW = 'rgba(0, 0, 0, 0.6)';

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('the document edge paints only outside its device-pixel footprint', () => {
  const priorDocument = globalThis.document;
  const priorRaf = globalThis.requestAnimationFrame;
  const priorImageData = globalThis.ImageData;
  const frames: FrameRequestCallback[] = [];
  Object.assign(globalThis, {
    document: { createElement: () => new TestCanvas() },
    ImageData: class {
      constructor(public data: Uint8ClampedArray) {}
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  });
  const flush = () => {
    while (frames.length) frames.shift()!(0);
  };
  try {
    const viewportCanvas = new TestCanvas();
    const context = new EdgeContext();
    viewportCanvas.context = context;
    const renderer = createCanvasRenderer({
      documentCanvas: new TestCanvas() as unknown as HTMLCanvasElement,
      viewportCanvas: viewportCanvas as unknown as HTMLCanvasElement,
      annotationCanvas: new TestCanvas() as unknown as HTMLCanvasElement,
      overlayCanvas: new TestCanvas() as unknown as HTMLCanvasElement,
    });
    renderer.setDocument(createBitmapDocument('edge', 1738, 1032));
    const colors = {
      checkerA: '#3a3a3c',
      checkerB: '#313133',
      gridMinor: 'transparent',
      gridMajor: 'transparent',
      gridMinorLight: 'transparent',
      gridMajorLight: 'transparent',
    };
    const view = {
      zoom: 0.63,
      panX: 77,
      panY: 133,
      cssWidth: 1440,
      cssHeight: 900,
      devicePixelRatio: 2,
    };
    renderer.setOverlay({ grid: 'off', cursor: null, marquee: null, preview: null, colors });
    renderer.setViewport(view);
    flush();
    expect(context.painted).toEqual([]);

    renderer.setOverlay({
      grid: 'off',
      cursor: null,
      marquee: null,
      preview: null,
      colors: { ...colors, edge: EDGE, shadow: SHADOW },
    });
    flush();
    // 1738 × 0.63 = 1094.94 and 1032 × 0.63 = 650.16 CSS px, so both far edges are fractional.
    const footprint = { x: 154, y: 266, width: 2344 - 154, height: 1567 - 266 };
    expect(context.painted.filter((paint) => paint.kind === 'shadow')).toHaveLength(4);
    expect(context.painted.filter((paint) => paint.kind === 'edge')).toHaveLength(4);
    for (const { box } of context.painted) expect(overlaps(box, footprint)).toBe(false);
    const ring = { x: 153, y: 265, width: footprint.width + 2, height: footprint.height + 2 };
    for (const { box } of context.painted.filter((paint) => paint.kind === 'edge'))
      expect(overlaps(box, ring)).toBe(true);

    // Panned off the left side, the left band is beyond the canvas and costs no blurred fill.
    context.painted = [];
    renderer.setViewport({ ...view, panX: -200 });
    flush();
    expect(context.painted.filter((paint) => paint.kind === 'shadow')).toHaveLength(3);
    for (const { box } of context.painted.filter((paint) => paint.kind === 'shadow'))
      expect(box.x + box.width).toBeGreaterThan(0);

    context.painted = [];
    renderer.setViewport({ ...view, zoom: 8, panX: -4000, panY: -4000 });
    flush();
    expect(context.painted).toEqual([]);
    renderer.dispose();
  } finally {
    Object.assign(globalThis, {
      document: priorDocument,
      ImageData: priorImageData,
      requestAnimationFrame: priorRaf,
    });
  }
});
