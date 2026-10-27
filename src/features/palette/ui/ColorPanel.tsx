import * as stylex from '@stylexjs/stylex';
import { colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useState } from 'react';
import type { RefObject } from 'react';
import type { PackedColor } from '../../document';
import { DEFAULT_PALETTE, RECENT_LIMIT } from '../core/palette';
import { ColorPickerPopover, preloadColorPicker } from './deferred';
import { Swatches } from './Swatches';
import type { SwatchSlot } from './Swatches';

interface ColorPanelProps {
  recent: readonly PackedColor[];
  primary: PackedColor;
  secondary: PackedColor;
  onChoose: (color: PackedColor, slot: SwatchSlot) => void;
  /** What the custom picker opens beside. */
  anchorRef: RefObject<HTMLElement | null>;
}

/** Desktop color panel: palette and recents always visible, the picker on demand. */
export function ColorPanel({ recent, primary, secondary, onChoose, anchorRef }: ColorPanelProps) {
  const [picking, setPicking] = useState(false);
  return (
    <div {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.label)}>
        <span>Palette</span>
        <button
          type="button"
          aria-label="Custom color"
          aria-expanded={picking}
          title="Custom color"
          onClick={() => setPicking((open) => !open)}
          onPointerEnter={preloadColorPicker}
          onFocus={preloadColorPicker}
          {...stylex.props(styles.custom, picking && styles.customOpen)}
        />
      </div>
      <Swatches
        label="Palette"
        colors={DEFAULT_PALETTE}
        primary={primary}
        secondary={secondary}
        onChoose={onChoose}
      />
      <div {...stylex.props(styles.label)}>
        <span>Recent</span>
      </div>
      <Swatches
        label="Recent colors"
        colors={recent}
        slots={RECENT_LIMIT}
        primary={primary}
        secondary={secondary}
        onChoose={onChoose}
      />
      <ColorPickerPopover
        anchorRef={anchorRef}
        isOpen={picking}
        onOpenChange={setPicking}
        title="Primary color"
        color={primary}
        onChange={(color) => onChoose(color, 'primary')}
        placement="start"
      />
    </div>
  );
}

const COARSE = '@media (pointer: coarse)';

const FORCED = '@media (forced-colors: active)';

const styles = stylex.create({
  panel: { display: 'flex', flexDirection: 'column', gap: spacingVars['--spacing-2'] },
  label: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: { default: 20, [COARSE]: 32 },
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.02em',
    color: colorVars['--color-text-secondary'],
    marginTop: { default: 4, ':first-child': 0 },
  },
  // A hue wheel reads as "any color" without another word of chrome.
  custom: {
    position: 'relative',
    width: { default: 18, [COARSE]: 24 },
    height: { default: 18, [COARSE]: 24 },
    borderRadius: '50%',
    borderWidth: 0,
    padding: 0,
    cursor: 'pointer',
    forcedColorAdjust: 'none',
    outline: {
      default: 'none',
      [FORCED]: { default: '1px solid CanvasText', ':focus-visible': '2px solid CanvasText' },
    },
    outlineOffset: { default: null, [FORCED]: { default: 0, ':focus-visible': 2 } },
    backgroundImage:
      'radial-gradient(circle, #fff 0 22%, transparent 60%), conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
    boxShadow: {
      default: 'inset 0 0 0 1px #0000001f',
      '@media (hover: hover)': {
        ':hover': `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 3px ${colorVars['--color-border-emphasized']}`,
      },
      ':focus-visible': `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`,
      [FORCED]: 'none',
    },
    // A 44px touch target around the small wheel, reaching into the panel's padding and gap.
    '::before': {
      content: { default: null, [COARSE]: "''" },
      position: 'absolute',
      inset: -10,
    },
  },
  customOpen: {
    boxShadow: {
      default: `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`,
      [FORCED]: 'none',
    },
    outline: { default: 'none', [FORCED]: '2px solid Highlight' },
    outlineOffset: { default: null, [FORCED]: 2 },
  },
});
