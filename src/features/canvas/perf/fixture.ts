import type { Viewport } from '../core/contracts';
import { createCanvasRenderer } from '../render/renderer';
import { createBitmapDocument, packRgba } from '../../document';
import { createDocumentHistory } from '../../history';
import { beginStroke, FillWorkspace, floodFill } from '../../tools';

const SIDE = 1024;
const INK = packRgba(18, 111, 202);
const WALL = packRgba(25, 25, 25);
const bitmap = createBitmapDocument('browser-perf', SIDE, SIDE);
const history = createDocumentHistory();
const fillWorkspace = new FillWorkspace();
const baseViewport: Viewport = {
  zoom: 8,
  panX: 720 - 512 * 8,
  panY: 450 - 512 * 8,
  cssWidth: 1440,
  cssHeight: 900,
  devicePixelRatio: 1,
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
  overlayCanvas: document.querySelector<HTMLCanvasElement>('#overlay')!,
});
renderer.setDocument(bitmap);
renderer.setViewport(baseViewport);
renderer.setOverlay({ grid: 'auto', cursor: null, marquee: null, preview: null });

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
  reset(kind: 'blank' | 'maze'): Promise<void>;
  runStroke(): Promise<void>;
  runPanZoom(): Promise<void>;
  runMazeFill(): Promise<void>;
}

const api: BrowserPerfApi = {
  async reset(kind) {
    history.clear();
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
      const timer = setInterval(() => {
        const x = 452 + sample;
        stroke.extend({ x, y: 512 + ((sample >> 3) & 1) });
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
          panX: 720 - 512 * zoom + 100 * Math.sin(phase * Math.PI * 2),
          panY: 450 - 512 * zoom + 60 * Math.cos(phase * Math.PI * 2),
        });
        frame++;
        if (frame < 90) requestAnimationFrame(next);
        else void frames().then(resolve);
      };
      requestAnimationFrame(next);
    });
  },
  async runMazeFill() {
    floodFill(bitmap, { at: { x: 0, y: 0 }, color: INK }, history, fillWorkspace);
    await frames();
  },
};

Object.assign(window, { __pixelsPerf: api });
