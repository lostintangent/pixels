import { createBitmapDocument, packRgba } from '../../features/document';
import { createDocumentHistory } from '../../features/history';
import { beginSelection, beginStroke, FillWorkspace, floodFill } from '../../features/tools';
import type { PerfCase } from './harness';

const INK = packRgba(18, 111, 202);
const WALL = packRgba(25, 25, 25);

function strokeCase(size: number, targetP95Ms: number): PerfCase {
  const document = createBitmapDocument(`stroke-${size}`, 1024, 1024);
  const history = createDocumentHistory();
  return {
    name: `pencil ${size}px, 1000 segments, 1024²`,
    targetP95Ms,
    samples: 100,
    prepare() {},
    reset() {
      document.pixels.fill(0);
      history.clear();
    },
    run() {
      const stroke = beginStroke(document, { color: INK, size, pixelPerfect: size === 1 }, history);
      stroke.extend({ x: 10, y: 300 });
      for (let x = 11; x <= 1010; x++) stroke.extend({ x, y: 300 + ((x >> 3) & 1) });
      stroke.end();
    },
  };
}

function uniformFillCase(side: number, targetP95Ms: number): PerfCase {
  const document = createBitmapDocument(`fill-${side}`, side, side);
  const history = createDocumentHistory();
  const workspace = new FillWorkspace();
  return {
    name: `fill uniform ${side}²`,
    targetP95Ms,
    samples: side === 4096 ? 30 : 100,
    prepare() {},
    reset() {
      document.pixels.fill(0);
      history.clear();
    },
    run() {
      floodFill(document, { at: { x: 0, y: 0 }, color: INK }, history, workspace);
    },
  };
}

function mazeFillCase(): PerfCase {
  const side = 1024;
  const document = createBitmapDocument('maze', side, side);
  const base = new Uint32Array(side * side);
  for (let y = 8; y < side - 8; y += 8) {
    for (let x = 0; x < side; x++) {
      if ((y / 8) % 2 === 0 ? x < side - 1 : x > 0) base[y * side + x] = WALL;
    }
  }
  const history = createDocumentHistory();
  const workspace = new FillWorkspace();
  return {
    name: 'fill winding checker maze 1024²',
    targetP95Ms: 4.8,
    samples: 50,
    prepare() {},
    reset() {
      document.pixels.set(base);
      history.clear();
    },
    run() {
      floodFill(document, { at: { x: 0, y: 0 }, color: INK }, history, workspace);
    },
  };
}

function undoRedoCase(side: number, targetP95Ms: number): PerfCase {
  const document = createBitmapDocument(`undo-${side}`, side, side);
  const history = createDocumentHistory();
  return {
    name: `undo + redo full fill ${side}²`,
    targetP95Ms,
    samples: side === 4096 ? 50 : 100,
    batchSize: 1000,
    prepare() {
      history.clear();
      document.pixels.fill(0);
      floodFill(document, { at: { x: 0, y: 0 }, color: INK }, history);
    },
    reset() {},
    run() {
      history.undo(document);
      history.redo(document);
      return document.pixels[0] === INK ? 1 : 0;
    },
  };
}

function selectionMoveCase(): PerfCase {
  const document = createBitmapDocument('selection', 1024, 1024);
  const history = createDocumentHistory();
  const selection = beginSelection(document, history);
  let x = 0;
  return {
    name: 'selection move 512², one step',
    targetP95Ms: 0.000055,
    samples: 200,
    batchSize: 1000,
    prepare() {
      if (selection.floating) selection.cancel();
      selection.lift({ x: 0, y: 0, width: 512, height: 512 });
    },
    reset() {},
    run() {
      x ^= 1;
      selection.move({ x, y: 0 });
      return selection.floating!.bounds.x;
    },
  };
}

export const corePerfCases: PerfCase[] = [
  strokeCase(1, 0.25),
  strokeCase(16, 0.76),
  uniformFillCase(1024, 1.8),
  mazeFillCase(),
  uniformFillCase(4096, 25.8),
  undoRedoCase(1024, 0.00015),
  undoRedoCase(4096, 0.00015),
  selectionMoveCase(),
];
