import type { ToolKind } from '../../tools';

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
export function usesBrush(kind: ToolKind): boolean {
  return kind === 'pencil' || kind === 'eraser' || kind === 'line';
}
