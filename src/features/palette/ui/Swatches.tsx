import * as stylex from '@stylexjs/stylex';
import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { PackedColor } from '../../document';
import { formatColor, toCss } from '../core/color';

export type SwatchSlot = 'primary' | 'secondary';

export interface SwatchesProps {
  label: string;
  colors: readonly PackedColor[];
  /** Empty cells pad the grid so recents keep their shape before they fill. */
  slots?: number;
  primary: PackedColor | null;
  secondary?: PackedColor | null;
  onChoose: (color: PackedColor, slot: SwatchSlot) => void;
  size?: 'md' | 'lg';
}

const COLUMNS = 8;
const COARSE = '@media (pointer: coarse)';

/** A grid of color chips with roving focus. Click sets primary; right click sets secondary. */
export function Swatches({
  label,
  colors,
  slots = colors.length,
  primary,
  secondary = null,
  onChoose,
  size = 'md',
}: SwatchesProps) {
  const [focused, setFocused] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const empty = Math.max(0, slots - colors.length);
  const selected = primary === null ? -1 : colors.indexOf(primary);
  const tabStop =
    colors.length === 0
      ? -1
      : selected >= 0 && focused === 0
        ? selected
        : Math.min(focused, colors.length - 1);

  const onKeyDown = (event: KeyboardEvent) => {
    const delta = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -COLUMNS,
      ArrowDown: COLUMNS,
      Home: -Infinity,
      End: Infinity,
    }[event.key];
    if (delta === undefined || colors.length === 0) return;
    event.preventDefault();
    const next = Math.min(colors.length - 1, Math.max(0, tabStop + delta));
    setFocused(next);
    grid.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };

  return (
    <div
      ref={grid}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      {...stylex.props(styles.grid, size === 'lg' && styles.gridLarge)}
    >
      {colors.map((color, index) => {
        const isPrimary = color === primary;
        const isSecondary = !isPrimary && color === secondary;
        const name = formatColor(color);
        return (
          <button
            key={`${color}-${index}`}
            type="button"
            tabIndex={index === tabStop ? 0 : -1}
            aria-label={name}
            aria-pressed={isPrimary}
            title={name}
            onFocus={() => setFocused(index)}
            onClick={() => onChoose(color, 'primary')}
            onContextMenu={(event) => {
              event.preventDefault();
              onChoose(color, 'secondary');
            }}
            {...stylex.props(
              styles.swatch,
              size === 'lg' && styles.swatchLarge,
              styles.fill(toCss(color)),
              isPrimary && styles.primary,
            )}
          >
            {isSecondary && <span aria-hidden {...stylex.props(styles.secondaryDot)} />}
          </button>
        );
      })}
      {Array.from({ length: empty }, (_, index) => (
        <span
          key={`empty-${index}`}
          aria-hidden
          {...stylex.props(styles.swatch, size === 'lg' && styles.swatchLarge, styles.empty)}
        />
      ))}
    </div>
  );
}

const ring = `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`;
const focusRing = `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-secondary']}`;

const styles = stylex.create({
  grid: {
    display: 'grid',
    gridTemplateColumns: {
      default: `repeat(${COLUMNS}, 24px)`,
      [COARSE]: `repeat(${COLUMNS}, 38px)`,
    },
    justifyContent: 'space-between',
    rowGap: { default: 4, [COARSE]: 6 },
  },
  gridLarge: { gridTemplateColumns: `repeat(${COLUMNS}, 38px)`, rowGap: 8 },
  swatch: {
    position: 'relative',
    width: { default: 24, [COARSE]: 38 },
    height: { default: 24, [COARSE]: 38 },
    borderRadius: { default: 6, [COARSE]: 9 },
    borderWidth: 0,
    padding: 0,
    cursor: 'pointer',
    outline: 'none',
    boxShadow: {
      default: 'inset 0 0 0 1px light-dark(#0000001a, #ffffff2e)',
      ':focus-visible': focusRing,
    },
    transform: {
      default: null,
      '@media (hover: hover)': { ':hover': 'scale(1.08)' },
      ':active': 'scale(0.96)',
    },
    // On touch the target spans the gap too, so the 44px pitch is all hit area.
    '::before': {
      content: { default: null, [COARSE]: "''" },
      position: 'absolute',
      inset: -3,
    },
    transitionProperty: 'box-shadow, transform',
    transitionDuration: durationVars['--duration-fast'],
    transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  swatchLarge: { width: 38, height: 38, borderRadius: 9 },
  fill: (css: string) => ({ backgroundColor: css }),
  primary: {
    boxShadow: { default: ring, ':focus-visible': ring },
  },
  secondaryDot: {
    position: 'absolute',
    right: 3,
    bottom: 3,
    width: 6,
    height: 6,
    borderRadius: '50%',
    backgroundColor: colorVars['--color-background-surface'],
    boxShadow: `0 0 0 1px ${colorVars['--color-border-emphasized']}`,
  },
  empty: {
    cursor: 'default',
    backgroundColor: 'transparent',
    boxShadow: `inset 0 0 0 1px ${colorVars['--color-border']}`,
    transform: { default: null, '@media (hover: hover)': { ':hover': null }, ':active': null },
  },
});
