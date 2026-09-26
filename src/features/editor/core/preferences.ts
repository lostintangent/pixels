import type { PackedColor } from '../../document';
import { RECENT_LIMIT } from '../../palette/model';
import type { ToolKind } from '../../tools';
import { BRUSH_SIZES } from './brush';
import { DEFAULT_TOOL_PREFERENCES } from './state';
import type { ToolPreferences } from './state';
import { TOOLS } from './tools';

/**
 * Reads preferences saved by an earlier visit, which may come from an older build. Each field is
 * checked on its own, so a tool that no longer exists costs only the tool, not your colors.
 */
export function decodeToolPreferences(value: unknown): ToolPreferences {
  const fallback = DEFAULT_TOOL_PREFERENCES;
  if (typeof value !== 'object' || value === null) return fallback;
  const saved = value as Partial<Record<keyof ToolPreferences, unknown>>;
  return {
    tool: isToolKind(saved.tool) ? saved.tool : fallback.tool,
    brushSize: isBrushSize(saved.brushSize) ? saved.brushSize : fallback.brushSize,
    primary: isColor(saved.primary) ? saved.primary : fallback.primary,
    secondary: isColor(saved.secondary) ? saved.secondary : fallback.secondary,
    recent: Array.isArray(saved.recent) ? decodeRecent(saved.recent) : fallback.recent,
    gridEnabled: typeof saved.gridEnabled === 'boolean' ? saved.gridEnabled : fallback.gridEnabled,
  };
}

export function sameToolPreferences(a: ToolPreferences, b: ToolPreferences): boolean {
  return (
    a.tool === b.tool &&
    a.brushSize === b.brushSize &&
    a.primary === b.primary &&
    a.secondary === b.secondary &&
    a.gridEnabled === b.gridEnabled &&
    a.recent.length === b.recent.length &&
    a.recent.every((color, index) => color === b.recent[index])
  );
}

function decodeRecent(values: readonly unknown[]): readonly PackedColor[] {
  const recent: PackedColor[] = [];
  for (const value of values) {
    if (recent.length === RECENT_LIMIT) break;
    if (isColor(value) && !recent.includes(value)) recent.push(value);
  }
  return recent;
}

function isToolKind(value: unknown): value is ToolKind {
  return TOOLS.some((tool) => tool.kind === value);
}

function isBrushSize(value: unknown): value is number {
  return BRUSH_SIZES.some((size) => size === value);
}

function isColor(value: unknown): value is PackedColor {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff;
}
