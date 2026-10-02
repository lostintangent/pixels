import { createStore } from '@tanstack/store';
import type { Store } from '@tanstack/store';
import { screenToDocument, stepZoom, zoomToStep } from '../../canvas/model';
import type {
  OverlayPreview,
  OverlayState,
  PointerKind,
  ScreenPoint,
  Viewport,
  ViewportInsets,
} from '../../canvas/model';
import { convertPixelColorSpace, getPixel, intersectRect, resizeDocument } from '../../document';
import type {
  BitmapDocument,
  CanvasAnchor,
  PackedColor,
  PixelPoint,
  PixelRect,
} from '../../document';
import { createDocumentHistory } from '../../history';
import { alpha, TRANSPARENT } from '../../palette/model';
import {
  beginLinePreview,
  LinePreviewWorkspace,
  beginSelection,
  beginStroke,
  copySelection,
  FillWorkspace,
  floodFill,
} from '../../tools';
import type { FloatingSelection, LinePreview, SelectionSession, StrokeSession } from '../../tools';
import { fitAroundIslands, frameCenter } from '../core/fit';
import type { IslandRect } from '../core/fit';
import { SHAPES_IN_RAIL, usesBrush } from '../core/tools';
import type { EditorCommand, SelectionAction } from '../core/shortcuts';
import {
  chooseColor,
  finishPick,
  initialEditorState,
  openPanel,
  recordPaintedColor,
  selectShape,
  selectTool,
  stepBrush,
  swapColors,
} from '../core/state';
import type {
  ColorSlot,
  EditorPanel,
  EditorState,
  SaveStatus,
  ToolPreferences,
} from '../core/state';
import { appClipboard } from './clipboard';
import type { PixelClipboard } from './clipboard';

/** Modifier state for one canvas gesture sample. */
export interface GestureInput {
  /** Fractional document coordinates. */
  point: PixelPoint;
  shift: boolean;
  alt: boolean;
}

export type Layout = 'desktop' | 'phone';

/**
 * The margin chrome always takes, mirrored left and right so a fit lands truly centered. Islands
 * that only sometimes collide with the document, like the desktop color panel, are reported
 * separately and cleared only when they would overlap.
 */
const FRAMES: Record<Layout, ViewportInsets> = {
  desktop: { top: 72, right: 76, bottom: 56, left: 76 },
  phone: { top: 72, right: 16, bottom: 148, left: 16 },
};

type Gesture =
  /** `recent` is what the stroke adds to recent colors. Erasing adds nothing. */
  | { kind: 'stroke'; session: StrokeSession; last: PixelPoint; recent: PackedColor | null }
  | { kind: 'line'; preview: LinePreview; color: PackedColor }
  | { kind: 'marquee'; anchor: PixelPoint }
  | { kind: 'move'; grab: PixelPoint }
  | { kind: 'pick'; pointer: PointerKind; before: PackedColor }
  // A fill lands on press, so the rest of the gesture only waits for the lift.
  | { kind: 'fill' };

export interface EditorSession {
  readonly state: Store<EditorState>;
  readonly bitmap: Store<BitmapDocument>;
  readonly viewport: Store<Viewport>;
  readonly overlay: Store<OverlayState>;
  /** Document pixel under the pointer, or null when outside the canvas. */
  readonly pointer: Store<PixelPoint | null>;
  /** True from a canvas gesture's press until its lift or cancel. */
  readonly gesturing: boolean;
  /** Commits a floating selection before a document snapshot such as PNG export. */
  commitFloatingSelection(): boolean;
  run(command: EditorCommand): void;
  chooseColor(color: PackedColor, slot: ColorSlot): void;
  setBrushSize(size: number): void;
  setShapeWidth(width: number): void;
  /** Opens a dialog or sheet, or closes whichever is open. */
  setPanel(panel: EditorPanel | null): void;
  /** Checker and grid colors follow the resolved color scheme. */
  setCanvasColors(colors: NonNullable<OverlayState['colors']>): void;
  setLayout(layout: Layout): void;
  /** Floating chrome a fit should keep the document out from under, in canvas CSS pixels. */
  setIslands(islands: readonly IslandRect[]): void;
  setViewportSize(width: number, height: number, devicePixelRatio: number): void;
  setViewport(viewport: Viewport): void;
  setSaveStatus(status: SaveStatus): void;
  /** Pastes outside pixels centered on the canvas as a selection. False when they don't fit. */
  place(image: Pick<BitmapDocument, 'width' | 'height' | 'pixels' | 'colorSpace'>): boolean;
  resizeDocument(width: number, height: number, anchor: CanvasAnchor): void;
  toDocument(point: ScreenPoint): PixelPoint;
  /** Alt previews the temporary eyedropper's single pixel instead of the brush. */
  hover(point: PixelPoint | null, alt?: boolean): void;
  /** A mouse unless told otherwise. Touch and pen make an eyedropper pick one-shot. */
  beginGesture(input: GestureInput, pointer?: PointerKind): void;
  extendGesture(inputs: readonly GestureInput[]): void;
  endGesture(): void;
  /** Rolls the gesture back as if it never happened, for a touch that turns into a pinch. */
  cancelGesture(): void;
}

export interface EditorSessionOptions {
  document: BitmapDocument;
  /** Null for a document that has never been saved or edited. */
  save: SaveStatus | null;
  clipboard?: PixelClipboard;
  /** Carried over from the previous document. */
  preferences?: ToolPreferences;
}

export function createEditorSession({
  document: initial,
  save,
  clipboard = appClipboard,
  preferences,
}: EditorSessionOptions): EditorSession {
  const history = createDocumentHistory();
  const fillWorkspace = new FillWorkspace();
  const lineWorkspace = new LinePreviewWorkspace();
  const scratchRect: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
  const state = createStore({
    ...initialEditorState(
      { name: initial.name, width: initial.width, height: initial.height },
      save,
      preferences,
    ),
    hasClipboardPixels: clipboard.read() !== null,
  });
  const bitmap = createStore(initial);
  const viewport = createStore<Viewport>({
    zoom: 1,
    panX: 0,
    panY: 0,
    cssWidth: 0,
    cssHeight: 0,
    devicePixelRatio: 1,
  });
  const overlay = createStore<OverlayState>({
    grid: state.state.gridEnabled ? 'auto' : 'off',
    cursor: null,
    marquee: null,
    preview: null,
    sourceClear: null,
  });
  const pointer = createStore<PixelPoint | null>(null);

  let layout: Layout = 'desktop';
  let islands: readonly IslandRect[] = [];
  let fitted = false;
  // The view a fit produced, so a later island measurement can tell nobody has panned since.
  let lastFit: Viewport | null = null;
  let refitOnResize = false;
  let gesture: Gesture | null = null;
  let selection: SelectionSession = beginSelection(initial, history);

  const update = (transition: (current: EditorState) => EditorState) => state.setState(transition);
  const setOverlay = (patch: Partial<OverlayState>) =>
    overlay.setState((current) => ({ ...current, ...patch }));
  const document = () => bitmap.state;
  const documentRect = (): PixelRect => ({
    x: 0,
    y: 0,
    width: document().width,
    height: document().height,
  });

  function syncHistory(): void {
    update((current) =>
      current.canUndo === history.canUndo && current.canRedo === history.canRedo
        ? current
        : { ...current, canUndo: history.canUndo, canRedo: history.canRedo },
    );
  }

  function setSelection(rect: PixelRect | null): void {
    update((current) => (current.selection === rect ? current : { ...current, selection: rect }));
    const floating = selection.floating;
    setOverlay({
      marquee: rect,
      preview: floating ? { pixels: floating.pixels, bounds: floating.bounds } : null,
      sourceClear: selection.sourceToClear,
    });
  }

  function fit(): void {
    const view = viewport.state;
    if (!view.cssWidth || !view.cssHeight) return;
    const next = fitAroundIslands(
      view,
      document().width,
      document().height,
      FRAMES[layout],
      islands,
    );
    viewport.setState(() => ({
      ...next,
      panX: Math.round(next.panX),
      panY: Math.round(next.panY),
    }));
    fitted = true;
    lastFit = viewport.state;
  }

  function center(): ScreenPoint {
    return frameCenter(viewport.state, FRAMES[layout]);
  }

  function replaceDocument(next: BitmapDocument): void {
    commitFloating();
    history.clear();
    selection = beginSelection(next, history);
    bitmap.setState(() => next);
    setSelection(null);
    update((current) => ({
      ...current,
      document: { name: next.name, width: next.width, height: next.height },
      panel: null,
    }));
    syncHistory();
    fit();
  }

  function footprint(point: PixelPoint, picking = false): PixelRect {
    const { tool, brushSize } = state.state;
    const size = usesBrush(tool) && !picking ? brushSize : 1;
    const before = Math.floor((size - 1) / 2);
    return { x: point.x - before, y: point.y - before, width: size, height: size };
  }

  function contains(rect: PixelRect, point: PixelPoint): boolean {
    return (
      point.x >= rect.x &&
      point.y >= rect.y &&
      point.x < rect.x + rect.width &&
      point.y < rect.y + rect.height
    );
  }

  function marqueeRect(anchor: PixelPoint, point: PixelPoint): PixelRect {
    const { width, height } = document();
    const x0 = Math.max(0, Math.min(anchor.x, point.x));
    const y0 = Math.max(0, Math.min(anchor.y, point.y));
    const x1 = Math.min(width, Math.max(anchor.x, point.x) + 1);
    const y1 = Math.min(height, Math.max(anchor.y, point.y) + 1);
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }

  function commitFloating(): boolean {
    if (!selection.floating) return false;
    const committed = selection.commit();
    setSelection(null);
    syncHistory();
    return committed;
  }

  function pickColor(point: PixelPoint): void {
    const color = getPixel(document(), point);
    if (color === null || alpha(color) === 0) return;
    update((current) => chooseColor(current, color, 'primary'));
  }

  function runSelection(action: SelectionAction): void {
    const rect = state.state.selection;
    switch (action) {
      case 'all':
        commitFloating();
        setSelection(documentRect());
        return;
      case 'commit':
        commitFloating();
        setSelection(null);
        return;
      case 'cancel':
        if (selection.floating) selection.cancel();
        syncHistory();
        setSelection(null);
        return;
      case 'clear':
        if (!rect) return;
        if (!selection.floating) selection.lift(rect);
        selection.clear();
        syncHistory();
        setSelection(null);
        return;
      case 'copy':
      case 'cut': {
        if (!rect) return;
        const floating = selection.floating;
        const copied = floating
          ? {
              bounds: { ...floating.bounds },
              sourceBounds: { ...floating.bounds },
              pixels: floating.pixels.slice(),
              colorSpace: floating.colorSpace,
            }
          : copySelection(document(), rect);
        if (copied) {
          clipboard.write(copied);
          update((current) => ({ ...current, hasClipboardPixels: true }));
        }
        if (action === 'cut') runSelection('clear');
        return;
      }
      case 'paste': {
        const copied = clipboard.read();
        if (copied) paste(copied, pasteOrigin(copied));
        return;
      }
      case 'duplicate': {
        if (!rect) return;
        const floating = selection.floating;
        const copied = floating
          ? {
              bounds: { ...floating.bounds },
              sourceBounds: { ...floating.bounds },
              pixels: floating.pixels.slice(),
              colorSpace: floating.colorSpace,
            }
          : copySelection(document(), rect);
        if (copied) paste(copied, { x: copied.bounds.x, y: copied.bounds.y });
        return;
      }
    }
  }

  /** Lifts like a drag, so a run of nudges stays one float and commits as one undo step. */
  function nudge(dx: number, dy: number): void {
    const rect = state.state.selection;
    if (gesture || !rect) return;
    const floating = selection.floating ?? selection.lift(rect);
    if (!floating) return;
    selection.move({ x: floating.bounds.x + dx, y: floating.bounds.y + dy });
    update((current) => selectTool(current, 'select'));
    setSelection({ ...floating.bounds });
  }

  function pasteOrigin(pixels: FloatingSelection): PixelPoint {
    const bounds = pixels.bounds;
    const bitmap = document();
    const view = viewport.state;
    const fitsDocument =
      bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= bitmap.width &&
      bounds.y + bounds.height <= bitmap.height;
    const left = view.panX + bounds.x * view.zoom;
    const top = view.panY + bounds.y * view.zoom;
    const fullyVisible =
      view.cssWidth > 0 &&
      view.cssHeight > 0 &&
      left >= 0 &&
      top >= 0 &&
      left + bounds.width * view.zoom <= view.cssWidth &&
      top + bounds.height * view.zoom <= view.cssHeight;
    if (fitsDocument && fullyVisible) return { x: bounds.x, y: bounds.y };
    const visibleLeft = Math.max(0, -view.panX / view.zoom);
    const visibleTop = Math.max(0, -view.panY / view.zoom);
    const visibleRight = Math.min(bitmap.width, (view.cssWidth - view.panX) / view.zoom);
    const visibleBottom = Math.min(bitmap.height, (view.cssHeight - view.panY) / view.zoom);
    const centerX =
      visibleRight > visibleLeft ? (visibleLeft + visibleRight) / 2 : bitmap.width / 2;
    const centerY =
      visibleBottom > visibleTop ? (visibleTop + visibleBottom) / 2 : bitmap.height / 2;
    return {
      x: Math.max(0, Math.min(Math.floor(centerX - bounds.width / 2), bitmap.width - bounds.width)),
      y: Math.max(
        0,
        Math.min(Math.floor(centerY - bounds.height / 2), bitmap.height - bounds.height),
      ),
    };
  }

  function paste(pixels: FloatingSelection, at: PixelPoint): boolean {
    commitFloating();
    const converted: FloatingSelection =
      pixels.colorSpace === document().colorSpace
        ? pixels
        : {
            ...pixels,
            pixels: convertPixelColorSpace(
              pixels.pixels,
              pixels.bounds.width,
              pixels.bounds.height,
              pixels.colorSpace,
              document().colorSpace,
            ),
            colorSpace: document().colorSpace,
          };
    if (!selection.paste(converted, at)) return false;
    update((current) => selectTool(current, 'select'));
    setSelection({ ...at, width: pixels.bounds.width, height: pixels.bounds.height });
    return true;
  }

  function zoomBy(direction: -1 | 1, anchor = center()): void {
    viewport.setState((view) => stepZoom(view, direction, anchor));
  }

  const session: EditorSession = {
    state,
    bitmap,
    viewport,
    overlay,
    pointer,
    get gesturing() {
      return gesture !== null;
    },
    commitFloatingSelection: commitFloating,

    run(command) {
      switch (command.type) {
        case 'tool':
          if (command.tool !== 'select') commitFloating();
          update((current) => selectTool(current, command.tool));
          return;
        case 'shape-tool':
          if (!SHAPES_IN_RAIL) return;
          commitFloating();
          update((current) => selectShape(current, command.kind));
          return;
        case 'swap-colors':
          update(swapColors);
          return;
        case 'brush-size':
          update((current) => stepBrush(current, command.direction));
          return;
        case 'undo':
        case 'redo':
          if (gesture) return;
          commitFloating();
          if (command.type === 'undo') history.undo(document());
          else history.redo(document());
          setSelection(null);
          syncHistory();
          return;
        case 'zoom':
          zoomBy(command.direction);
          return;
        case 'zoom-fit':
          fit();
          return;
        case 'zoom-actual':
          viewport.setState((view) => zoomToStep(view, 1, center()));
          return;
        case 'toggle-grid':
          update((current) => ({ ...current, gridEnabled: !current.gridEnabled }));
          setOverlay({ grid: state.state.gridEnabled ? 'auto' : 'off' });
          return;
        case 'toggle-chrome':
          update((current) => ({ ...current, chromeHidden: !current.chromeHidden }));
          return;
        case 'open':
          if (command.panel === 'export') commitFloating();
          update((current) => openPanel(current, command.panel));
          return;
        case 'open-file':
          // File pickers need the DOM, so the shell handles this one before it reaches here.
          return;
        case 'selection':
          runSelection(command.action);
          return;
        case 'nudge':
          nudge(command.dx, command.dy);
          return;
      }
    },

    chooseColor(color, slot) {
      update((current) => chooseColor(current, color, slot));
    },

    setPanel(panel) {
      update((current) => openPanel(current, panel));
    },

    setCanvasColors(colors) {
      setOverlay({ colors });
    },

    setBrushSize(size) {
      update((current) => (current.brushSize === size ? current : { ...current, brushSize: size }));
    },

    setShapeWidth(width) {
      update((current) =>
        current.shapeWidth === width ? current : { ...current, shapeWidth: width },
      );
    },

    setLayout(next) {
      if (layout === next) return;
      layout = next;
      // The layout flips with the window, before the canvas reports its new size.
      refitOnResize = true;
      fit();
    },

    setIslands(next) {
      const untouched = fitted && viewport.state === lastFit;
      islands = next;
      // Islands measure after the first fit can run. Redo it unless the artist has moved since.
      if (untouched) fit();
    },

    setViewportSize(width, height, devicePixelRatio) {
      const view = viewport.state;
      if (
        view.cssWidth === width &&
        view.cssHeight === height &&
        view.devicePixelRatio === devicePixelRatio
      )
        return;
      const untouchedFit = fitted && view === lastFit;
      // Keep the canvas anchored to its center while the window resizes.
      const dx = view.cssWidth ? (width - view.cssWidth) / 2 : 0;
      const dy = view.cssHeight ? (height - view.cssHeight) / 2 : 0;
      viewport.setState(() => ({
        ...view,
        cssWidth: width,
        cssHeight: height,
        devicePixelRatio,
        panX: Math.round(view.panX + dx),
        panY: Math.round(view.panY + dy),
      }));
      if (!fitted || refitOnResize || untouchedFit) {
        refitOnResize = false;
        fit();
      }
    },

    setViewport(next) {
      viewport.setState(() => next);
    },

    setSaveStatus(status) {
      update((current) => (current.save === status ? current : { ...current, save: status }));
    },

    place(image) {
      const { width, height } = document();
      if (image.width > width || image.height > height) return false;
      const at = {
        x: Math.floor((width - image.width) / 2),
        y: Math.floor((height - image.height) / 2),
      };
      const bounds = { ...at, width: image.width, height: image.height };
      return paste(
        { bounds, sourceBounds: bounds, pixels: image.pixels, colorSpace: image.colorSpace },
        at,
      );
    },

    resizeDocument(width, height, anchor) {
      commitFloating();
      replaceDocument(resizeDocument(document(), width, height, anchor));
    },

    toDocument(point) {
      return screenToDocument(viewport.state, point);
    },

    hover(point, alt = false) {
      const cell = point && { x: Math.floor(point.x), y: Math.floor(point.y) };
      const inside = cell && contains(documentRect(), cell) ? cell : null;
      const previous = pointer.state;
      if (previous?.x !== inside?.x || previous?.y !== inside?.y) pointer.setState(() => inside);
      const { tool } = state.state;
      // A brush previews its full footprint while any part of it can still paint.
      const cursor = cell && tool !== 'select' && tool !== 'shapes' ? footprint(cell, alt) : null;
      const paints = cursor && intersectRect(cursor, documentRect(), scratchRect);
      setOverlay({ cursor: paints ? cursor : null });
    },

    beginGesture({ point, alt }, pointer = 'mouse') {
      if (gesture) return;
      const cell = { x: Math.floor(point.x), y: Math.floor(point.y) };
      const { tool, brushSize, primary } = state.state;
      if (tool === 'eyedropper' || (alt && tool !== 'select' && tool !== 'shapes')) {
        gesture = { kind: 'pick', pointer, before: primary };
        pickColor(cell);
        return;
      }
      if (tool === 'select') {
        const rect = state.state.selection;
        if (rect && contains(selection.floating?.bounds ?? rect, cell)) {
          // Option drags out a copy: the same float and undo steps as Duplicate, then a move.
          if (alt) runSelection('duplicate');
          const lifted = selection.floating ?? selection.lift(rect);
          if (!lifted) return;
          gesture = {
            kind: 'move',
            grab: { x: cell.x - lifted.bounds.x, y: cell.y - lifted.bounds.y },
          };
          setSelection({ ...lifted.bounds });
          return;
        }
        commitFloating();
        gesture = { kind: 'marquee', anchor: cell };
        setSelection(marqueeRect(cell, cell));
        return;
      }
      if (tool === 'shapes') return;
      commitFloating();
      if (selection.floating === null && state.state.selection) setSelection(null);
      const color = tool === 'eraser' ? TRANSPARENT : primary;
      if (tool === 'fill') {
        if (!contains(documentRect(), cell)) return;
        if (floodFill(document(), { at: cell, color }, history, fillWorkspace).dirty) {
          update((current) => recordPaintedColor(current, color));
          syncHistory();
        }
        gesture = { kind: 'fill' };
        return;
      }
      const brush = { color, size: brushSize, pixelPerfect: brushSize === 1 };
      if (tool === 'line') {
        const preview = beginLinePreview(document(), cell, brush, history, lineWorkspace);
        const dirty = preview.update(cell);
        gesture = { kind: 'line', preview, color };
        setOverlay({ preview: linePreview(preview, dirty) });
        return;
      }
      const stroke = beginStroke(document(), brush, history);
      stroke.extend(cell);
      gesture = {
        kind: 'stroke',
        session: stroke,
        last: cell,
        recent: tool === 'eraser' ? null : color,
      };
    },

    extendGesture(inputs) {
      const current = gesture;
      if (!current || inputs.length === 0) return;
      const latest = inputs[inputs.length - 1]!;
      const cell = { x: Math.floor(latest.point.x), y: Math.floor(latest.point.y) };
      switch (current.kind) {
        case 'stroke':
          for (const input of inputs) {
            const sample = { x: Math.floor(input.point.x), y: Math.floor(input.point.y) };
            if (sample.x === current.last.x && sample.y === current.last.y) continue;
            current.session.extend(sample);
            current.last = sample;
          }
          return;
        case 'line': {
          const dirty = current.preview.update(cell, latest.shift);
          setOverlay({ preview: linePreview(current.preview, dirty) });
          return;
        }
        case 'marquee':
          setSelection(marqueeRect(current.anchor, cell));
          return;
        case 'move': {
          selection.move({ x: cell.x - current.grab.x, y: cell.y - current.grab.y });
          const floating = selection.floating;
          if (floating) setSelection({ ...floating.bounds });
          return;
        }
        case 'pick':
          if (state.state.tool === 'eyedropper') pickColor(cell);
          return;
        case 'fill':
          return;
      }
    },

    endGesture() {
      const current = gesture;
      gesture = null;
      if (!current) return;
      switch (current.kind) {
        case 'stroke': {
          const { recent } = current;
          if (current.session.end() && recent !== null)
            update((s) => recordPaintedColor(s, recent));
          break;
        }
        case 'line':
          if (current.preview.commit()) update((s) => recordPaintedColor(s, current.color));
          setOverlay({ preview: null });
          break;
        case 'marquee': {
          const rect = state.state.selection;
          // A click without a drag deselects.
          if (rect && rect.width * rect.height <= 1) setSelection(null);
          break;
        }
        case 'pick':
          update((s) => finishPick(s, current.pointer));
          break;
        case 'move':
        case 'fill':
          break;
      }
      syncHistory();
    },

    cancelGesture() {
      const current = gesture;
      gesture = null;
      if (!current) return;
      switch (current.kind) {
        case 'stroke':
          current.session.cancel();
          break;
        case 'line':
          current.preview.cancel();
          setOverlay({ preview: null });
          break;
        case 'marquee':
          setSelection(null);
          break;
        case 'pick': {
          // A touch that becomes a pinch shouldn't leave its first finger's color behind.
          const { before } = current;
          update((s) => chooseColor(s, before, 'primary'));
          break;
        }
        case 'move':
        case 'fill':
          break;
      }
      syncHistory();
    },
  };

  return session;
}

/** Line previews are compact buffers over their own bounds. */
function linePreview(preview: LinePreview, dirty: PixelRect | null): OverlayPreview | null {
  if (!preview.bounds) return null;
  return { pixels: preview.overlay, bounds: preview.bounds, dirty: dirty ?? undefined };
}
