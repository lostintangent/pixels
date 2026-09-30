import type { PointerKind } from '../../canvas/model';
import type { PackedColor, PixelRect } from '../../document';
import { DEFAULT_PALETTE, rememberColor } from '../../palette/model';
import type { PaletteState } from '../../palette/model';
import type { ToolKind } from '../../tools';
import { stepBrushSize } from './brush';

export type EditorPanel = 'new' | 'export' | 'resize' | 'colors';
/** Mirrors autosave's reports. Null until a document has been saved or edited at all. */
export type SaveStatus = 'saved' | 'saving' | 'error';
export type ColorSlot = 'primary' | 'secondary';

export interface DocumentSummary {
  name: string;
  width: number;
  height: number;
}

/** Everything React renders. Pointer-rate state (hover, viewport pan) lives elsewhere. */
export interface EditorState extends PaletteState {
  tool: ToolKind;
  /** The tool before this one, where a one-shot eyedropper returns. Null after a reload. */
  previousTool: ToolKind | null;
  brushSize: number;
  gridEnabled: boolean;
  chromeHidden: boolean;
  panel: EditorPanel | null;
  selection: PixelRect | null;
  hasClipboardPixels: boolean;
  canUndo: boolean;
  canRedo: boolean;
  document: DocumentSummary;
  save: SaveStatus | null;
}

/**
 * How the artist is working, as opposed to what they're working on. These carry from one document
 * to the next, so opening a recent canvas keeps your brush, colors, and grid.
 */
export type ToolPreferences = Pick<
  EditorState,
  'tool' | 'brushSize' | 'primary' | 'secondary' | 'recent' | 'gridEnabled'
>;

export const DEFAULT_TOOL_PREFERENCES: ToolPreferences = {
  tool: 'pencil',
  brushSize: 1,
  primary: DEFAULT_PALETTE[11]!,
  secondary: DEFAULT_PALETTE[1]!,
  recent: [],
  gridEnabled: true,
};

export function initialEditorState(
  document: DocumentSummary,
  save: SaveStatus | null = null,
  preferences: ToolPreferences = DEFAULT_TOOL_PREFERENCES,
): EditorState {
  return {
    ...toolPreferences(preferences),
    previousTool: null,
    chromeHidden: false,
    panel: null,
    selection: null,
    hasClipboardPixels: false,
    canUndo: false,
    canRedo: false,
    document,
    save,
  };
}

export function toolPreferences(state: ToolPreferences): ToolPreferences {
  const { tool, brushSize, primary, secondary, recent, gridEnabled } = state;
  return { tool, brushSize, primary, secondary, recent, gridEnabled };
}

export function selectTool(state: EditorState, tool: ToolKind): EditorState {
  return state.tool === tool ? state : { ...state, tool, previousTool: state.tool };
}

/**
 * Where an eyedropper pick leaves you. A mouse keeps the eyedropper, since Alt already covers
 * quick picks there. Touch and pen have no Alt, so a pick is one-shot and hands you back the
 * tool you came from, or the pencil when there isn't one.
 */
export function finishPick(state: EditorState, pointer: PointerKind): EditorState {
  if (pointer === 'mouse' || state.tool !== 'eyedropper') return state;
  return selectTool(state, state.previousTool ?? 'pencil');
}

export function stepBrush(state: EditorState, direction: -1 | 1): EditorState {
  const brushSize = stepBrushSize(state.brushSize, direction);
  return brushSize === state.brushSize ? state : { ...state, brushSize };
}

/** Choosing a color for a slot. Only the primary feeds recents: it's what you paint with. */
export function chooseColor(state: EditorState, color: PackedColor, slot: ColorSlot): EditorState {
  if (slot === 'secondary')
    return state.secondary === color ? state : { ...state, secondary: color };
  if (state.primary === color) return state;
  return { ...state, primary: color };
}

/** Recents record colors that actually reached the canvas, not every picker drag. */
export function recordPaintedColor(state: EditorState, color: PackedColor): EditorState {
  const recent = rememberColor(state.recent, color);
  return recent === state.recent ? state : { ...state, recent };
}

export function swapColors(state: EditorState): EditorState {
  return { ...state, primary: state.secondary, secondary: state.primary };
}

export function openPanel(state: EditorState, panel: EditorPanel | null): EditorState {
  return state.panel === panel ? state : { ...state, panel };
}
