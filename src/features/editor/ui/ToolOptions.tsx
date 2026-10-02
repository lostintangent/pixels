import * as stylex from '@stylexjs/stylex';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Slider } from '@astryxdesign/core/Slider';
import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useEffect } from 'react';
import { BRUSH_SIZES, brushSizeAt, brushSizeIndex } from '../core/brush';
import { shapeInfo, toolInfo, usesBrush } from '../core/tools';
import type { Layout } from '../session/session';
import { ToolActions } from './dialogs';
import { useEditor, useEditorState } from './EditorContext';
import { pixelVars } from './tokens.stylex';

// Hints follow the pointer, not the layout: a tablet in the desktop layout taps.
const HINTS = {
  mouse: {
    fill: 'Click to fill touching pixels of one color',
    eyedropper: 'Click to pick a color  ·  Hold Alt from any tool',
    select: 'Drag to select  ·  Drag inside to move',
  },
  touch: {
    fill: 'Tap to fill touching pixels',
    eyedropper: 'Tap a pixel to pick its color',
    select: 'Drag to select, then drag inside to move',
  },
} as const;

/** The contextual strip: brush size, selection actions, or a one-line hint. */
export function ToolOptions({ layout }: { layout: Layout }) {
  const session = useEditor();
  const tool = useEditorState((state) => state.tool);
  const brushSize = useEditorState((state) => state.brushSize);
  const shapeKind = useEditorState((state) => state.shapeKind);
  const shapeWidth = useEditorState((state) => state.shapeWidth);
  const selection = useEditorState((state) => state.selection);
  const selectedShape = useEditorState((state) => state.selectedShape);
  const phone = layout === 'phone';
  const selects = tool === 'select' || tool === 'shapes';
  useEffect(() => {
    if (selects) ToolActions.preload();
  }, [selects]);

  /*
   * Shapes reuse the brush's size ladder, relabeled Width. With nothing selected it sets the next
   * shape's stroke. With a shape selected it restyles that shape, beside the shape's actions.
   */
  if (tool === 'shapes' || selectedShape || usesBrush(tool)) {
    const shapes = tool === 'shapes' || selectedShape !== null;
    const size = shapes ? shapeWidth : brushSize;
    return (
      <div
        key={selectedShape ? 'shape' : shapes ? 'shapes' : 'brush'}
        {...stylex.props(styles.body, phone && styles.fill)}
      >
        {!phone && (
          <span {...stylex.props(styles.label)}>
            {shapes ? shapeInfo(selectedShape?.kind ?? shapeKind).label : toolInfo(tool).label}
          </span>
        )}
        {!phone && !selectedShape && (
          <span {...stylex.props(styles.hint)}>{shapes ? 'Width' : 'Size'}</span>
        )}
        <div {...stylex.props(styles.slider, phone && styles.fill)}>
          <Slider
            label={shapes ? 'Stroke width' : 'Brush size'}
            isLabelHidden
            valueDisplay="none"
            value={brushSizeIndex(size)}
            min={0}
            max={BRUSH_SIZES.length - 1}
            step={1}
            formatValue={(index) => `${brushSizeAt(index)} px`}
            onChange={(index: number) =>
              shapes
                ? session.setShapeWidth(brushSizeAt(index))
                : session.setBrushSize(brushSizeAt(index))
            }
          />
        </div>
        <span {...stylex.props(styles.number)}>{size} px</span>
        {!phone && !selectedShape && (
          <span {...stylex.props(styles.keys)} aria-hidden>
            <Kbd keys="[" />
            <Kbd keys="]" />
          </span>
        )}
        {selectedShape && <ToolActions when kind="shape" phone={phone} />}
      </div>
    );
  }

  if (tool === 'select' && selection) {
    return (
      <div key="selection" {...stylex.props(styles.body, phone && styles.fill)}>
        {!phone && <span {...stylex.props(styles.label)}>Selection</span>}
        <span {...stylex.props(styles.number, styles.muted, phone && styles.fill)}>
          {selection.width} × {selection.height}
          {!phone && `  at ${selection.x}, ${selection.y}`}
        </span>
        <ToolActions when kind="selection" phone={phone} />
      </div>
    );
  }

  if (tool === 'select') {
    return (
      <div key="select" {...stylex.props(styles.body, phone && styles.fill)}>
        {!phone && <span {...stylex.props(styles.label)}>Select</span>}
        {phone ? (
          <span {...stylex.props(styles.hint, styles.fill)}>Drag to select</span>
        ) : (
          <Hint kind="select" />
        )}
        <ToolActions when kind="select" phone={phone} />
      </div>
    );
  }

  const kind = tool as Exclude<keyof (typeof HINTS)['mouse'], 'select'>;
  return (
    <div key={tool} {...stylex.props(styles.body, phone && styles.fill)}>
      {!phone && <span {...stylex.props(styles.label)}>{toolInfo(kind).label}</span>}
      {phone ? (
        <span {...stylex.props(styles.hint)}>{HINTS.touch[kind]}</span>
      ) : (
        <Hint kind={kind} />
      )}
    </div>
  );
}

/** Hints follow the pointer inside the desktop layout, so both render and CSS picks one. */
function Hint({ kind }: { kind: keyof (typeof HINTS)['mouse'] }) {
  return (
    <>
      <span {...stylex.props(styles.hint, styles.mouseOnly)}>{HINTS.mouse[kind]}</span>
      <span {...stylex.props(styles.hint, styles.touchOnly)}>{HINTS.touch[kind]}</span>
    </>
  );
}

const COARSE = '@media (pointer: coarse)';

const fade = stylex.keyframes({
  from: { opacity: 0, transform: 'translateY(2px)' },
  to: { opacity: 1, transform: 'none' },
});

const styles = stylex.create({
  body: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minWidth: 0,
    animationName: fade,
    animationDuration: {
      default: durationVars['--duration-fast'],
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    animationTimingFunction: pixelVars.ease,
  },
  fill: { flex: 1, minWidth: 0 },
  label: { fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' },
  hint: {
    fontSize: 13,
    color: colorVars['--color-text-secondary'],
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  slider: { width: 148 },
  number: {
    fontSize: 13,
    fontVariantNumeric: 'tabular-nums',
    minWidth: 40,
    textAlign: 'right',
    whiteSpace: 'nowrap',
  },
  muted: { color: colorVars['--color-text-secondary'], textAlign: 'left', minWidth: 0 },
  keys: { display: { default: 'flex', [COARSE]: 'none' }, gap: 4 },
  mouseOnly: { display: { default: null, [COARSE]: 'none' } },
  touchOnly: { display: { default: 'none', [COARSE]: 'block' } },
});
