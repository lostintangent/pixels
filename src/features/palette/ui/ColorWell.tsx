import * as stylex from '@stylexjs/stylex';
import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import type { Ref } from 'react';
import type { PackedColor } from '../../document';
import { formatColor, toCss } from '../core/color';
import type { SwatchSlot } from './Swatches';

export interface ColorWellProps {
  primary: PackedColor;
  secondary: PackedColor;
  onEdit: (slot: SwatchSlot) => void;
  onSwap: () => void;
  /** 44px for touch layouts. */
  size?: 'md' | 'lg';
  ref?: Ref<HTMLDivElement>;
}

/** Overlapping primary and secondary chips with a swap corner, sized like a tool button. */
export function ColorWell({
  primary,
  secondary,
  onEdit,
  onSwap,
  size = 'md',
  ref,
}: ColorWellProps) {
  const large = size === 'lg';
  return (
    <div ref={ref} {...stylex.props(styles.well, large && styles.wellLarge)}>
      <button
        type="button"
        aria-label={`Secondary color, ${formatColor(secondary)}`}
        onClick={() => onEdit('secondary')}
        {...stylex.props(
          styles.chip,
          large && styles.chipLarge,
          styles.secondary,
          styles.fill(toCss(secondary)),
        )}
      />
      <button
        type="button"
        aria-label={`Primary color, ${formatColor(primary)}`}
        onClick={() => onEdit('primary')}
        {...stylex.props(
          styles.chip,
          large && styles.chipLarge,
          styles.primary,
          styles.fill(toCss(primary)),
        )}
      />
      <button
        type="button"
        aria-label="Swap colors"
        title="Swap colors  ·  X"
        onClick={onSwap}
        {...stylex.props(styles.swap, large && styles.swapLarge)}
      >
        <SwapGlyph size={large ? 12 : 10} />
      </button>
    </div>
  );
}

/** The conventional corner arrow for swapping foreground and background colors. */
function SwapGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" aria-hidden>
      <path
        d="M1.5 3.5h3.5a1.5 1.5 0 0 1 1.5 1.5v3.5M3.25 1.75 1.5 3.5l1.75 1.75M4.75 6.75 6.5 8.5l1.75-1.75"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const chipRing = `0 0 0 1.5px ${colorVars['--color-background-surface']}, 0 0 0 2.5px ${colorVars['--color-border-emphasized']}`;
const chipFocus = `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`;

const styles = stylex.create({
  well: { position: 'relative', width: 36, height: 36, flexShrink: 0, marginBlock: 2 },
  wellLarge: { width: 44, height: 44, marginBlock: 0 },
  chip: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 0,
    padding: 0,
    cursor: 'pointer',
    outline: 'none',
    boxShadow: { default: chipRing, ':focus-visible': chipFocus },
    transform: { default: null, ':active': 'scale(0.94)' },
    transitionProperty: 'transform, box-shadow',
    transitionDuration: durationVars['--duration-fast'],
  },
  chipLarge: { width: 26, height: 26, borderRadius: 7 },
  primary: { left: 2, top: 2, zIndex: 1 },
  secondary: { right: 2, bottom: 2 },
  fill: (css: string) => ({ backgroundColor: css }),
  swap: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: 13,
    height: 13,
    padding: 0,
    borderWidth: 0,
    borderRadius: 4,
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    backgroundColor: 'transparent',
    color: {
      default: colorVars['--color-text-secondary'],
      ':hover': colorVars['--color-text-primary'],
    },
    outline: {
      default: 'none',
      ':focus-visible': `2px solid ${colorVars['--color-text-primary']}`,
    },
  },
  // Expand the hit area for fingers without growing the glyph.
  swapLarge: { width: 16, height: 16 },
});
