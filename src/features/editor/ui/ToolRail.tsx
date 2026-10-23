import * as stylex from '@stylexjs/stylex';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import { Eraser, PaintBucket, Pencil, Pipette, Slash, SquareDashed } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import type { KeyboardEvent, Ref } from 'react';
import { keepFocusOnPress } from '../../../shared/react/pressFocus';
import type { ToolKind } from '../../tools';
import { shapeInfo, TOOLS } from '../core/tools';
import type { EditorTool, ShapeKind } from '../core/tools';
import { SHAPE_ICONS } from './ShapeIcons';
import { pixelVars } from './tokens.stylex';

const ICONS: Record<ToolKind, LucideIcon> = {
  pencil: Pencil,
  eraser: Eraser,
  fill: PaintBucket,
  eyedropper: Pipette,
  line: Slash,
  select: SquareDashed,
};

export interface ToolRailProps {
  tool: EditorTool;
  /** Arrow keys arm the Shapes item with `'shapes'` like any other tool. */
  onSelect: (tool: EditorTool) => void;
  orientation: 'vertical' | 'horizontal';
  /** Touch layouts skip hover tooltips: there's no hover to reveal them. */
  hasTooltips: boolean;
  /** The Shapes item's icon and tooltip follow the last shape used. */
  shapeKind: ShapeKind;
  /** A press on the Shapes item, which arms it and toggles the popover. */
  onShapesPress: () => void;
  /** Anchors the Shapes popover. */
  shapesRef?: Ref<HTMLButtonElement>;
}

interface RailItem {
  kind: EditorTool;
  label: string;
  /** What the tooltip names: the tool, or the shape the Shapes item will draw. */
  tip: string;
  keys: string;
  Icon: LucideIcon;
}

function railItems(shapeKind: ShapeKind): RailItem[] {
  const items: RailItem[] = TOOLS.map((info) => ({
    kind: info.kind,
    label: info.label,
    tip: `${info.label}  ·  ${info.key.toUpperCase()}`,
    keys: info.key.toUpperCase(),
    Icon: ICONS[info.kind],
  }));
  const shape = shapeInfo(shapeKind);
  items.push({
    kind: 'shapes',
    label: 'Shapes',
    tip: `${shape.label}  ·  ${shape.key.toUpperCase()}`,
    keys: 'R A',
    Icon: SHAPE_ICONS[shapeKind],
  });
  return items;
}

/**
 * A radio group rather than Astryx's ToggleButtonGroup: the selected tool is the
 * loudest thing in the chrome, so it gets an accent fill and roving arrow keys.
 */
export function ToolRail({
  tool,
  onSelect,
  orientation,
  hasTooltips,
  shapeKind,
  onShapesPress,
  shapesRef,
}: ToolRailProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const items = railItems(shapeKind);
  const onKeyDown = (event: KeyboardEvent) => {
    const index = items.findIndex((info) => info.kind === tool);
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : step
            ? (index + step + items.length) % items.length
            : -1;
    if (target < 0) return;
    event.preventDefault();
    onSelect(items[target]!.kind);
    buttons.current[target]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Tools"
      aria-orientation={orientation}
      onKeyDown={onKeyDown}
      {...stylex.props(
        styles.rail,
        orientation === 'vertical' ? styles.vertical : styles.horizontal,
      )}
    >
      {items.map((info, index) => {
        const { Icon } = info;
        const selected = info.kind === tool;
        const shapes = info.kind === 'shapes';
        const button = (
          <button
            key={info.kind}
            ref={(node) => {
              buttons.current[index] = node;
              if (shapes) assignRef(shapesRef, node);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={info.label}
            aria-keyshortcuts={info.keys}
            tabIndex={selected ? 0 : -1}
            onMouseDown={keepFocusOnPress}
            onClick={() => (shapes ? onShapesPress() : onSelect(info.kind))}
            {...stylex.props(
              styles.tool,
              orientation === 'horizontal' ? styles.dockTool : styles.railTool,
              selected && styles.selected,
            )}
          >
            <Icon size={18} strokeWidth={1.75} aria-hidden />
            {/* A corner nub says there's more inside, like a Figma or Photoshop tool group. */}
            {shapes && <span aria-hidden {...stylex.props(styles.nub)} />}
          </button>
        );
        if (!hasTooltips) return button;
        return (
          <Tooltip
            key={info.kind}
            content={info.tip}
            placement={orientation === 'vertical' ? 'end' : 'above'}
            hasHoverIndication={false}
            delay={400}
          >
            {button}
          </Tooltip>
        );
      })}
    </div>
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

const FORCED = '@media (forced-colors: active)';

// Matches the dock's slim arrangement in EditorShell.
const SLIM = '@media (max-width: 387.98px) and (orientation: portrait)';

const styles = stylex.create({
  rail: { display: 'flex' },
  // On a short desktop window the rail's tools give up height, down to a 26px target, so the whole
  // rail and its color well stay between the header and the bottom edge.
  vertical: { flexDirection: 'column', gap: 2, minHeight: 0, flexShrink: 1 },
  railTool: { flexShrink: 1, minHeight: 26 },
  // The phone dock holds seven tools and the color well. Targets abut with no gap, so the whole
  // row is tappable. On a slim phone the well moves up and the tools spread across the row,
  // giving up a little width only below 344px.
  horizontal: {
    gap: 0,
    minWidth: 0,
    flexGrow: { default: null, [SLIM]: 1 },
    justifyContent: { default: null, [SLIM]: 'space-between' },
  },
  tool: {
    width: pixelVars.tool,
    height: pixelVars.tool,
    position: 'relative',
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: 10,
    cursor: 'pointer',
    color: colorVars['--color-text-primary'],
    // Hover only where it exists, so a tap never leaves a tool looking hovered.
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': colorVars['--color-overlay-hover'] },
    },
    outline: {
      default: 'none',
      ':focus-visible': `2px solid ${colorVars['--color-text-primary']}`,
    },
    outlineOffset: 1,
    transform: { default: null, ':active': 'scale(0.94)' },
    transitionProperty: 'background-color, color, transform',
    transitionDuration: durationVars['--duration-fast'],
    transitionTimingFunction: pixelVars.ease,
  },
  nub: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    width: 0,
    height: 0,
    borderStyle: 'solid',
    borderWidth: '0 0 4px 4px',
    borderColor: 'transparent transparent currentColor transparent',
    opacity: 0.5,
    pointerEvents: 'none',
  },
  dockTool: { flexShrink: 1, minWidth: 40 },
  selected: {
    color: { default: colorVars['--color-on-accent'], [FORCED]: 'HighlightText' },
    backgroundColor: {
      default: colorVars['--color-accent'],
      '@media (hover: hover)': { ':hover': colorVars['--color-accent'] },
      [FORCED]: 'Highlight',
    },
  },
});
