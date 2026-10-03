import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { annotationsFor } from '../../annotations';
import {
  attachAutosave,
  createDocumentStore,
  exportPng,
  importPng,
  loadDocument,
  saveDocument,
} from '../../files';
import { copySelection } from '../../tools';
import { DEFAULT_TOOL_PREFERENCES } from '../core/state';
import { createPixelClipboard } from './clipboard';
import { createEditorSession } from './session';

const A = packRgba(255, 0, 0);
const B = packRgba(0, 0, 255);

function input(x: number, y: number) {
  return { point: { x, y }, shift: false, alt: false };
}

test('session paste floats through a drag and commits as one undo step', () => {
  const document = createBitmapDocument('paste', 4, 1);
  document.pixels[0] = A;
  const clipboard = createPixelClipboard();
  clipboard.write(copySelection(document, { x: 0, y: 0, width: 1, height: 1 })!);
  const session = createEditorSession({ document, save: null, clipboard });
  session.setViewport({
    zoom: 1,
    panX: 0,
    panY: 0,
    cssWidth: 4,
    cssHeight: 1,
    devicePixelRatio: 1,
  });
  expect(session.state.state.hasClipboardPixels).toBe(true);
  session.run({ type: 'selection', action: 'paste' });
  expect(Array.from(document.pixels)).toEqual([A, 0, 0, 0]);
  session.beginGesture(input(0, 0));
  session.extendGesture([input(2, 0)]);
  session.endGesture();
  session.run({ type: 'selection', action: 'commit' });
  expect(Array.from(document.pixels)).toEqual([A, 0, A, 0]);
  session.run({ type: 'undo' });
  expect(Array.from(document.pixels)).toEqual([A, 0, 0, 0]);
  expect(session.state.state.canUndo).toBe(false);
});

test('resize shifts shapes with pixels and undoes as one document change', async () => {
  const document = createBitmapDocument('resize', 3, 3);
  document.pixels[4] = A;
  annotationsFor(document).commit({
    id: 'rect-1',
    kind: 'rectangle',
    start: { x: 0, y: 0 },
    end: { x: 2, y: 2 },
    color: B,
    width: 1,
  });
  const session = createEditorSession({ document, save: null });

  await session.resizeDocument(5, 5, 'center');
  const expanded = session.bitmap.state;
  expect(expanded).not.toBe(document);
  expect(expanded.pixels[2 * 5 + 2]).toBe(A);
  expect(annotationsFor(expanded).shapes[0]?.start).toEqual({ x: 1, y: 1 });
  expect(session.state.state.canUndo).toBe(true);

  session.run({ type: 'undo' });
  expect(session.bitmap.state).toBe(document);
  expect(document.pixels[4]).toBe(A);
  expect(annotationsFor(document).shapes[0]?.start).toEqual({ x: 0, y: 0 });
  expect(session.state.state.canRedo).toBe(true);

  session.run({ type: 'redo' });
  expect(session.bitmap.state).toBe(expanded);
  expect(annotationsFor(expanded).shapes[0]?.start).toEqual({ x: 1, y: 1 });
});

test('a Fill tap survives a cold tool import and remains one undo step', async () => {
  const document = createBitmapDocument('queued-fill', 3, 1);
  const session = createEditorSession({
    document,
    save: null,
    preferences: { ...DEFAULT_TOOL_PREFERENCES, primary: A },
  });
  session.run({ type: 'tool', tool: 'fill' });
  session.beginGesture(input(0, 0));
  session.endGesture();
  const fillDeadline = Date.now() + 2000;
  while (!session.state.state.canUndo && Date.now() < fillDeadline) await Bun.sleep(5);
  expect(Array.from(document.pixels)).toEqual([A, A, A]);
  session.run({ type: 'undo' });
  expect(Array.from(document.pixels)).toEqual([0, 0, 0]);
});

test('a queued Line drag commits its final point, while cancel discards it', async () => {
  const document = createBitmapDocument('queued-line', 4, 2);
  const session = createEditorSession({
    document,
    save: null,
    preferences: { ...DEFAULT_TOOL_PREFERENCES, primary: A },
  });
  session.run({ type: 'tool', tool: 'line' });
  session.beginGesture(input(0, 0));
  session.extendGesture([input(3, 0)]);
  session.endGesture();
  const lineDeadline = Date.now() + 2000;
  while (!session.state.state.canUndo && Date.now() < lineDeadline) await Bun.sleep(5);
  expect(Array.from(document.pixels.subarray(0, 4))).toEqual([A, A, A, A]);
  session.run({ type: 'undo' });
  expect(document.pixels.every((pixel) => pixel === 0)).toBe(true);

  const canceled = createBitmapDocument('canceled-line', 4, 2);
  const other = createEditorSession({
    document: canceled,
    save: null,
    preferences: { ...DEFAULT_TOOL_PREFERENCES, primary: A },
  });
  other.run({ type: 'tool', tool: 'line' });
  other.beginGesture(input(0, 1));
  other.extendGesture([input(3, 1)]);
  other.cancelGesture();
  await Bun.sleep(1);
  expect(canceled.pixels.every((pixel) => pixel === 0)).toBe(true);
  expect(other.state.state.canUndo).toBe(false);
});

test('duplicate floats in place without replacing the clipboard', () => {
  const document = createBitmapDocument('duplicate', 3, 1);
  document.pixels[0] = A;
  const other = createBitmapDocument('other', 1, 1);
  other.pixels[0] = B;
  const clipboard = createPixelClipboard();
  clipboard.write(copySelection(other, { x: 0, y: 0, width: 1, height: 1 })!);
  const token = clipboard.token;
  const session = createEditorSession({ document, save: null, clipboard });
  session.run({ type: 'selection', action: 'all' });
  session.run({ type: 'selection', action: 'duplicate' });
  expect(clipboard.token).toBe(token);
  expect(clipboard.read()!.pixels[0]).toBe(B);
  expect(Array.from(document.pixels)).toEqual([A, 0, 0]);
  session.beginGesture(input(0, 0));
  session.extendGesture([input(1, 0)]);
  session.endGesture();
  session.run({ type: 'selection', action: 'commit' });
  expect(Array.from(document.pixels)).toEqual([A, A, 0]);
  session.run({ type: 'undo' });
  expect(Array.from(document.pixels)).toEqual([A, 0, 0]);
});

function selectionSession(width: number) {
  const document = createBitmapDocument('select', width, 1);
  document.pixels[0] = A;
  document.pixels[1] = B;
  const session = createEditorSession({ document, save: null, clipboard: createPixelClipboard() });
  session.run({ type: 'tool', tool: 'select' });
  session.beginGesture(input(0, 0));
  session.extendGesture([input(1, 0)]);
  session.endGesture();
  return { document, session, undoSteps: () => countUndo(session) };
}

/** Undoes until nothing is left, then redoes it all, so the document ends where it began. */
function countUndo(session: ReturnType<typeof createEditorSession>): number {
  let steps = 0;
  while (session.state.state.canUndo) {
    session.run({ type: 'undo' });
    steps++;
  }
  for (let step = 0; step < steps; step++) session.run({ type: 'redo' });
  return steps;
}

test('a run of nudges floats the selection and commits as one undo step', () => {
  const { document, session, undoSteps } = selectionSession(16);
  session.run({ type: 'nudge', dx: 1, dy: 0 });
  // The float sits above an untouched document until it commits.
  expect(Array.from(document.pixels.subarray(0, 4))).toEqual([A, B, 0, 0]);
  session.run({ type: 'nudge', dx: 1, dy: 0 });
  session.run({ type: 'nudge', dx: 10, dy: 0 });
  session.run({ type: 'nudge', dx: -1, dy: 0 });
  expect(session.state.state.selection).toEqual({ x: 11, y: 0, width: 2, height: 1 });
  session.run({ type: 'selection', action: 'commit' });
  expect(document.pixels[11]).toBe(A);
  expect(document.pixels[12]).toBe(B);
  expect(document.pixels[0]).toBe(0);
  expect(undoSteps()).toBe(1);
  session.run({ type: 'undo' });
  expect(Array.from(document.pixels.subarray(0, 2))).toEqual([A, B]);
  expect(document.pixels.subarray(2).every((pixel) => pixel === 0)).toBe(true);
});

test('a tool change commits a nudge run, and Escape leaves the document byte-identical', () => {
  const committed = selectionSession(4);
  committed.session.run({ type: 'nudge', dx: 1, dy: 0 });
  committed.session.run({ type: 'nudge', dx: 1, dy: 0 });
  committed.session.run({ type: 'tool', tool: 'pencil' });
  expect(Array.from(committed.document.pixels)).toEqual([0, 0, A, B]);
  expect(committed.undoSteps()).toBe(1);

  const { document, session } = selectionSession(4);
  const before = document.pixels.slice();
  session.run({ type: 'nudge', dx: 1, dy: 0 });
  session.run({ type: 'selection', action: 'cancel' });
  expect(Array.from(document.pixels)).toEqual(Array.from(before));
  expect(session.state.state.selection).toBeNull();
  expect(session.state.state.canUndo).toBe(false);
});

test('a nudge waits out a pointer gesture and needs a selection', () => {
  const { document, session } = selectionSession(4);
  session.beginGesture(input(0, 0));
  expect(session.gesturing).toBe(true);
  session.run({ type: 'nudge', dx: 1, dy: 0 });
  session.endGesture();
  expect(session.gesturing).toBe(false);
  expect(session.state.state.selection).toEqual({ x: 0, y: 0, width: 2, height: 1 });
  session.run({ type: 'selection', action: 'cancel' });
  session.run({ type: 'nudge', dx: 1, dy: 0 });
  expect(session.state.state.selection).toBeNull();
  expect(Array.from(document.pixels)).toEqual([A, B, 0, 0]);
});

test('Option-drag inside a selection drags out a copy with the undo cost of Duplicate', () => {
  const { document, session, undoSteps } = selectionSession(6);
  session.beginGesture({ ...input(0, 0), alt: true });
  session.extendGesture([input(2, 0)]);
  session.endGesture();
  session.run({ type: 'selection', action: 'commit' });
  expect(Array.from(document.pixels)).toEqual([A, B, A, B, 0, 0]);
  expect(undoSteps()).toBe(1);

  // From a float, the copy first stamps the float where it is: two steps, like Duplicate.
  const floating = selectionSession(6);
  floating.session.run({ type: 'nudge', dx: 1, dy: 0 });
  floating.session.beginGesture({ ...input(1, 0), alt: true });
  floating.session.extendGesture([input(4, 0)]);
  floating.session.endGesture();
  floating.session.run({ type: 'selection', action: 'commit' });
  expect(Array.from(floating.document.pixels)).toEqual([0, A, B, 0, A, B]);
  expect(floating.undoSteps()).toBe(2);
});

test('Option-drag outside a selection starts a new marquee and never eyedrops', () => {
  const { document, session } = selectionSession(6);
  const primary = session.state.state.primary;
  session.beginGesture({ ...input(3, 0), alt: true });
  session.extendGesture([{ ...input(5, 0), alt: true }]);
  session.endGesture();
  expect(session.state.state.selection).toEqual({ x: 3, y: 0, width: 3, height: 1 });
  expect(session.state.state.primary).toBe(primary);
  expect(session.state.state.canUndo).toBe(false);
  expect(Array.from(document.pixels)).toEqual([A, B, 0, 0, 0, 0]);
});

test('paste stays at a visible origin and recenters when that origin is off screen', () => {
  const document = createBitmapDocument('placement', 10, 10);
  const source = createBitmapDocument('source', 10, 10);
  source.pixels[8 * 10 + 8] = A;
  const clipboard = createPixelClipboard();
  clipboard.write(copySelection(source, { x: 8, y: 8, width: 1, height: 1 })!);
  const session = createEditorSession({ document, save: null, clipboard });
  session.setViewport({
    zoom: 1,
    panX: 0,
    panY: 0,
    cssWidth: 10,
    cssHeight: 10,
    devicePixelRatio: 1,
  });
  session.run({ type: 'selection', action: 'paste' });
  expect(session.state.state.selection).toEqual({ x: 8, y: 8, width: 1, height: 1 });
  session.run({ type: 'selection', action: 'cancel' });
  session.setViewport({
    zoom: 1,
    panX: 0,
    panY: 0,
    cssWidth: 4,
    cssHeight: 4,
    devicePixelRatio: 1,
  });
  session.run({ type: 'selection', action: 'paste' });
  expect(session.state.state.selection).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  session.run({ type: 'selection', action: 'clear' });
  expect(document.pixels.every((pixel) => pixel === 0)).toBe(true);
  expect(session.state.state.canUndo).toBe(false);
});

test('lifted move leaves saved pixels intact and export commits the moved result', async () => {
  const document = createBitmapDocument('move', 3, 1);
  document.pixels.set([A, 0, B]);
  const before = document.rgbaBytes.slice();
  const session = createEditorSession({ document, save: null });
  session.run({ type: 'tool', tool: 'select' });
  session.run({ type: 'selection', action: 'all' });
  session.beginGesture(input(0, 0));
  session.extendGesture([input(1, 0)]);
  session.endGesture();
  expect(document.rgbaBytes).toEqual(before);
  expect(session.overlay.state.sourceClear).toEqual({ x: 0, y: 0, width: 3, height: 1 });
  expect(session.commitFloatingSelection()).toBe(true);
  expect(session.overlay.state.sourceClear).toBeNull();
  expect(Array.from(document.pixels)).toEqual([0, A, 0]);
  const png = await exportPng(session.bitmap.state);
  const exported = await importPng(new Blob([png as BlobPart]), 'export', 'export');
  expect(Array.from(exported.pixels)).toEqual([0, A, 0]);
  session.run({ type: 'undo' });
  expect(document.rgbaBytes).toEqual(before);
});

test('a move committed as the editor leaves reaches its final autosave flush', async () => {
  const store = createDocumentStore({ databaseName: 'session-leave-test-db' });
  const document = createBitmapDocument('leave', 3, 1);
  document.pixels[0] = A;
  await saveDocument(document, store);
  const autosave = attachAutosave(document, store, { debounceMs: 5000, maxWaitMs: 20000 });
  const session = createEditorSession({ document, save: 'saved' });
  session.run({ type: 'tool', tool: 'select' });
  session.run({ type: 'selection', action: 'all' });
  session.beginGesture(input(0, 0));
  session.extendGesture([input(1, 0)]);
  session.endGesture();

  // The same order as the editor's leave path: commit, then dispose, which flushes.
  session.commitFloatingSelection();
  autosave.dispose();

  const saved = await loadDocument(store, 'leave');
  expect(Array.from(saved!.pixels)).toEqual([0, A, 0]);
});

test('opening export commits a floating move before the preview snapshots pixels', () => {
  const document = createBitmapDocument('preview', 3, 1);
  document.pixels[0] = A;
  const session = createEditorSession({ document, save: null });
  session.run({ type: 'tool', tool: 'select' });
  session.run({ type: 'selection', action: 'all' });
  session.beginGesture(input(0, 0));
  session.extendGesture([input(1, 0)]);
  session.endGesture();
  expect(Array.from(document.pixels)).toEqual([A, 0, 0]);
  session.run({ type: 'open', panel: 'export' });
  expect(session.state.state.panel).toBe('export');
  expect(Array.from(document.pixels)).toEqual([0, A, 0]);
  expect(session.overlay.state.sourceClear).toBeNull();
  session.run({ type: 'undo' });
  expect(Array.from(document.pixels)).toEqual([A, 0, 0]);
});

test('painting adds its color to recents but erasing adds nothing', () => {
  const document = createBitmapDocument('recent', 2, 1);
  const preferences = { ...DEFAULT_TOOL_PREFERENCES, primary: A, recent: [] };
  const session = createEditorSession({ document, save: null, preferences });
  session.beginGesture(input(0, 0));
  session.endGesture();
  expect(session.state.state.recent).toEqual([A]);
  session.run({ type: 'tool', tool: 'eraser' });
  session.beginGesture(input(0, 0));
  session.endGesture();
  expect(Array.from(document.pixels)).toEqual([0, 0]);
  expect(session.state.state.recent).toEqual([A]);
});

test('a session opened with the grid off draws no grid', () => {
  const document = createBitmapDocument('grid', 4, 4);
  const preferences = { ...DEFAULT_TOOL_PREFERENCES, gridEnabled: false };
  const session = createEditorSession({ document, save: null, preferences });
  expect(session.overlay.state.grid).toBe('off');
  session.run({ type: 'toggle-grid' });
  expect(session.overlay.state.grid).toBe('auto');
});

test('an island measured after the first fit refits only an untouched view', () => {
  const document = createBitmapDocument('fit', 64, 64);
  const session = createEditorSession({ document, save: null });
  session.setViewportSize(820, 1180, 2);
  expect(session.viewport.state).toMatchObject({ zoom: 10, panX: 90, panY: 278 });

  const panel = { left: 434, top: 16, right: 804, bottom: 397 };
  session.setIslands([panel]);
  expect(session.viewport.state).toMatchObject({ zoom: 5, panX: 250, panY: 438 });

  session.setViewport({ ...session.viewport.state, panX: 10 });
  session.setIslands([]);
  expect(session.viewport.state).toMatchObject({ zoom: 5, panX: 10 });
  session.run({ type: 'zoom-fit' });
  expect(session.viewport.state).toMatchObject({ zoom: 10, panX: 90 });
});

test('an untouched fit refits on resize while a manually changed view keeps its zoom', () => {
  const document = createBitmapDocument('fit', 16, 16);
  const session = createEditorSession({ document, save: null });
  session.setLayout('phone');
  session.setViewportSize(390, 844, 3);
  expect(session.viewport.state.zoom).toBe(22);
  session.setViewportSize(360, 844, 3);
  expect(session.viewport.state.zoom).toBe(20);
  session.run({ type: 'zoom', direction: -1 });
  expect(session.viewport.state.zoom).toBe(16);
  session.setViewportSize(390, 844, 3);
  expect(session.viewport.state.zoom).toBe(16);
});

test('a touch eyedropper tracks the drag, then returns to the previous tool on lift', () => {
  const document = createBitmapDocument('pick', 2, 1);
  document.pixels.set([A, B]);
  const session = createEditorSession({ document, save: null });
  session.run({ type: 'tool', tool: 'fill' });
  session.run({ type: 'tool', tool: 'eyedropper' });
  session.beginGesture(input(0, 0), 'touch');
  expect(session.state.state.primary).toBe(A);
  session.extendGesture([input(1, 0)]);
  expect(session.state.state.primary).toBe(B);
  expect(session.state.state.tool).toBe('eyedropper');
  session.endGesture();
  expect(session.state.state).toMatchObject({ primary: B, tool: 'fill' });
});

test('a mouse eyedropper stays active after a pick', () => {
  const document = createBitmapDocument('pick', 1, 1);
  document.pixels[0] = A;
  const session = createEditorSession({ document, save: null });
  session.run({ type: 'tool', tool: 'eyedropper' });
  session.beginGesture(input(0, 0));
  session.endGesture();
  expect(session.state.state).toMatchObject({ primary: A, tool: 'eyedropper' });
});

test('a touch pick that turns into a pinch keeps the tool and the earlier color', () => {
  const document = createBitmapDocument('pick', 1, 1);
  document.pixels[0] = A;
  const session = createEditorSession({ document, save: null });
  const before = session.state.state.primary;
  session.run({ type: 'tool', tool: 'eyedropper' });
  session.beginGesture(input(0, 0), 'touch');
  expect(session.state.state.primary).toBe(A);
  session.cancelGesture();
  expect(session.state.state).toMatchObject({ primary: before, tool: 'eyedropper' });
});

test('the brush cursor follows keyboard size and tool changes without a pointer move', () => {
  const document = createBitmapDocument('cursor', 16, 16);
  const preferences = { ...DEFAULT_TOOL_PREFERENCES, tool: 'pencil' as const, brushSize: 1 };
  const session = createEditorSession({ document, save: null, preferences });
  const cursor = () => session.overlay.state.cursor;
  session.hover({ x: 8.5, y: 8.5 });
  expect(cursor()).toEqual({ x: 8, y: 8, width: 1, height: 1 });

  session.setBrushSize(5);
  expect(cursor()).toEqual({ x: 6, y: 6, width: 5, height: 5 });
  session.run({ type: 'brush-size', direction: 1 });
  const stepped = session.state.state.brushSize;
  expect(stepped).toBeGreaterThan(5);
  expect(cursor()).toMatchObject({ width: stepped, height: stepped });

  session.run({ type: 'tool', tool: 'eyedropper' });
  expect(cursor()).toEqual({ x: 8, y: 8, width: 1, height: 1 });
  session.run({ type: 'tool', tool: 'eraser' });
  expect(cursor()).toMatchObject({ width: stepped, height: stepped });
  session.run({ type: 'tool', tool: 'select' });
  expect(cursor()).toBeNull();
  session.run({ type: 'tool', tool: 'pencil' });
  expect(cursor()).toMatchObject({ width: stepped });
  session.run({ type: 'shape-tool', kind: 'arrow' });
  expect(cursor()).toBeNull();

  session.run({ type: 'tool', tool: 'pencil' });
  session.hover(null);
  expect(cursor()).toBeNull();
  session.setBrushSize(3);
  expect(cursor()).toBeNull();
});

test('keyboard zoom holds the hovered pixel still, and the center without a pointer', () => {
  const document = createBitmapDocument('anchor', 64, 64);
  const session = createEditorSession({ document, save: null });
  const view = { zoom: 4, panX: 0, panY: 0, cssWidth: 400, cssHeight: 300, devicePixelRatio: 1 };
  session.setViewport(view);
  const screenOf = (point: { x: number; y: number }) => {
    const { zoom, panX, panY } = session.viewport.state;
    return { x: point.x * zoom + panX, y: point.y * zoom + panY };
  };

  session.hover({ x: 10.25, y: 20.5 });
  const under = screenOf({ x: 10.25, y: 20.5 });
  session.run({ type: 'zoom', direction: 1 });
  expect(session.viewport.state.zoom).toBeGreaterThan(4);
  expect(screenOf({ x: 10.25, y: 20.5 })).toEqual(under);
  session.run({ type: 'zoom-actual' });
  expect(session.viewport.state.zoom).toBe(1);
  expect(screenOf({ x: 10.25, y: 20.5 })).toEqual(under);

  session.hover(null);
  session.setViewport(view);
  const middle = session.viewport.state;
  session.run({ type: 'zoom', direction: -1 });
  expect(session.viewport.state.zoom).toBeLessThan(middle.zoom);
  expect(session.viewport.state).not.toMatchObject({ panX: 0, panY: 0 });
});

test('a rename is not history, and undoing a resize keeps the new name', async () => {
  const document = createBitmapDocument('rename', 3, 3, 'Untitled');
  const session = createEditorSession({ document, save: null });
  session.beginGesture(input(1, 1));
  session.endGesture();
  const pixels = document.pixels.slice();

  session.rename('Hero');
  expect(document.name).toBe('Hero');
  expect(session.state.state.document).toEqual({ name: 'Hero', width: 3, height: 3 });
  expect(document.pixels).toEqual(pixels);

  await session.resizeDocument(5, 5, 'center');
  session.rename('Hero big');
  session.run({ type: 'undo' });
  expect(session.bitmap.state).toBe(document);
  expect(document.name).toBe('Hero big');
  expect(session.state.state.document).toEqual({ name: 'Hero big', width: 3, height: 3 });

  // The stroke is the next undo step. The name stays.
  session.run({ type: 'undo' });
  expect(session.state.state.document.name).toBe('Hero big');
  session.run({ type: 'redo' });
  session.run({ type: 'redo' });
  expect(session.bitmap.state.name).toBe('Hero big');
  expect(session.state.state.document.name).toBe('Hero big');
});
