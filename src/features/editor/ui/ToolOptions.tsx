import * as stylex from '@stylexjs/stylex';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Slider } from '@astryxdesign/core/Slider';
import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { Copy, CopyPlus, Scissors, Trash2, X } from 'lucide-react';
import { BRUSH_SIZES, brushSizeAt, brushSizeIndex } from '../core/brush';
import { toolInfo, usesBrush } from '../core/tools';
import type { Layout } from '../session/session';
import { useEditor, useEditorState } from './EditorContext';
import { copyFromChrome } from './files/useClipboard';
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

type SelectionRun = 'all' | 'clear' | 'commit' | 'duplicate' | 'paste';

/** The contextual strip: brush size, selection actions, or a one-line hint. */
export function ToolOptions({ layout }: { layout: Layout }) {
  const session = useEditor();
  const tool = useEditorState((state) => state.tool);
  const brushSize = useEditorState((state) => state.brushSize);
  const selection = useEditorState((state) => state.selection);
  const canPaste = useEditorState((state) => state.hasClipboardPixels);
  const run = (action: SelectionRun) => session.run({ type: 'selection', action });
  const phone = layout === 'phone';
  const tooltip = (text: string) => (phone ? undefined : text);

  if (usesBrush(tool)) {
    return (
      <div key="brush" {...stylex.props(styles.body, phone && styles.fill)}>
        {!phone && <span {...stylex.props(styles.label)}>{toolInfo(tool).label}</span>}
        {!phone && <span {...stylex.props(styles.hint)}>Size</span>}
        <div {...stylex.props(styles.slider, phone && styles.fill)}>
          <Slider
            label="Brush size"
            isLabelHidden
            valueDisplay="none"
            value={brushSizeIndex(brushSize)}
            min={0}
            max={BRUSH_SIZES.length - 1}
            step={1}
            formatValue={(index) => `${brushSizeAt(index)} px`}
            onChange={(index: number) => session.setBrushSize(brushSizeAt(index))}
          />
        </div>
        <span {...stylex.props(styles.number)}>{brushSize} px</span>
        {!phone && (
          <span {...stylex.props(styles.keys)} aria-hidden>
            <Kbd keys="[" />
            <Kbd keys="]" />
          </span>
        )}
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
        {!phone && <span aria-hidden {...stylex.props(styles.divider)} />}
        <IconButton
          variant="ghost"
          label="Copy"
          tooltip={tooltip('Copy  ·  ⌘C')}
          icon={<Copy size={18} />}
          onClick={() => copyFromChrome(session, 'copy')}
        />
        <IconButton
          variant="ghost"
          label="Cut"
          tooltip={tooltip('Cut  ·  ⌘X')}
          icon={<Scissors size={18} />}
          onClick={() => copyFromChrome(session, 'cut')}
        />
        <IconButton
          variant="ghost"
          label="Duplicate"
          tooltip={tooltip('Duplicate in place')}
          icon={<CopyPlus size={18} />}
          onClick={() => run('duplicate')}
        />
        <IconButton
          variant="ghost"
          label="Clear pixels"
          tooltip={tooltip('Clear  ·  Delete')}
          icon={<Trash2 size={18} />}
          onClick={() => run('clear')}
        />
        {phone ? (
          <IconButton
            variant="ghost"
            label="Deselect"
            icon={<X size={20} />}
            onClick={() => run('commit')}
          />
        ) : (
          <Button
            variant="ghost"
            label="Deselect"
            tooltip="Deselect  ·  Enter"
            onClick={() => run('commit')}
          />
        )}
      </div>
    );
  }

  // Touch has no ⌘A or ⌘V, so Select offers both. Paste waits until there's something to paste.
  if (tool === 'select') {
    return (
      <div key="select" {...stylex.props(styles.body, phone && styles.fill)}>
        {!phone && <span {...stylex.props(styles.label)}>Select</span>}
        {phone ? (
          <span {...stylex.props(styles.hint, styles.fill)}>Drag to select</span>
        ) : (
          <Hint kind="select" />
        )}
        {!phone && <span aria-hidden {...stylex.props(styles.divider)} />}
        <Button
          variant="ghost"
          label="Select all"
          tooltip={tooltip('Select all  ·  ⌘A')}
          onClick={() => run('all')}
        />
        {canPaste && (
          <Button
            variant="ghost"
            label="Paste"
            tooltip={tooltip('Paste  ·  ⌘V')}
            onClick={() => run('paste')}
          />
        )}
      </div>
    );
  }

  const kind = tool as Exclude<keyof (typeof HINTS)['mouse'], 'select'>;
  return (
    <div key={tool} {...stylex.props(styles.body, phone && styles.fill)}>
      {!phone && <span {...stylex.props(styles.label)}>{toolInfo(tool).label}</span>}
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
  divider: { width: 1, height: 20, marginInline: 2, backgroundColor: colorVars['--color-border'] },
});
