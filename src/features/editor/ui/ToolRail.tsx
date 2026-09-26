import * as stylex from '@stylexjs/stylex';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import { Eraser, PaintBucket, Pencil, Pipette, Slash, SquareDashed } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { ToolKind } from '../../tools';
import { TOOLS } from '../core/tools';
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
  tool: ToolKind;
  onSelect: (tool: ToolKind) => void;
  orientation: 'vertical' | 'horizontal';
  /** Touch layouts skip hover tooltips: there's no hover to reveal them. */
  hasTooltips: boolean;
}

/**
 * A radio group rather than Astryx's ToggleButtonGroup: the selected tool is the
 * loudest thing in the chrome, so it gets an accent fill and roving arrow keys.
 */
export function ToolRail({ tool, onSelect, orientation, hasTooltips }: ToolRailProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent) => {
    const index = TOOLS.findIndex((info) => info.kind === tool);
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
          ? TOOLS.length - 1
          : step
            ? (index + step + TOOLS.length) % TOOLS.length
            : -1;
    if (target < 0) return;
    event.preventDefault();
    onSelect(TOOLS[target]!.kind);
    buttons.current[target]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Tools"
      aria-orientation={orientation}
      onKeyDown={onKeyDown}
      {...stylex.props(styles.rail, orientation === 'vertical' && styles.vertical)}
    >
      {TOOLS.map((info, index) => {
        const Icon = ICONS[info.kind];
        const selected = info.kind === tool;
        const button = (
          <button
            key={info.kind}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={info.label}
            aria-keyshortcuts={info.key.toUpperCase()}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(info.kind)}
            {...stylex.props(styles.tool, selected && styles.selected)}
          >
            <Icon size={18} strokeWidth={1.75} aria-hidden />
          </button>
        );
        if (!hasTooltips) return button;
        return (
          <Tooltip
            key={info.kind}
            content={`${info.label}  ·  ${info.key.toUpperCase()}`}
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

const styles = stylex.create({
  rail: { display: 'flex', gap: 2 },
  vertical: { flexDirection: 'column' },
  tool: {
    width: pixelVars.tool,
    height: pixelVars.tool,
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
  selected: {
    color: colorVars['--color-on-accent'],
    backgroundColor: {
      default: colorVars['--color-accent'],
      '@media (hover: hover)': { ':hover': colorVars['--color-accent'] },
    },
  },
});
