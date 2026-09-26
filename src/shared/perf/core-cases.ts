import { createBitmapDocument, packRgba } from '../../features/document';
import { createDocumentHistory } from '../../features/history';
import { beginSelection, beginStroke, FillWorkspace, floodFill } from '../../features/tools';
import type { PerfCase } from './harness';

const INK = packRgba(18, 111, 202);
const WALL = packRgba(25, 25, 25);

function paintStroke(
  document: ReturnType<typeof createBitmapDocument>,
  history: ReturnType<typeof createDocumentHistory>,
  size: number,
): void {
  const stroke = beginStroke(document, { color: INK, size, pixelPerfect: size === 1 }, history);
  stroke.extend({ x: 10, y: 300 });
  for (let x = 11; x <= 1010; x++) stroke.extend({ x, y: 300 + ((x >> 3) & 1) });
  stroke.end();
}

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
      paintStroke(document, history, size);
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

function tileStrokeUndoRedoCase(): PerfCase {
  const document = createBitmapDocument('undo-stroke', 1024, 1024);
  const history = createDocumentHistory();
  return {
    name: 'undo + redo 16px stroke tiles 1024²',
    targetP95Ms: 0.18,
    samples: 100,
    prepare() {
      history.clear();
      document.pixels.fill(0);
      paintStroke(document, history, 16);
      if (history.usedBytes <= 0 || history.usedBytes >= document.pixels.byteLength)
        throw new Error('Stroke fixture must use tile history');
    },
    reset() {},
    run() {
      history.undo(document);
      history.redo(document);
    },
  };
}

function tileFillUndoRedoCase(): PerfCase {
  const side = 4096;
  const patch = 2048;
  const document = createBitmapDocument('undo-fill', side, side);
  const history = createDocumentHistory();
  const workspace = new FillWorkspace();
  return {
    name: 'undo + redo 2048² tile fill on 4096²',
    targetP95Ms: 13.5,
    samples: 30,
    prepare() {
      history.clear();
      document.pixels.fill(WALL);
      for (let y = 0; y < patch; y++) document.pixels.fill(0, y * side, y * side + patch);
      floodFill(document, { at: { x: 0, y: 0 }, color: INK }, history, workspace);
      if (history.usedBytes !== patch * patch * 4)
        throw new Error('Fill fixture must use tile history');
    },
    reset() {},
    run() {
      history.undo(document);
      history.redo(document);
    },
  };
}

function selectionGestureCase(): PerfCase {
  const document = createBitmapDocument('selection', 1024, 1024);
  const history = createDocumentHistory();
  return {
    name: 'selection lift + move + drop 512²',
    targetP95Ms: 0.95,
    samples: 100,
    prepare() {
      history.clear();
      document.pixels.fill(0);
      for (let y = 0; y < 512; y++)
        document.pixels.fill(INK, y * document.width, y * document.width + 512);
    },
    reset() {
      if (history.canUndo) history.undo(document);
      history.clear();
    },
    run() {
      const selection = beginSelection(document, history);
      selection.lift({ x: 0, y: 0, width: 512, height: 512 });
      selection.move({ x: 1, y: 0 });
      selection.commit();
    },
  };
}

export const corePerfCases: PerfCase[] = [
  strokeCase(1, 0.25),
  strokeCase(16, 0.76),
  uniformFillCase(1024, 1.8),
  mazeFillCase(),
  uniformFillCase(4096, 25.8),
  tileStrokeUndoRedoCase(),
  tileFillUndoRedoCase(),
  selectionGestureCase(),
];
