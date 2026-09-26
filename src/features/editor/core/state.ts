import type { PackedColor, PixelRect } from '../../document';
import { DEFAULT_PALETTE, rememberColor } from '../../palette/model';
import type { PaletteState } from '../../palette/model';
import type { ToolKind } from '../../tools';
import { stepBrushSize } from './brush';

export type EditorPanel = 'new' | 'export' | 'resize' | 'colors';
export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';
export type ColorSlot = 'primary' | 'secondary';

export interface DocumentSummary {
  name: string;
  width: number;
  height: number;
}

/** Everything React renders. Pointer-rate state (hover, viewport pan) lives elsewhere. */
export interface EditorState extends PaletteState {
  tool: ToolKind;
  brushSize: number;
  gridEnabled: boolean;
  chromeHidden: boolean;
  panel: EditorPanel | null;
  selection: PixelRect | null;
  canUndo: boolean;
  canRedo: boolean;
  document: DocumentSummary;
  save: SaveStatus;
}

export function initialEditorState(document: DocumentSummary): EditorState {
  return {
    tool: 'pencil',
    brushSize: 1,
    primary: DEFAULT_PALETTE[11]!,
    secondary: DEFAULT_PALETTE[1]!,
    recent: [],
    gridEnabled: true,
    chromeHidden: false,
    panel: null,
    selection: null,
    canUndo: false,
    canRedo: false,
    document,
    save: 'saved',
  };
}

export function selectTool(state: EditorState, tool: ToolKind): EditorState {
  return state.tool === tool ? state : { ...state, tool };
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
