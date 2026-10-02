import type { ToolKind } from '../../tools';
import { brushSizeAt, brushSizeIndex } from './brush';

export interface ToolInfo {
  kind: ToolKind;
  label: string;
  /** Single-letter shortcut, lowercase. */
  key: string;
  hint: string;
}

export const TOOLS: readonly ToolInfo[] = [
  { kind: 'pencil', label: 'Pencil', key: 'b', hint: '' },
  { kind: 'eraser', label: 'Eraser', key: 'e', hint: '' },
  { kind: 'fill', label: 'Fill', key: 'g', hint: 'Fills touching pixels of the same color' },
  { kind: 'eyedropper', label: 'Eyedropper', key: 'i', hint: 'Click to pick a color' },
  { kind: 'line', label: 'Line', key: 'l', hint: '' },
  { kind: 'select', label: 'Select', key: 'm', hint: 'Drag to select, then drag inside to move' },
];

export function toolInfo(kind: ToolKind): ToolInfo {
  const info = TOOLS.find((tool) => tool.kind === kind);
  if (!info) throw new Error(`Unknown tool ${kind}`);
  return info;
}

/** Tools whose footprint follows the brush size. */
export function usesBrush(kind: EditorTool): boolean {
  return kind === 'pencil' || kind === 'eraser' || kind === 'line';
}

/**
 * Markup shapes share one rail item, like Preview's Shapes popover. They aren't pixel tools: they
 * draw editable objects above the document.
 */
export type ShapeKind = 'rectangle' | 'arrow';
/** Everything the rail can select: the pixel tools plus the Shapes item. */
export type EditorTool = ToolKind | 'shapes';

export interface ShapeInfo {
  kind: ShapeKind;
  label: string;
  /** Single-letter shortcut, lowercase. */
  key: string;
}

export const SHAPES: readonly ShapeInfo[] = [
  { kind: 'rectangle', label: 'Rectangle', key: 'r' },
  { kind: 'arrow', label: 'Arrow', key: 'a' },
];

export function shapeInfo(kind: ShapeKind): ShapeInfo {
  return SHAPES.find((shape) => shape.kind === kind)!;
}

/**
 * A stroke that reads at fit without adjustment: about one pixel per 320 along the long side,
 * snapped down to the size ladder. A sprite gets 1 px and a 1990 px Retina screenshot gets 6.
 */
export function defaultShapeWidth(width: number, height: number): number {
  return brushSizeAt(brushSizeIndex(Math.max(1, Math.round(Math.max(width, height) / 320))));
}
