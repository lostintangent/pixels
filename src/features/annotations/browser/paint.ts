import type { DocumentColorSpace } from '../../document';
import { toCss } from '../../palette/model';
import { compositeAnnotationLayer } from '../core/composite';
import type { Annotation, AnnotationSet } from '../core/contracts';
import { arrowGeom, handlesOf, rectOf } from '../core/geometry';

type ShapeContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Shapes are stored on grid lines, so an odd stroke width would straddle two pixels and
 * export as two half-alpha lines. Odd widths move half a pixel onto pixel centers.
 */
const pixelOffset = (width: number) => (width % 2 === 1 ? 0.5 : 0);

/** `offset` comes from the stored width, so a widened selection halo stays centered on it. */
export function paintAnnotation(
  ctx: ShapeContext,
  shape: Annotation,
  colorSpace: DocumentColorSpace,
  offset = pixelOffset(shape.width),
): void {
  const color = toCss(shape.color, colorSpace);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = shape.width;
  if (shape.kind === 'rectangle') {
    const rect = rectOf(shape);
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    ctx.rect(
      rect.x + offset,
      rect.y + offset,
      Math.max(0, rect.width - 2 * offset),
      Math.max(0, rect.height - 2 * offset),
    );
    ctx.stroke();
    return;
  }
  const head = arrowGeom(shape);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(shape.start.x + offset, shape.start.y + offset);
  ctx.lineTo(
    head.base.x + (shape.end.x - head.base.x) * 0.3 + offset,
    head.base.y + (shape.end.y - head.base.y) * 0.3 + offset,
  );
  ctx.stroke();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, shape.width * 0.35);
  ctx.beginPath();
  ctx.moveTo(shape.end.x + offset, shape.end.y + offset);
  ctx.lineTo(head.left.x + offset, head.left.y + offset);
  ctx.lineTo(head.right.x + offset, head.right.y + offset);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/** The preview replaces its committed counterpart at the same z-index. */
export function paintVisibleAnnotations(
  ctx: ShapeContext,
  set: AnnotationSet,
  colorSpace: DocumentColorSpace,
): void {
  const preview = set.preview;
  let paintedPreview = false;
  for (const shape of set.shapes) {
    if (preview?.id === shape.id) {
      paintAnnotation(ctx, preview, colorSpace);
      paintedPreview = true;
    } else paintAnnotation(ctx, shape, colorSpace);
  }
  if (preview && !paintedPreview) paintAnnotation(ctx, preview, colorSpace);
}

export function paintAnnotationSelection(
  ctx: ShapeContext,
  shape: Annotation,
  colorSpace: DocumentColorSpace,
  zoom: number,
  panX: number,
  panY: number,
  documentWidth: number,
  documentHeight: number,
  coarse: boolean,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(panX, panY, documentWidth * zoom, documentHeight * zoom);
  ctx.clip();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);
  const offset = pixelOffset(shape.width);
  for (const [grow, color] of [
    [3.5, 0x52000000],
    [2, 0xf2ffffff],
  ] as const) {
    paintAnnotation(
      ctx,
      { ...shape, width: shape.width + (2 * grow) / zoom, color },
      'srgb',
      offset,
    );
  }
  paintAnnotation(ctx, shape, colorSpace, offset);
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#1f1d2b';
  ctx.lineWidth = 1;
  for (const handle of handlesOf(shape, zoom, coarse)) {
    const x = panX + handle.x * zoom;
    const y = panY + handle.y * zoom;
    ctx.fillRect(x - 4.5, y - 4.5, 9, 9);
    ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
  }
}

/** The caller supplies an OffscreenCanvas in the PNG Worker; the bitmap itself is never mutated. */
export function flattenAnnotations(
  pixels: Uint32Array,
  width: number,
  height: number,
  colorSpace: DocumentColorSpace,
  shapes: readonly Annotation[],
  canvas: OffscreenCanvas | HTMLCanvasElement,
): Uint32Array {
  if (!shapes.length) return pixels;
  if (pixels.length !== width * height)
    throw new RangeError('Annotation image size does not match');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { colorSpace }) as ShapeContext | null;
  if (!ctx) throw new Error('Canvas 2D is unavailable for annotation export');
  for (const shape of shapes) paintAnnotation(ctx, shape, colorSpace);
  const layer = ctx.getImageData(0, 0, width, height, { colorSpace }).data;
  return compositeAnnotationLayer(pixels, layer);
}
