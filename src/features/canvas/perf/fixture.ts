import type { Viewport } from '../core/contracts';
import { createCanvasRenderer } from '../render/renderer';
import { createBitmapDocument, packRgba } from '../../document';
import { annotationsFor, type Annotation } from '../../annotations';
import { createDocumentHistory } from '../../history';
import { beginStroke, FillWorkspace, floodFill } from '../../tools';
import {
  checkAnnotationLayer,
  checkColorConversion,
  checkP3Canvas,
  checkZoomOutQuality,
} from './quality';

const SIDE = 1024;
const INK = packRgba(18, 111, 202);
const WALL = packRgba(25, 25, 25);
const bitmap = createBitmapDocument('browser-perf', SIDE, SIDE);
const largeBitmap = createBitmapDocument('browser-perf-large', 4096, 4096);
const largeAnnotations = annotationsFor(largeBitmap);
const handleShape: Annotation = {
  id: 'handle-drag',
  kind: 'rectangle',
  start: { x: 512, y: 512 },
  end: { x: 3584, y: 3584 },
  width: 12,
  color: INK,
};
const handlePreview: Annotation = {
  ...handleShape,
  start: { ...handleShape.start },
  end: { ...handleShape.end },
};
largeBitmap.pixels.fill(packRgba(48, 96, 160));
const history = createDocumentHistory();
const fillWorkspace = new FillWorkspace();
/** The renderer's default checker and grid, plus the editor's dark document edge and shadow. */
const colors = {
  checkerA: '#fff',
  checkerB: '#d6d6d6',
  gridMinor: 'rgba(0,0,0,.12)',
  gridMajor: 'rgba(0,0,0,.32)',
  edge: 'rgba(255, 255, 255, 0.1)',
  shadow: 'rgba(0, 0, 0, 0.6)',
};
const baseViewport: Viewport = {
  zoom: 8,
  panX: window.innerWidth / 2 - 512 * 8,
  panY: window.innerHeight / 2 - 512 * 8,
  cssWidth: window.innerWidth,
  cssHeight: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio,
};
const maze = new Uint32Array(SIDE * SIDE);
for (let y = 8; y < SIDE - 8; y += 8) {
  for (let x = 0; x < SIDE; x++) {
    if ((y / 8) % 2 === 0 ? x < SIDE - 1 : x > 0) maze[y * SIDE + x] = WALL;
  }
}

const renderer = createCanvasRenderer({
  documentCanvas: document.createElement('canvas'),
  viewportCanvas: document.querySelector<HTMLCanvasElement>('#viewport')!,
  annotationCanvas: document.querySelector<HTMLCanvasElement>('#annotations')!,
  overlayCanvas: document.querySelector<HTMLCanvasElement>('#overlay')!,
});
renderer.setDocument(bitmap);
let activeBitmap = bitmap;
renderer.setViewport(baseViewport);
renderer.setOverlay({ grid: 'auto', cursor: null, marquee: null, preview: null, colors });

function frames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    const next = () => {
      if (--count === 0) resolve();
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  });
}

export interface BrowserPerfApi {
  reset(kind: 'blank' | 'maze' | 'large'): Promise<void>;
  runStroke(): Promise<void>;
  runPanZoom(): Promise<void>;
  runMazeFill(): Promise<void>;
  runLargePan(): Promise<void>;
  prepareShapeDrag(): Promise<void>;
  runShapeHandleDrag(): Promise<void>;
  checkZoomOutQuality(): Promise<Record<string, number>>;
  checkP3Canvas(): Promise<boolean>;
  checkColorConversion(): number;
  checkAnnotationLayer: typeof checkAnnotationLayer;
}

const api: BrowserPerfApi = {
  async reset(kind) {
    history.clear();
    if (kind === 'large') {
      largeAnnotations.replace([]);
      renderer.setOverlay({ grid: 'off', cursor: null, marquee: null, preview: null, colors });
      if (activeBitmap !== largeBitmap) {
        renderer.setDocument(largeBitmap);
        activeBitmap = largeBitmap;
      }
      renderer.setViewport({
        ...baseViewport,
        zoom: window.innerWidth > 400 ? 0.25 : 0.0625,
        panX: 20,
        panY: 20,
      });
      await frames();
      return;
    }
    if (activeBitmap !== bitmap) {
      renderer.setDocument(bitmap);
      activeBitmap = bitmap;
    }
    if (kind === 'maze') bitmap.pixels.set(maze);
    else bitmap.pixels.fill(0);
    renderer.setViewport(baseViewport);
    bitmap.events.invalidate({ x: 0, y: 0, width: SIDE, height: SIDE });
    await frames();
  },
  runStroke() {
    const stroke = beginStroke(bitmap, { color: INK, size: 16, pixelPerfect: false }, history);
    return new Promise((resolve) => {
      let sample = 0;
      const span = Math.max(8, Math.min(60, Math.floor(baseViewport.cssWidth / 16) - 10));
      const timer = setInterval(() => {
        const period = 2 * span;
        const position = sample % (2 * period);
        const x = 512 - span + (position <= period ? position : 2 * period - position);
        const y = 476 + Math.floor(sample / period) * 18 + ((sample >> 3) & 1);
        stroke.extend({ x, y });
        sample++;
        if (sample === 120) {
          clearInterval(timer);
          stroke.end();
          void frames().then(resolve);
        }
      }, 1000 / 120);
    });
  },
  runPanZoom() {
    return new Promise((resolve) => {
      let frame = 0;
      const next = () => {
        const phase = frame / 90;
        const zoom = 8 * (1 + 0.2 * Math.sin(phase * Math.PI * 2));
        renderer.setViewport({
          ...baseViewport,
          zoom,
          panX:
            baseViewport.cssWidth / 2 -
            512 * zoom +
            Math.min(100, baseViewport.cssWidth / 5) * Math.sin(phase * Math.PI * 2),
          panY:
            baseViewport.cssHeight / 2 -
            512 * zoom +
            Math.min(60, baseViewport.cssHeight / 5) * Math.cos(phase * Math.PI * 2),
        });
        frame++;
        if (frame < 90) requestAnimationFrame(next);
        else void frames().then(resolve);
      };
      requestAnimationFrame(next);
    });
  },
  runLargePan() {
    return new Promise((resolve) => {
      let frame = 0;
      const zoom = window.innerWidth > 400 ? 0.25 : 0.0625;
      const next = () => {
        const phase = (frame / 90) * Math.PI * 2;
        renderer.setViewport({
          ...baseViewport,
          zoom,
          panX: 20 + Math.round(20 * Math.sin(phase)),
          panY: 20 + Math.round(20 * Math.cos(phase)),
        });
        frame++;
        if (frame < 90) requestAnimationFrame(next);
        else void frames().then(resolve);
      };
      requestAnimationFrame(next);
    });
  },
  async prepareShapeDrag() {
    largeAnnotations.commit(handleShape);
    renderer.setOverlay({
      grid: 'off',
      cursor: null,
      marquee: null,
      preview: null,
      selectedAnnotationId: handleShape.id,
      colors,
    });
    await frames(4);
  },
  runShapeHandleDrag() {
    return new Promise((resolve) => {
      let frame = 0;
      const next = () => {
        const phase = (frame / 90) * Math.PI * 2;
        handlePreview.end.x = 3584 + 300 * Math.sin(phase);
        handlePreview.end.y = 3584 + 300 * Math.cos(phase);
        largeAnnotations.showPreview(handlePreview);
        frame++;
        if (frame < 90) requestAnimationFrame(next);
        else {
          largeAnnotations.showPreview(null);
          void frames().then(resolve);
        }
      };
      requestAnimationFrame(next);
    });
  },
  checkZoomOutQuality,
  checkP3Canvas,
  checkColorConversion,
  checkAnnotationLayer,
  async runMazeFill() {
    floodFill(bitmap, { at: { x: 0, y: 0 }, color: INK }, history, fillWorkspace);
    await frames();
  },
};

Object.assign(window, { __pixelsPerf: api });
