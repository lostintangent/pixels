import { createStore } from '@tanstack/store';
import type { Store } from '@tanstack/store';
import { fitViewport, screenToDocument, stepZoom, zoomToStep } from '../../canvas';
import type {
  OverlayPreview,
  OverlayState,
  ScreenPoint,
  Viewport,
  ViewportInsets,
} from '../../canvas';
import { getPixel, intersectRect, resizeDocument } from '../../document';
import type {
  BitmapDocument,
  CanvasAnchor,
  PackedColor,
  PixelPoint,
  PixelRect,
} from '../../document';
import { createDocumentHistory } from '../../history';
import { alpha, TRANSPARENT } from '../../palette';
import {
  beginLinePreview,
  LinePreviewWorkspace,
  beginSelection,
  beginStroke,
  copySelection,
  FillWorkspace,
  floodFill,
  pasteSelection,
} from '../../tools';
import type { FloatingSelection, LinePreview, SelectionSession, StrokeSession } from '../../tools';
import { usesBrush } from '../core/tools';
import type { EditorCommand, SelectionAction } from '../core/shortcuts';
import {
  chooseColor,
  initialEditorState,
  openPanel,
  recordPaintedColor,
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

/** Space the floating islands occupy, so fit centers the canvas in what's left. */
const INSETS: Record<Layout, ViewportInsets> = {
  desktop: { top: 72, right: 272, bottom: 56, left: 76 },
  phone: { top: 72, right: 16, bottom: 148, left: 16 },
};

type Gesture =
  | { kind: 'stroke'; session: StrokeSession; last: PixelPoint; color: PackedColor }
  | { kind: 'line'; preview: LinePreview; color: PackedColor }
  | { kind: 'marquee'; anchor: PixelPoint }
  | { kind: 'move'; grab: PixelPoint }
  | { kind: 'pick' };

export interface EditorSession {
  readonly state: Store<EditorState>;
  readonly bitmap: Store<BitmapDocument>;
  readonly viewport: Store<Viewport>;
  readonly overlay: Store<OverlayState>;
  /** Document pixel under the pointer, or null when outside the canvas. */
  readonly pointer: Store<PixelPoint | null>;
  run(command: EditorCommand): void;
  chooseColor(color: PackedColor, slot: ColorSlot): void;
  setBrushSize(size: number): void;
  /** Opens a dialog or sheet, or closes whichever is open. */
  setPanel(panel: EditorPanel | null): void;
  /** Checker and grid colors follow the resolved color scheme. */
  setCanvasColors(colors: NonNullable<OverlayState['colors']>): void;
  setLayout(layout: Layout): void;
  setViewportSize(width: number, height: number, devicePixelRatio: number): void;
  setViewport(viewport: Viewport): void;
  setSaveStatus(status: SaveStatus): void;
  /** Pastes outside pixels centered on the canvas as a selection. False when they don't fit. */
  place(image: Pick<BitmapDocument, 'width' | 'height' | 'pixels'>): boolean;
  resizeDocument(width: number, height: number, anchor: CanvasAnchor): void;
  toDocument(point: ScreenPoint): PixelPoint;
  hover(point: PixelPoint | null): void;
  beginGesture(input: GestureInput): void;
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
  const state = createStore(
    initialEditorState(
      { name: initial.name, width: initial.width, height: initial.height },
      save,
      preferences,
    ),
  );
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
    grid: 'auto',
    cursor: null,
    marquee: null,
    preview: null,
  });
  const pointer = createStore<PixelPoint | null>(null);

  let layout: Layout = 'desktop';
  let fitted = false;
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
    });
  }

  function fit(): void {
    const view = viewport.state;
    if (!view.cssWidth || !view.cssHeight) return;
    const next = fitViewport(view, document().width, document().height, INSETS[layout]);
    viewport.setState(() => ({
      ...next,
      panX: Math.round(next.panX),
      panY: Math.round(next.panY),
    }));
    fitted = true;
  }

  function center(): ScreenPoint {
    const insets = INSETS[layout];
    const view = viewport.state;
    return {
      x: insets.left + (view.cssWidth - insets.left - insets.right) / 2,
      y: insets.top + (view.cssHeight - insets.top - insets.bottom) / 2,
    };
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

  function footprint(point: PixelPoint): PixelRect {
    const { tool, brushSize } = state.state;
    const size = usesBrush(tool) ? brushSize : 1;
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

  function commitFloating(): void {
    if (!selection.floating) return;
    selection.commit();
    syncHistory();
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
            }
          : copySelection(document(), rect);
        if (copied) clipboard.write(copied);
        if (action === 'cut') runSelection('clear');
        return;
      }
      case 'paste': {
        const copied = clipboard.read();
        if (copied) paste(copied, { x: copied.bounds.x, y: copied.bounds.y });
        return;
      }
    }
  }

  function paste(pixels: FloatingSelection, at: PixelPoint): boolean {
    commitFloating();
    if (!pasteSelection(document(), pixels, at, history)) return false;
    syncHistory();
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

    run(command) {
      switch (command.type) {
        case 'tool':
          if (command.tool !== 'select') commitFloating();
          update((current) => selectTool(current, command.tool));
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
          update((current) => openPanel(current, command.panel));
          return;
        case 'open-file':
          // File pickers need the DOM, so the shell handles this one before it reaches here.
          return;
        case 'selection':
          runSelection(command.action);
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

    setLayout(next) {
      if (layout === next) return;
      layout = next;
      // The layout flips with the window, before the canvas reports its new size.
      refitOnResize = true;
      fit();
    },

    setViewportSize(width, height, devicePixelRatio) {
      const view = viewport.state;
      if (
        view.cssWidth === width &&
        view.cssHeight === height &&
        view.devicePixelRatio === devicePixelRatio
      )
        return;
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
      if (!fitted || refitOnResize) {
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
      return paste({ bounds, sourceBounds: bounds, pixels: image.pixels }, at);
    },

    resizeDocument(width, height, anchor) {
      commitFloating();
      replaceDocument(resizeDocument(document(), width, height, anchor));
    },

    toDocument(point) {
      return screenToDocument(viewport.state, point);
    },

    hover(point) {
      const cell = point && { x: Math.floor(point.x), y: Math.floor(point.y) };
      const inside = cell && contains(documentRect(), cell) ? cell : null;
      const previous = pointer.state;
      if (previous?.x !== inside?.x || previous?.y !== inside?.y) pointer.setState(() => inside);
      const { tool } = state.state;
      // A brush previews its full footprint while any part of it can still paint.
      const cursor = cell && tool !== 'select' ? footprint(cell) : null;
      const paints = cursor && intersectRect(cursor, documentRect(), scratchRect);
      setOverlay({ cursor: paints ? cursor : null });
    },

    beginGesture({ point, alt }) {
      if (gesture) return;
      const cell = { x: Math.floor(point.x), y: Math.floor(point.y) };
      const { tool, brushSize, primary } = state.state;
      if (tool === 'eyedropper' || (alt && tool !== 'select')) {
        pickColor(cell);
        gesture = { kind: 'pick' };
        return;
      }
      if (tool === 'select') {
        const rect = state.state.selection;
        if (rect && contains(selection.floating?.bounds ?? rect, cell)) {
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
      if (tool === 'fill') {
        if (!contains(documentRect(), cell)) return;
        if (floodFill(document(), { at: cell, color }, history, fillWorkspace).dirty) {
          update((current) => recordPaintedColor(current, color));
          syncHistory();
        }
        gesture = { kind: 'pick' };
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
      gesture = { kind: 'stroke', session: stroke, last: cell, color };
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
      }
    },

    endGesture() {
      const current = gesture;
      gesture = null;
      if (!current) return;
      switch (current.kind) {
        case 'stroke':
          if (current.session.end()) update((s) => recordPaintedColor(s, current.color));
          break;
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
        case 'move':
        case 'pick':
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
        case 'move':
        case 'pick':
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
