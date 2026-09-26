import * as stylex from '@stylexjs/stylex';
import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import type { Ref } from 'react';
import type { PackedColor } from '../../document';
import { formatColor, toCss } from '../core/color';
import { preloadColorPicker } from './deferred';
import type { SwatchSlot } from './Swatches';

export interface ColorWellProps {
  primary: PackedColor;
  secondary: PackedColor;
  onEdit: (slot: SwatchSlot) => void;
  onSwap: () => void;
  /** A press on the single touch target. Defaults to editing the primary. */
  onPress?: () => void;
  /**
   * `lg` is one 44px touch target. Three targets can't share 44px, so whatever it opens carries
   * the slot choice and swap. `md` becomes the same single target under a coarse pointer.
   */
  size?: 'md' | 'lg';
  ref?: Ref<HTMLDivElement>;
}

/** Overlapping primary and secondary chips with a swap corner, sized like a tool button. */
export function ColorWell({
  primary,
  secondary,
  onEdit,
  onSwap,
  onPress = () => onEdit('primary'),
  size = 'md',
  ref,
}: ColorWellProps) {
  if (size === 'lg') {
    return (
      <div ref={ref} {...stylex.props(styles.well, styles.wellLarge)}>
        <button
          type="button"
          aria-label={`Colors, primary ${formatColor(primary)}, secondary ${formatColor(secondary)}`}
          onClick={onPress}
          {...stylex.props(styles.target)}
        >
          <span
            {...stylex.props(
              styles.chip,
              styles.chipLarge,
              styles.secondary,
              styles.fill(toCss(secondary)),
            )}
          />
          <span
            {...stylex.props(
              styles.chip,
              styles.chipLarge,
              styles.primary,
              styles.fill(toCss(primary)),
            )}
          />
        </button>
      </div>
    );
  }
  return (
    <div ref={ref} onPointerEnter={preloadColorPicker} {...stylex.props(styles.well)}>
      <button
        type="button"
        aria-label={`Secondary color, ${formatColor(secondary)}`}
        onClick={() => onEdit('secondary')}
        {...stylex.props(styles.chip, styles.secondary, styles.fill(toCss(secondary)))}
      />
      <button
        type="button"
        aria-label={`Primary color, ${formatColor(primary)}`}
        onClick={() => onEdit('primary')}
        {...stylex.props(styles.chip, styles.primary, styles.fill(toCss(primary)))}
      />
      <button
        type="button"
        aria-label="Swap colors"
        title="Swap colors  ·  X"
        onClick={onSwap}
        {...stylex.props(styles.swap)}
      >
        <SwapGlyph size={10} />
      </button>
      {/* Touch only: one target over the chips. Keyboard and screen readers keep the three. */}
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={onPress}
        {...stylex.props(styles.target, styles.cover)}
      />
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

const COARSE = '@media (pointer: coarse)';

const chipRing = `0 0 0 1.5px ${colorVars['--color-background-surface']}, 0 0 0 2.5px ${colorVars['--color-border-emphasized']}`;
const chipFocus = `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`;

const styles = stylex.create({
  well: {
    position: 'relative',
    width: { default: 36, [COARSE]: 44 },
    height: { default: 36, [COARSE]: 44 },
    flexShrink: 0,
    marginBlock: { default: 2, [COARSE]: 0 },
    // :active reaches the well from the cover, so the chips press together.
    transform: { default: null, [COARSE]: { ':active': 'scale(0.94)' } },
    transitionProperty: 'transform',
    transitionDuration: durationVars['--duration-fast'],
  },
  // Its button presses, so the well doesn't.
  wellLarge: { width: 44, height: 44, marginBlock: 0, transform: null },
  // The whole well is the button. Chips draw inside it and press together.
  target: {
    position: 'absolute',
    inset: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: 10,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    outline: 'none',
    WebkitTapHighlightColor: 'transparent',
    boxShadow: {
      default: null,
      ':focus-visible': `0 0 0 2px ${colorVars['--color-text-primary']}`,
    },
    transform: { default: null, ':active': 'scale(0.94)' },
    transitionProperty: 'transform',
    transitionDuration: durationVars['--duration-fast'],
  },
  cover: {
    display: { default: 'none', [COARSE]: 'block' },
    zIndex: 2,
    transform: null,
  },
  chip: {
    position: 'absolute',
    width: { default: 20, [COARSE]: 26 },
    height: { default: 20, [COARSE]: 26 },
    borderRadius: { default: 6, [COARSE]: 7 },
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
    display: { default: 'grid', [COARSE]: 'none' },
    position: 'absolute',
    right: 0,
    top: 0,
    width: 13,
    height: 13,
    padding: 0,
    borderWidth: 0,
    borderRadius: 4,
    placeItems: 'center',
    cursor: 'pointer',
    backgroundColor: 'transparent',
    color: {
      default: colorVars['--color-text-secondary'],
      '@media (hover: hover)': { ':hover': colorVars['--color-text-primary'] },
    },
    outline: {
      default: 'none',
      ':focus-visible': `2px solid ${colorVars['--color-text-primary']}`,
    },
  },
});
