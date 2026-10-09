import {
  annotationsFor,
  beginAnnotationEdit,
  createAnnotationId,
  deleteAnnotation,
  duplicateAnnotation,
  translateAnnotation,
} from '../../annotations';
import type { Annotation, AnnotationEdit, AnnotationHandleId } from '../../annotations/model';
import type { BitmapDocument, PackedColor, PixelPoint } from '../../document';
import type { DocumentHistory } from '../../history';
import { chooseColor, recordPaintedColor } from '../core/state';
import type { EditorState } from '../core/state';
import {
  beginShapeDrag,
  isDegenerateShape,
  heldRun,
  keepsOnImage,
  leftDeadZone,
  liveShape,
  shapeTargetAt,
} from '../core/shapeGesture';
import type { ShapeBounds, ShapeDrag, ShapeDragModifiers, ShapeStyle } from '../core/shapeGesture';
import type { ShapeAction } from '../core/shortcuts';
import type { ShapeKind } from '../core/tools';

/**
 * Shape interaction loads on demand, so an editor that never touches markup keeps the gesture and
 * handle math off its first load. The session loads it before the first press can need it.
 */
export interface ShapeHost {
  document(): BitmapDocument;
  readonly history: DocumentHistory;
  zoom(): number;
  state(): EditorState;
  update(change: (state: EditorState) => EditorState): void;
  /** Which shape the overlay draws handles on. A shape being drawn shows bare. */
  showHandles(id: string | null): void;
  /** Lands a floating paste and drops the pixel marquee. The two selections are exclusive. */
  clearPixels(): void;
  /** A shape edit landed in history outside a pointer gesture. */
  committed(): void;
}

export interface ShapePress {
  /** The shape a press on empty canvas draws, or null when it should fall through. */
  draw: ShapeKind | null;
  style: ShapeStyle;
  alt: boolean;
  touch: boolean;
}

export interface ShapeController {
  /** Starts a drag on a shape or a new drawing. False leaves the press to the pixel tools. */
  press(point: PixelPoint, options: ShapePress): boolean;
  drag(point: PixelPoint, modifiers: ShapeDragModifiers): void;
  lift(): void;
  cancel(): void;
  /** The exact color of the shape under the point, for the eyedropper. */
  colorAt(point: PixelPoint, touch: boolean): PackedColor | null;
  cursorAt(point: PixelPoint, alt: boolean): string | null;
  run(action: ShapeAction): void;
  nudge(delta: PixelPoint): void;
  restyle(patch: Partial<ShapeStyle>): void;
  /** Lands a pending nudge or restyle run as its undo step. */
  flush(): void;
  deselect(): void;
  /** Undo, redo, and resize can remove the selected shape or change its color or width. */
  revalidate(): void;
}

const HANDLE_CURSORS: Record<AnnotationHandleId, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  start: 'move',
  end: 'move',
};

/** Arrow-key nudges and slider or picker drags within this window land as one undo step. */
const AMEND_MS = 700;

interface Drag {
  drag: ShapeDrag;
  press: PixelPoint;
  touch: boolean;
  style: ShapeStyle;
  edit: AnnotationEdit | null;
  live: Annotation | null;
  /** The selection a cancelled drag returns to. */
  restore: Annotation | null;
}

interface Amend {
  id: string;
  label: string;
  edit: AnnotationEdit;
  /** The shape before this run, so a restyle knows whether its color changed. */
  base: Annotation;
  shape: Annotation;
  timer: ReturnType<typeof setTimeout>;
}

function dragLabel(drag: ShapeDrag): string {
  if (drag.mode === 'draw') return drag.kind === 'rectangle' ? 'Draw rectangle' : 'Draw arrow';
  if (drag.mode === 'handle') return 'Resize shape';
  return drag.id === drag.original.id ? 'Move shape' : 'Duplicate shape';
}

export function createShapeController(host: ShapeHost): ShapeController {
  let drag: Drag | null = null;
  let amend: Amend | null = null;
  const set = () => annotationsFor(host.document());
  const selectedId = () => host.state().selectedShape?.id ?? null;
  const bounds = (): ShapeBounds => {
    const { width, height } = host.document();
    return { width, height, zoom: host.zoom() };
  };

  /** Selecting a shape loads its color and width, so the well and the width bar describe it. */
  function select(shape: Annotation | null): void {
    if (shape) {
      host.clearPixels();
      host.update((current) => ({
        ...chooseColor(current, shape.color, 'primary'),
        selectedShape: { id: shape.id, kind: shape.kind },
        shapeWidth: shape.width,
      }));
    } else if (host.state().selectedShape) {
      host.update((current) => ({ ...current, selectedShape: null }));
    }
    host.showHandles(shape?.id ?? null);
  }

  function flush(): void {
    const current = amend;
    if (!current) return;
    amend = null;
    clearTimeout(current.timer);
    current.edit.commit(current.shape);
    // A recolor puts that color on the canvas, so Recent learns it as a pixel tool's color does.
    const { color } = current.shape;
    if (color !== current.base.color) host.update((state) => recordPaintedColor(state, color));
    host.committed();
  }

  function amendShape(label: string, change: (shape: Annotation) => Annotation): void {
    const id = selectedId();
    if (!id) return;
    if (amend && (amend.id !== id || amend.label !== label)) flush();
    const base = amend?.shape ?? set().get(id);
    if (!base) return;
    const shape = change(base);
    if (!amend) {
      const edit = beginAnnotationEdit(host.document(), host.history, label);
      amend = { id, label, edit, base, shape, timer: setTimeout(flush, AMEND_MS) };
    } else {
      clearTimeout(amend.timer);
      amend.shape = shape;
      amend.timer = setTimeout(flush, AMEND_MS);
    }
    amend.edit.preview(shape);
  }

  function targetAt(point: PixelPoint, touch: boolean) {
    return shapeTargetAt(set(), selectedId(), point, host.zoom(), touch, touch);
  }

  return {
    press(point, { draw, style, alt, touch }) {
      const target = targetAt(point, touch);
      if (!target && !draw) return false;
      flush();
      const selected = selectedId();
      const restore = selected ? set().get(selected) : null;
      // A press on a shape selects it at once. A press on nothing deselects, and a drag draws.
      select(target?.shape ?? null);
      const ids = { newId: createAnnotationId(), copyId: createAnnotationId() };
      drag = {
        drag: beginShapeDrag(
          target,
          point,
          { kind: draw ?? 'rectangle', width: style.width },
          ids,
          alt,
        ),
        press: point,
        touch,
        style,
        edit: null,
        live: null,
        restore,
      };
      return true;
    },
    drag(point, modifiers) {
      const current = drag;
      if (!current) return;
      if (!current.live && !leftDeadZone(current.press, point, host.zoom(), current.touch)) return;
      current.edit ??= beginAnnotationEdit(host.document(), host.history, dragLabel(current.drag));
      current.live = liveShape(current.drag, point, modifiers, current.style, bounds());
      current.edit.preview(current.live);
      // An Option copy moves its handles onto the copy.
      host.showHandles(current.drag.mode === 'draw' ? null : current.live.id);
    },
    lift() {
      const current = drag;
      drag = null;
      const live = current?.live;
      if (!current?.edit || !live) return;
      const drawn = current.drag.mode === 'draw';
      // Too small to see or grab, or drawn where none of it lands on the image.
      if (drawn && (isDegenerateShape(live) || !keepsOnImage(live, bounds()))) {
        current.edit.cancel();
        return;
      }
      current.edit.commit(live);
      select(live);
      if (drawn) host.update((current) => recordPaintedColor(current, live.color));
    },
    cancel() {
      const current = drag;
      drag = null;
      if (!current) return;
      current.edit?.cancel();
      select(current.restore);
    },
    colorAt(point, touch) {
      return targetAt(point, touch)?.shape.color ?? null;
    },
    cursorAt(point, alt) {
      const target = targetAt(point, false);
      if (!target) return null;
      return target.handle ? HANDLE_CURSORS[target.handle] : alt ? 'copy' : 'move';
    },
    run(action) {
      const id = selectedId();
      if (!id) return;
      flush();
      if (action === 'delete') deleteAnnotation(host.document(), host.history, id);
      const copy = action === 'duplicate' && duplicateAnnotation(host.document(), host.history, id);
      select(copy ? (set().get(copy) ?? null) : null);
      host.committed();
    },
    nudge(delta) {
      amendShape('Nudge shape', (shape) => {
        const moved = translateAnnotation(shape, delta);
        const image = bounds();
        const need = heldRun(shape, image);
        // A nudge that would leave too little on the image holds, like a drag at the edge.
        return need === null || keepsOnImage(moved, image, need) ? moved : shape;
      });
    },
    restyle(patch) {
      amendShape('Restyle shape', (shape) => ({ ...shape, ...patch }));
    },
    flush,
    deselect: () => select(null),
    revalidate() {
      const id = selectedId();
      if (!id) return;
      const shape = set().get(id);
      if (!shape) select(null);
      // Undo and Redo bring back a color the artist already painted, so Recent stays as it is.
      else
        host.update((current) => ({
          ...chooseColor(current, shape.color, 'primary'),
          shapeWidth: shape.width,
        }));
    },
  };
}
