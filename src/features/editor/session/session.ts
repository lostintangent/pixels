import { createStore } from '@tanstack/store';
import type { Store } from '@tanstack/store';
import {
  boundView,
  documentToScreen,
  screenToDocument,
  stepZoom,
  zoomToStep,
} from '../../canvas/model';
import { findAnnotationsFor } from '../../annotations/model';
import type {
  DocumentPoint,
  OverlayPreview,
  OverlayState,
  PointerKind,
  ScreenPoint,
  ViewBounds,
  Viewport,
  ViewportInsets,
} from '../../canvas/model';
import { convertPixelColorSpace, getPixel, intersectRect } from '../../document';
import type {
  BitmapDocument,
  CanvasAnchor,
  PackedColor,
  PixelPoint,
  PixelRect,
} from '../../document';
import { createDocumentHistory } from '../../history';
import { alpha, TRANSPARENT } from '../../palette/model';
import { beginSelection, beginStroke, copySelection } from '../../tools/model';
import type {
  Brush,
  FloatingSelection,
  LinePreview,
  SelectionSession,
  StrokeSession,
} from '../../tools/model';
import { boundsFor, fitAroundIslands, frameCenter } from '../core/fit';
import type { IslandRect } from '../core/fit';
import { usesBrush } from '../core/tools';
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
import type { ShapeController } from './shapes';
import type { PaintExtras } from './paintExtras';

let paintModule: Promise<typeof import('./paintExtras')> | null = null;

function importPaintExtras(): Promise<typeof import('./paintExtras')> {
  paintModule ??= import('./paintExtras');
  return paintModule;
}

/** Idle prefetch keeps the first Fill or Line gesture instant without adding to initial JS. */
export function preloadPaintExtras(): void {
  void importPaintExtras();
}

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
  | { kind: 'fill' }
  | { kind: 'shape'; shapes: ShapeController }
  /** A Shapes press that landed before the controller loaded. It replays once the module arrives. */
  | { kind: 'shape-queued'; press: QueuedPress }
  | { kind: 'paint-queued'; press: QueuedPaint };

interface QueuedPress {
  input: GestureInput;
  touch: boolean;
  latest: GestureInput | null;
  ended: boolean;
}

interface QueuedPaint {
  tool: 'fill' | 'line';
  document: BitmapDocument;
  at: PixelPoint;
  latest: PixelPoint;
  shift: boolean;
  color: PackedColor;
  brush: Brush;
  ended: boolean;
}

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
  /**
   * Commits a shape nudge or restyle still inside its debounce window, without touching a
   * floating selection. For an exit signal (pagehide, app switch) that must not lose an edit the
   * artist already made, but also must not silently finish an in-progress paste move the way
   * leaving for another document does.
   */
  flushPendingEdits(): void;
  run(command: EditorCommand): void;
  chooseColor(color: PackedColor, slot: ColorSlot): void;
  setBrushSize(size: number): void;
  setShapeWidth(width: number): void;
  /** Opens a dialog or sheet, or closes whichever is open. */
  setPanel(panel: EditorPanel | null): void;
  /** Checker and grid colors follow the resolved color scheme. */
  setCanvasColors(colors: NonNullable<OverlayState['colors']>): void;
  /** A manually changed view survives the switch. Only an untouched fit refits. */
  setLayout(layout: Layout): void;
  /**
   * The canvas the chrome leaves clear for a fit, measured by a layout whose chrome moves, such as
   * a phone turning sideways. Null falls back to the layout's fixed frame.
   */
  setFrame(frame: ViewportInsets | null): void;
  /** Floating chrome a fit should keep the document out from under, in canvas CSS pixels. */
  setIslands(islands: readonly IslandRect[]): void;
  setViewportSize(width: number, height: number, devicePixelRatio: number): void;
  setViewport(viewport: Viewport): void;
  /** How far the artist can zoom out and pan, or null before the canvas has a size. */
  viewBounds(this: void): ViewBounds | null;
  setSaveStatus(status: SaveStatus): void;
  /** Names the document in memory. The name isn't history, so undo never changes it. */
  rename(name: string): void;
  /** Pastes outside pixels centered on the canvas as a selection. False when they don't fit. */
  place(image: Pick<BitmapDocument, 'width' | 'height' | 'pixels' | 'colorSpace'>): boolean;
  /** Loads the annotation-aware resize on first use, so it stays off the first load. */
  resizeDocument(width: number, height: number, anchor: CanvasAnchor): Promise<void>;
  toDocument(point: ScreenPoint): PixelPoint;
  /** The cursor over a markup shape or one of its handles, or null over anything else. */
  shapeCursorAt(point: PixelPoint, alt: boolean): string | null;
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
  let measuredFrame: ViewportInsets | null = null;
  let fitted = false;
  // The view a fit produced, so a later island measurement can tell nobody has panned since.
  let lastFit: Viewport | null = null;
  let refitOnResize = false;
  let gesture: Gesture | null = null;
  let selection: SelectionSession = beginSelection(initial, history);
  let shapes: ShapeController | null = null;
  let shapesLoading: Promise<void> | null = null;
  let queuedPress: QueuedPress | null = null;
  let paintExtras: PaintExtras | null = null;
  let paintLoading: Promise<void> | null = null;
  let queuedPaint: QueuedPaint | null = null;

  // Bounds depend only on these, so a pointer move reuses them without recomputing the fit.
  let bounds: ViewBounds | null = null;
  const boundsKey = {
    width: 0,
    height: 0,
    frame: FRAMES[layout],
    islands,
    documentWidth: 0,
    documentHeight: 0,
  };

  // The last hover sample, so a tool or size change from the keyboard redraws the brush in place.
  let hovering = false;
  const hoverCell = { x: 0, y: 0 };
  let hoverAlt = false;
  // Where that sample sits in the document, so keyboard zoom can anchor under the pointer.
  let hoverPoint: DocumentPoint | null = null;
  const update = (transition: (current: EditorState) => EditorState) => {
    const before = state.state;
    state.setState(transition);
    const after = state.state;
    if (hovering && (after.tool !== before.tool || after.brushSize !== before.brushSize))
      showCursor();
  };
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
    // The pixel marquee and a shape selection are exclusive.
    if (rect) shapes?.deselect();
    update((current) => (current.selection === rect ? current : { ...current, selection: rect }));
    const floating = selection.floating;
    setOverlay({
      marquee: rect,
      preview: floating ? { pixels: floating.pixels, bounds: floating.bounds } : null,
      sourceClear: selection.sourceToClear,
    });
  }

  /** Loads shape interaction before the first press can need it. */
  function loadShapes(): Promise<void> {
    shapesLoading ??= import('./shapes').then(({ createShapeController }) => {
      shapes = createShapeController({
        document,
        history,
        zoom: () => viewport.state.zoom,
        state: () => state.state,
        update,
        showHandles: (id) => {
          if (overlay.state.selectedAnnotationId !== id) setOverlay({ selectedAnnotationId: id });
        },
        clearPixels: () => {
          commitFloating();
          if (state.state.selection) setSelection(null);
        },
        committed: syncHistory,
      });
      replayQueuedPress();
    });
    return shapesLoading;
  }

  function replayQueuedPress(): void {
    const press = queuedPress;
    queuedPress = null;
    if (!press || !shapes || state.state.tool !== 'shapes') return;
    const { primary, shapeKind, shapeWidth } = state.state;
    const pressed = shapes.press(press.input.point, {
      draw: shapeKind,
      style: { color: primary, width: shapeWidth },
      alt: press.input.alt,
      touch: press.touch,
    });
    if (!pressed) return;
    if (press.latest) shapes.drag(press.latest.point, press.latest);
    if (press.ended) {
      shapes.lift();
      syncHistory();
    } else if (gesture?.kind === 'shape-queued' && gesture.press === press) {
      gesture = { kind: 'shape', shapes };
    }
  }

  function loadPaintExtras(): Promise<void> {
    paintLoading ??= importPaintExtras().then(({ createPaintExtras }) => {
      paintExtras = createPaintExtras();
      replayQueuedPaint();
    });
    return paintLoading;
  }

  function replayQueuedPaint(): void {
    const press = queuedPaint;
    queuedPaint = null;
    if (!press || !paintExtras || press.document !== document()) return;
    if (press.tool === 'fill') {
      if (paintExtras.fill(press.document, press.at, press.color, history).dirty) {
        update((current) => recordPaintedColor(current, press.color));
        syncHistory();
      }
      if (gesture?.kind === 'paint-queued' && gesture.press === press) gesture = { kind: 'fill' };
      return;
    }
    const preview = paintExtras.line(press.document, press.at, press.brush, history);
    const dirty = preview.update(press.latest, press.shift);
    if (press.ended) {
      if (preview.commit()) update((current) => recordPaintedColor(current, press.color));
      syncHistory();
    } else if (gesture?.kind === 'paint-queued' && gesture.press === press) {
      gesture = { kind: 'line', preview, color: press.color };
      setOverlay({ preview: linePreview(preview, dirty) });
    } else preview.cancel();
  }

  function hasShapes(bitmap: BitmapDocument = document()): boolean {
    return (findAnnotationsFor(bitmap)?.shapes.length ?? 0) > 0;
  }

  function frame(): ViewportInsets {
    return measuredFrame ?? FRAMES[layout];
  }

  function fit(): void {
    const view = viewport.state;
    if (!view.cssWidth || !view.cssHeight) return;
    const next = fitAroundIslands(view, document().width, document().height, frame(), islands);
    viewport.setState(() => ({
      ...next,
      panX: Math.round(next.panX),
      panY: Math.round(next.panY),
    }));
    fitted = true;
    lastFit = viewport.state;
  }

  function viewBounds(view: Viewport = viewport.state): ViewBounds | null {
    const { cssWidth, cssHeight } = view;
    if (!cssWidth || !cssHeight) return null;
    const { width, height } = document();
    if (
      bounds &&
      boundsKey.width === cssWidth &&
      boundsKey.height === cssHeight &&
      boundsKey.frame === frame() &&
      boundsKey.islands === islands &&
      boundsKey.documentWidth === width &&
      boundsKey.documentHeight === height
    )
      return bounds;
    boundsKey.width = cssWidth;
    boundsKey.height = cssHeight;
    boundsKey.frame = frame();
    boundsKey.islands = islands;
    boundsKey.documentWidth = width;
    boundsKey.documentHeight = height;
    bounds = boundsFor(view, width, height, frame(), islands);
    return bounds;
  }

  /** Session commands stop at a limit. Only direct drags stretch past one. */
  function bound(view: Viewport, at?: ScreenPoint): Viewport {
    const limits = viewBounds(view);
    return limits ? boundView(view, limits, at) : view;
  }

  function center(): ScreenPoint {
    return frameCenter(viewport.state, frame());
  }

  /** Keyboard zoom holds the pixel under a hovering pointer still, else the frame's center. */
  function zoomAnchor(): ScreenPoint {
    return hoverPoint ? documentToScreen(viewport.state, hoverPoint) : center();
  }

  function installDocument(next: BitmapDocument): void {
    // Undoing a resize brings back the earlier document object, which may carry an older name.
    next.name = document().name;
    selection = beginSelection(next, history);
    bitmap.setState(() => next);
    setSelection(null);
    shapes?.revalidate();
    update((current) => ({
      ...current,
      document: { name: next.name, width: next.width, height: next.height },
      panel: null,
    }));
    syncHistory();
    fit();
  }

  function showCursor(): void {
    const { tool } = state.state;
    // A brush previews its full footprint while any part of it can still paint.
    const cursor =
      hovering && tool !== 'select' && tool !== 'shapes' ? footprint(hoverCell, hoverAlt) : null;
    const paints = cursor && intersectRect(cursor, documentRect(), scratchRect);
    setOverlay({ cursor: paints ? cursor : null });
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
    shapes?.flush();
    if (!selection.floating) return false;
    const committed = selection.commit();
    setSelection(null);
    syncHistory();
    return committed;
  }

  /** A shape's exact color wins over the blended pixels beneath it. */
  function pickColor(point: PixelPoint, touch: boolean): void {
    const color =
      shapes?.colorAt(point, touch) ??
      getPixel(document(), { x: Math.floor(point.x), y: Math.floor(point.y) });
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
    if (state.state.selectedShape && !gesture) {
      shapes?.nudge({ x: dx, y: dy });
      return;
    }
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

  function zoomBy(direction: -1 | 1, anchor = zoomAnchor()): void {
    viewport.setState((view) => {
      // At or under the floor, zooming out only ever holds still.
      const floor = viewBounds()?.minZoom ?? 0;
      if (direction < 0 && view.zoom <= floor) return bound(view, anchor);
      return bound(stepZoom(view, direction, anchor), anchor);
    });
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
    flushPendingEdits() {
      shapes?.flush();
    },

    run(command) {
      // Nudges and width steps coalesce into the pending shape edit. Everything else lands it.
      if (command.type !== 'nudge' && command.type !== 'brush-size') shapes?.flush();
      switch (command.type) {
        case 'tool':
          if (command.tool === 'fill' || command.tool === 'line') void loadPaintExtras();
          if (command.tool !== 'select') commitFloating();
          // Pixel tools paint beneath shapes, so only Select keeps a shape selected.
          if (command.tool !== 'select') shapes?.deselect();
          else if (hasShapes()) void loadShapes();
          if (command.tool === 'eyedropper' && hasShapes()) void loadShapes();
          update((current) => selectTool(current, command.tool));
          return;
        case 'shape-tool':
          commitFloating();
          void loadShapes();
          update((current) => selectShape(current, command.kind));
          return;
        case 'shape':
          // A shape is only ever selected through the controller, so it's loaded whenever one is.
          if (!gesture) shapes?.run(command.action);
          return;
        case 'swap-colors':
          update(swapColors);
          shapes?.restyle({ color: state.state.primary });
          return;
        case 'brush-size': {
          const before = state.state.shapeWidth;
          update((current) => stepBrush(current, command.direction));
          if (state.state.shapeWidth !== before) shapes?.restyle({ width: state.state.shapeWidth });
          return;
        }
        case 'undo':
        case 'redo':
          if (gesture) return;
          commitFloating();
          const change =
            command.type === 'undo' ? history.undo(document()) : history.redo(document());
          if (change && 'document' in change) installDocument(change.document);
          else {
            setSelection(null);
            shapes?.revalidate();
          }
          syncHistory();
          return;
        case 'zoom':
          zoomBy(command.direction);
          return;
        case 'zoom-fit':
          fit();
          return;
        case 'zoom-actual':
          {
            const anchor = zoomAnchor();
            viewport.setState((view) => bound(zoomToStep(view, 1, anchor), anchor));
          }
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
      // Color describes what's selected: picking one restyles the selected shape.
      if (slot === 'primary') shapes?.restyle({ color });
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
      shapes?.restyle({ width });
    },

    setLayout(next) {
      if (layout === next) return;
      const untouched = !fitted || viewport.state === lastFit;
      layout = next;
      if (!untouched) {
        viewport.setState((view) => bound(view, center()));
        return;
      }
      // The layout flips with the window, before the canvas reports its new size.
      refitOnResize = true;
      fit();
    },

    setFrame(next) {
      const current = measuredFrame;
      if (
        current === next ||
        (current &&
          next &&
          current.top === next.top &&
          current.right === next.right &&
          current.bottom === next.bottom &&
          current.left === next.left)
      )
        return;
      const untouched = fitted && viewport.state === lastFit;
      measuredFrame = next;
      // Like islands, a new frame refits only an untouched view. A resize re-bounds the rest.
      if (untouched) fit();
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
      const resized = {
        ...view,
        cssWidth: width,
        cssHeight: height,
        devicePixelRatio,
        panX: Math.round(view.panX + dx),
        panY: Math.round(view.panY + dy),
      };
      if (!fitted || refitOnResize || untouchedFit) {
        viewport.setState(() => resized);
        refitOnResize = false;
        fit();
        return;
      }
      // A manual view keeps its zoom unless a larger window raises the floor past it, and its pan
      // comes back within reach.
      viewport.setState(() => bound(resized, frameCenter(resized, frame())));
    },

    setViewport(next) {
      viewport.setState(() => next);
    },

    viewBounds: () => viewBounds(),

    setSaveStatus(status) {
      update((current) => (current.save === status ? current : { ...current, save: status }));
    },

    rename(name) {
      const current = document();
      current.name = name;
      update((state) => ({
        ...state,
        document: { name, width: current.width, height: current.height },
      }));
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

    async resizeDocument(width, height, anchor) {
      const { resizeAnnotatedDocument } = await import('../../annotations');
      commitFloating();
      installDocument(resizeAnnotatedDocument(document(), history, width, height, anchor));
    },

    toDocument(point) {
      return screenToDocument(viewport.state, point);
    },

    shapeCursorAt(point, alt) {
      const { tool } = state.state;
      if (gesture || !shapes || (tool !== 'shapes' && tool !== 'select')) return null;
      return shapes.cursorAt(point, alt);
    },

    hover(point, alt = false) {
      const cell = point && { x: Math.floor(point.x), y: Math.floor(point.y) };
      const inside = cell && contains(documentRect(), cell) ? cell : null;
      const previous = pointer.state;
      if (previous?.x !== inside?.x || previous?.y !== inside?.y) pointer.setState(() => inside);
      hovering = cell !== null;
      hoverPoint = point && { x: point.x, y: point.y };
      if (cell) {
        hoverCell.x = cell.x;
        hoverCell.y = cell.y;
      }
      hoverAlt = alt;
      showCursor();
    },

    beginGesture({ point, alt }, pointer = 'mouse') {
      if (gesture) return;
      shapes?.flush();
      const cell = { x: Math.floor(point.x), y: Math.floor(point.y) };
      const { tool, brushSize, primary } = state.state;
      const touch = pointer === 'touch';
      if (tool === 'eyedropper' || (alt && tool !== 'select' && tool !== 'shapes')) {
        gesture = { kind: 'pick', pointer, before: primary };
        pickColor(point, touch);
        return;
      }
      if (tool === 'select' || tool === 'shapes') {
        const rect = state.state.selection;
        const inMarquee =
          tool === 'select' && rect !== null && contains(selection.floating?.bounds ?? rect, cell);
        if (overlay.state.coarseAnnotationHandles !== touch)
          setOverlay({ coarseAnnotationHandles: touch });
        if (tool === 'shapes' && rect) {
          commitFloating();
          setSelection(null);
        }
        const { shapeKind, shapeWidth } = state.state;
        const pressed =
          !inMarquee &&
          shapes?.press(point, {
            draw: tool === 'shapes' ? shapeKind : null,
            style: { color: primary, width: shapeWidth },
            alt,
            touch,
          });
        if (pressed && shapes) {
          gesture = { kind: 'shape', shapes };
          return;
        }
        if (tool === 'shapes') {
          if (shapes) return;
          queuedPress = { input: { point, shift: false, alt }, touch, latest: null, ended: false };
          gesture = { kind: 'shape-queued', press: queuedPress };
          void loadShapes();
          return;
        }
        if (!inMarquee) shapes?.deselect();
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
      commitFloating();
      if (selection.floating === null && state.state.selection) setSelection(null);
      const color = tool === 'eraser' ? TRANSPARENT : primary;
      const brush = { color, size: brushSize, pixelPerfect: brushSize === 1 };
      if (tool === 'fill' || tool === 'line') {
        if (tool === 'fill' && !contains(documentRect(), cell)) return;
        if (!paintExtras) {
          queuedPaint = {
            tool,
            document: document(),
            at: cell,
            latest: cell,
            shift: false,
            color,
            brush,
            ended: false,
          };
          gesture = { kind: 'paint-queued', press: queuedPaint };
          void loadPaintExtras();
        } else if (tool === 'fill') {
          if (paintExtras.fill(document(), cell, color, history).dirty) {
            update((current) => recordPaintedColor(current, color));
            syncHistory();
          }
          gesture = { kind: 'fill' };
        } else {
          const preview = paintExtras.line(document(), cell, brush, history);
          const dirty = preview.update(cell);
          gesture = { kind: 'line', preview, color };
          setOverlay({ preview: linePreview(preview, dirty) });
        }
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
          if (state.state.tool === 'eyedropper')
            pickColor(latest.point, current.pointer === 'touch');
          return;
        case 'fill':
          return;
        case 'shape':
          current.shapes.drag(latest.point, latest);
          return;
        case 'shape-queued':
          current.press.latest = latest;
          return;
        case 'paint-queued':
          current.press.latest = cell;
          current.press.shift = latest.shift;
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
        case 'shape':
          current.shapes.lift();
          break;
        case 'shape-queued':
          current.press.ended = true;
          break;
        case 'paint-queued':
          current.press.ended = true;
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
        case 'shape':
          current.shapes.cancel();
          break;
        case 'shape-queued':
          queuedPress = null;
          break;
        case 'paint-queued':
          queuedPaint = null;
          break;
        case 'move':
        case 'fill':
          break;
      }
      syncHistory();
    },
  };

  if (state.state.tool === 'shapes' || hasShapes(initial)) void loadShapes();
  if (state.state.tool === 'fill' || state.state.tool === 'line') void loadPaintExtras();
  return session;
}

/** Line previews are compact buffers over their own bounds. */
function linePreview(preview: LinePreview, dirty: PixelRect | null): OverlayPreview | null {
  if (!preview.bounds) return null;
  return { pixels: preview.overlay, bounds: preview.bounds, dirty: dirty ?? undefined };
}
