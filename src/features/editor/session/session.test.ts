import { expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { exportPng, importPng } from '../../files';
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
  expect(session.viewport.state).toMatchObject({ zoom: 6, panX: 218, panY: 406 });

  session.setViewport({ ...session.viewport.state, panX: 10 });
  session.setIslands([]);
  expect(session.viewport.state).toMatchObject({ zoom: 6, panX: 10 });
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
