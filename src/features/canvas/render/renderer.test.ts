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
  getContext() {
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
      ) {}
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
  } finally {
    Object.assign(globalThis, {
      document: priorDocument,
      ImageData: priorImageData,
      requestAnimationFrame: priorRaf,
      cancelAnimationFrame: priorCancel,
    });
  }
});
