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
  fillRect() {}
  clearRect() {}
  strokeRect() {}
  setLineDash() {}
  setTransform() {}
  save() {}
  restore() {}
  beginPath() {}
  rect() {}
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
    const overlayCanvas = new TestCanvas();
    const renderer = createCanvasRenderer({
      documentCanvas: documentCanvas as unknown as HTMLCanvasElement,
      viewportCanvas: viewportCanvas as unknown as HTMLCanvasElement,
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
    const draws = viewportCanvas.context.drawCount;
    const uploads = documentCanvas.context.putImages.length;
    renderer.setOverlay({
      grid: 'auto',
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
    const p3OverlayCanvas = new TestCanvas();
    const p3Renderer = createCanvasRenderer({
      documentCanvas: p3DocumentCanvas as unknown as HTMLCanvasElement,
      viewportCanvas: p3ViewportCanvas as unknown as HTMLCanvasElement,
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
