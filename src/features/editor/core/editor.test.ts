import { describe, expect, test } from 'bun:test';
import { packRgba } from '../../document';
import { BRUSH_SIZES, brushSizeAt, brushSizeIndex, stepBrushSize } from './brush';
import { resolveShortcut } from './shortcuts';
import type { KeyPress } from './shortcuts';
import {
  chooseColor,
  finishPick,
  initialEditorState,
  recordPaintedColor,
  selectShape,
  selectTool,
  stepBrush,
  swapColors,
  toolPreferences,
} from './state';
import { defaultShapeWidth } from './tools';
import { displayZoom, formatZoom } from './zoom';

const press = (key: string, modifiers: Partial<KeyPress> = {}): KeyPress => ({
  key,
  mod: false,
  shift: false,
  alt: false,
  ...modifiers,
});
const idle = { hasSelection: false };
const selecting = { hasSelection: true };
const shaping = { hasSelection: false, hasShapeSelection: true };

describe('brush ladder', () => {
  test('gives every size from 1 to 4 px its own step', () => {
    expect(BRUSH_SIZES.slice(0, 4)).toEqual([1, 2, 3, 4]);
  });

  test('steps up and down and clamps at the ends', () => {
    expect(stepBrushSize(1, 1)).toBe(2);
    expect(stepBrushSize(16, 1)).toBe(24);
    expect(stepBrushSize(16, -1)).toBe(12);
    expect(stepBrushSize(1, -1)).toBe(1);
    expect(stepBrushSize(64, 1)).toBe(64);
  });

  test('snaps an off-ladder size to its neighbors', () => {
    expect(stepBrushSize(7, -1)).toBe(6);
    expect(stepBrushSize(7, 1)).toBe(8);
    expect(brushSizeIndex(7)).toBe(5);
  });

  test('maps slider indices to sizes', () => {
    expect(brushSizeAt(0)).toBe(1);
    expect(brushSizeAt(99)).toBe(64);
    expect(brushSizeAt(-3)).toBe(1);
  });
});

describe('zoom label', () => {
  test('names a fitted whole zoom exactly and quantizes a moving pinch', () => {
    expect(displayZoom({ zoom: 22, fittedZoom: 22 }, 1)).toBe(22);
    expect(displayZoom({ zoom: 11, fittedZoom: 11 }, 1)).toBe(11);
    expect(displayZoom({ zoom: 21.8 }, 1)).toBe(24);
    expect(displayZoom({ zoom: 7 }, 1)).toBe(8);
    // A pinch near a 62% floor reads as the floor it will settle on, never a step below it.
    expect(displayZoom({ zoom: 0.65 }, 0.62)).toBe(0.62);
    expect(displayZoom({ zoom: 0.58 }, 0.62)).toBe(0.62);
    expect(displayZoom({ zoom: 0.9 }, 0.62)).toBe(1);
  });
  test('a pinch that began at a fit names that fit while it is the nearest place to rest', () => {
    // An uneven two-finger pan at a phone sprite's 11× fit, and a small trackpad pinch at 17×.
    expect(displayZoom({ zoom: 11.2, fittedZoom: 11 }, 1)).toBe(11);
    expect(displayZoom({ zoom: 17.5, fittedZoom: 17 }, 1)).toBe(17);
    expect(displayZoom({ zoom: 16.6, fittedZoom: 17 }, 1)).toBe(17);
    // Far enough away, the label moves on to the step the pinch will land on.
    expect(displayZoom({ zoom: 11.88, fittedZoom: 11 }, 1)).toBe(12);
    expect(displayZoom({ zoom: 15, fittedZoom: 11 }, 1)).toBe(16);
  });
  test('uses a multiplier at and above 1×', () => {
    expect(formatZoom(1)).toBe('1×');
    expect(formatZoom(24)).toBe('24×');
  });

  test('uses a percentage below 1×', () => {
    expect(formatZoom(0.5)).toBe('50%');
    expect(formatZoom(1 / 8)).toBe('12.5%');
  });
});

describe('shortcuts', () => {
  test('select tools by letter', () => {
    expect(resolveShortcut(press('b'), idle)).toEqual({ type: 'tool', tool: 'pencil' });
    expect(resolveShortcut(press('M'), idle)).toEqual({ type: 'tool', tool: 'select' });
  });

  test('arm shapes by letter', () => {
    expect(resolveShortcut(press('r'), idle)).toEqual({ type: 'shape-tool', kind: 'rectangle' });
    expect(resolveShortcut(press('A'), idle)).toEqual({ type: 'shape-tool', kind: 'arrow' });
    expect(resolveShortcut(press('a', { shift: true }), idle)).toBeNull();
  });

  test('act on a selected shape', () => {
    for (const key of ['Escape', 'Enter'])
      expect(resolveShortcut(press(key), shaping)).toEqual({ type: 'shape', action: 'deselect' });
    for (const key of ['Delete', 'Backspace'])
      expect(resolveShortcut(press(key), shaping)).toEqual({ type: 'shape', action: 'delete' });
    expect(resolveShortcut(press('d', { mod: true }), shaping)).toEqual({
      type: 'shape',
      action: 'duplicate',
    });
    expect(resolveShortcut(press('ArrowLeft', { shift: true }), shaping)).toEqual({
      type: 'nudge',
      dx: -10,
      dy: 0,
    });
    expect(resolveShortcut(press('ArrowUp'), { ...shaping, gesturing: true })).toBeNull();
  });

  test('⌘D still deselects pixels and does nothing with no selection', () => {
    expect(resolveShortcut(press('d', { mod: true }), selecting)).toEqual({
      type: 'selection',
      action: 'cancel',
    });
    expect(resolveShortcut(press('d', { mod: true }), idle)).toBeNull();
    expect(resolveShortcut(press('Delete'), idle)).toBeNull();
  });

  test('cover colors, brush size, and zoom', () => {
    expect(resolveShortcut(press('x'), idle)).toEqual({ type: 'swap-colors' });
    expect(resolveShortcut(press('['), idle)).toEqual({ type: 'brush-size', direction: -1 });
    expect(resolveShortcut(press(']'), idle)).toEqual({ type: 'brush-size', direction: 1 });
    expect(resolveShortcut(press('0'), idle)).toEqual({ type: 'zoom-fit' });
    expect(resolveShortcut(press('1'), idle)).toEqual({ type: 'zoom-actual' });
    expect(resolveShortcut(press('=', { mod: true }), idle)).toEqual({
      type: 'zoom',
      direction: 1,
    });
    expect(resolveShortcut(press('-', { mod: true }), idle)).toEqual({
      type: 'zoom',
      direction: -1,
    });
    expect(resolveShortcut(press("'", { mod: true }), idle)).toEqual({ type: 'toggle-grid' });
  });

  test('undo and redo', () => {
    expect(resolveShortcut(press('z', { mod: true }), idle)).toEqual({ type: 'undo' });
    expect(resolveShortcut(press('Z', { mod: true, shift: true }), idle)).toEqual({ type: 'redo' });
    expect(resolveShortcut(press('y', { mod: true }), idle)).toEqual({ type: 'redo' });
  });

  test('document commands avoid browser-reserved chords', () => {
    expect(resolveShortcut(press('n', { mod: true, alt: true }), idle)).toEqual({
      type: 'open',
      panel: 'new',
    });
    expect(resolveShortcut(press('n', { mod: true }), idle)).toBeNull();
    expect(resolveShortcut(press('e', { mod: true, shift: true }), idle)).toEqual({
      type: 'open',
      panel: 'export',
    });
    expect(resolveShortcut(press('c', { mod: true, alt: true }), idle)).toEqual({
      type: 'open',
      panel: 'resize',
    });
    expect(resolveShortcut(press('o', { mod: true }), idle)).toEqual({ type: 'open-file' });
  });

  test('selection keys only act on a selection', () => {
    for (const key of ['Escape', 'Enter', 'Delete', 'Backspace'])
      expect(resolveShortcut(press(key), idle)).toBeNull();
    expect(resolveShortcut(press('Escape'), selecting)).toEqual({
      type: 'selection',
      action: 'cancel',
    });
    expect(resolveShortcut(press('Enter'), selecting)).toEqual({
      type: 'selection',
      action: 'commit',
    });
    expect(resolveShortcut(press('Backspace'), selecting)).toEqual({
      type: 'selection',
      action: 'clear',
    });
    expect(resolveShortcut(press('c', { mod: true }), selecting)).toEqual({
      type: 'selection',
      action: 'copy',
    });
    expect(resolveShortcut(press('c', { mod: true }), idle)).toBeNull();
    expect(resolveShortcut(press('v', { mod: true }), idle)).toEqual({
      type: 'selection',
      action: 'paste',
    });
  });

  test('arrow keys nudge a selection 1 px, or 10 px with Shift', () => {
    expect(resolveShortcut(press('ArrowLeft'), selecting)).toEqual({
      type: 'nudge',
      dx: -1,
      dy: 0,
    });
    expect(resolveShortcut(press('ArrowRight'), selecting)).toEqual({
      type: 'nudge',
      dx: 1,
      dy: 0,
    });
    expect(resolveShortcut(press('ArrowUp'), selecting)).toEqual({ type: 'nudge', dx: 0, dy: -1 });
    expect(resolveShortcut(press('ArrowDown', { shift: true }), selecting)).toEqual({
      type: 'nudge',
      dx: 0,
      dy: 10,
    });
    expect(resolveShortcut(press('ArrowLeft', { shift: true }), selecting)).toEqual({
      type: 'nudge',
      dx: -10,
      dy: 0,
    });
  });

  test('arrow keys are left alone without a selection, mid-gesture, or with a modifier', () => {
    expect(resolveShortcut(press('ArrowLeft'), idle)).toBeNull();
    expect(resolveShortcut(press('ArrowLeft'), { hasSelection: true, gesturing: true })).toBeNull();
    expect(resolveShortcut(press('ArrowLeft', { alt: true }), selecting)).toBeNull();
    expect(resolveShortcut(press('ArrowLeft', { mod: true }), selecting)).toBeNull();
  });

  test('tab toggles chrome, shift-tab is left for focus', () => {
    expect(resolveShortcut(press('Tab'), idle)).toEqual({ type: 'toggle-chrome' });
    expect(resolveShortcut(press('Tab', { shift: true }), idle)).toBeNull();
  });

  test('ignores modified letters and unknown keys', () => {
    expect(resolveShortcut(press('b', { alt: true }), idle)).toBeNull();
    expect(resolveShortcut(press('B', { shift: true }), idle)).toBeNull();
    expect(resolveShortcut(press('q'), idle)).toBeNull();
  });
});

describe('editor state', () => {
  const base = initialEditorState({ name: 'Untitled', width: 32, height: 32 });
  const red = packRgba(255, 0, 0);

  test('keeps identity when nothing changes', () => {
    expect(selectTool(base, base.tool)).toBe(base);
    expect(chooseColor(base, base.primary, 'primary')).toBe(base);
    expect(stepBrush(base, -1)).toBe(base);
  });

  test('chooses and swaps colors', () => {
    const next = chooseColor(base, red, 'primary');
    expect(next.primary).toBe(red);
    expect(next.recent).toEqual([]);
    const swapped = swapColors(next);
    expect([swapped.primary, swapped.secondary]).toEqual([next.secondary, red]);
  });

  test('a mouse pick keeps the eyedropper', () => {
    const picking = selectTool(selectTool(base, 'fill'), 'eyedropper');
    expect(finishPick(picking, 'mouse')).toBe(picking);
  });

  test('a touch or pen pick returns to the tool before the eyedropper', () => {
    const picking = selectTool(selectTool(base, 'fill'), 'eyedropper');
    expect(finishPick(picking, 'touch').tool).toBe('fill');
    expect(finishPick(picking, 'pen').tool).toBe('fill');
  });

  test('a one-shot pick falls back to the pencil when there was no earlier tool', () => {
    const reloaded = initialEditorState({ name: 'Untitled', width: 8, height: 8 }, null, {
      ...toolPreferences(base),
      tool: 'eyedropper',
    });
    expect(reloaded.previousTool).toBeNull();
    expect(finishPick(reloaded, 'touch').tool).toBe('pencil');
  });

  test('finishing a temporary pick leaves other tools alone', () => {
    const drawing = selectTool(base, 'line');
    expect(finishPick(drawing, 'touch')).toBe(drawing);
  });

  test('picking a shape arms the Shapes tool and remembers the shape', () => {
    const arrow = selectShape(selectTool(base, 'fill'), 'arrow');
    expect([arrow.tool, arrow.previousTool, arrow.shapeKind]).toEqual(['shapes', 'fill', 'arrow']);
    expect(selectShape(arrow, 'arrow')).toBe(arrow);
    expect(selectTool(arrow, 'pencil').shapeKind).toBe('arrow');
  });

  test('brackets size the shape stroke while Shapes is armed and leave the brush alone', () => {
    const armed = { ...selectShape(base, 'rectangle'), shapeWidth: 6, brushSize: 2 };
    const wider = stepBrush(armed, 1);
    expect([wider.shapeWidth, wider.brushSize]).toEqual([8, 2]);
    expect(stepBrush(stepBrush(armed, -1), -1).shapeWidth).toBe(4);
  });

  test('each document starts with a stroke width that reads at fit', () => {
    expect(defaultShapeWidth(16, 16)).toBe(1);
    expect(defaultShapeWidth(1440, 900)).toBe(5);
    expect(defaultShapeWidth(1990, 1192)).toBe(6);
    expect(defaultShapeWidth(2980, 1860)).toBe(8);
    expect(defaultShapeWidth(4096, 4096)).toBe(12);
    const screenshot = initialEditorState({ name: 'Shot', width: 2980, height: 1860 }, null, {
      ...toolPreferences(base),
    });
    expect(screenshot.shapeWidth).toBe(8);
    expect(base.shapeWidth).toBe(1);
  });

  test('records painted colors as recents', () => {
    expect(recordPaintedColor(base, red).recent).toEqual([red]);
  });

  test('carries tool preferences into the next document and nothing else', () => {
    const working = {
      ...recordPaintedColor(chooseColor(selectTool(base, 'fill'), red, 'primary'), red),
      brushSize: 3,
      gridEnabled: false,
      selection: { x: 0, y: 0, width: 4, height: 4 },
      canUndo: true,
      panel: 'export' as const,
      save: 'saved' as const,
    };
    const next = initialEditorState(
      { name: 'Sprite', width: 16, height: 16 },
      null,
      toolPreferences(working),
    );
    expect(toolPreferences(next)).toEqual({
      tool: 'fill',
      brushSize: 3,
      shapeKind: 'rectangle',
      primary: red,
      secondary: base.secondary,
      recent: [red],
      gridEnabled: false,
    });
    expect([next.selection, next.canUndo, next.panel, next.save]).toEqual([
      null,
      false,
      null,
      null,
    ]);
  });
});
