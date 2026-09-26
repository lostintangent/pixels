import * as stylex from '@stylexjs/stylex';
import { colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useRef, useState } from 'react';
import type { PackedColor } from '../../document';
import { ColorPickerPopover } from './ColorPickerPopover';
import { Swatches } from './Swatches';
import type { SwatchSlot } from './Swatches';

export interface ColorPanelProps {
  palette: readonly PackedColor[];
  recent: readonly PackedColor[];
  recentSlots: number;
  primary: PackedColor;
  secondary: PackedColor;
  onChoose: (color: PackedColor, slot: SwatchSlot) => void;
}

/** Desktop color panel: palette and recents always visible, the picker on demand. */
export function ColorPanel({
  palette,
  recent,
  recentSlots,
  primary,
  secondary,
  onChoose,
}: ColorPanelProps) {
  const [picking, setPicking] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchor} {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.label)}>
        <span>Palette</span>
        <button
          type="button"
          aria-label="Custom color"
          aria-expanded={picking}
          title="Custom color"
          onClick={() => setPicking((open) => !open)}
          {...stylex.props(styles.custom, picking && styles.customOpen)}
        />
      </div>
      <Swatches
        label="Palette"
        colors={palette}
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
        slots={recentSlots}
        primary={primary}
        secondary={secondary}
        onChoose={onChoose}
      />
      <ColorPickerPopover
        anchorRef={anchor}
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

const styles = stylex.create({
  panel: { display: 'flex', flexDirection: 'column', gap: spacingVars['--spacing-2'] },
  label: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 20,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.02em',
    color: colorVars['--color-text-secondary'],
    marginTop: { default: 4, ':first-child': 0 },
  },
  // A hue wheel reads as "any color" without another word of chrome.
  custom: {
    width: 18,
    height: 18,
    borderRadius: '50%',
    borderWidth: 0,
    padding: 0,
    cursor: 'pointer',
    outline: 'none',
    backgroundImage:
      'radial-gradient(circle, #fff 0 22%, transparent 60%), conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
    boxShadow: {
      default: 'inset 0 0 0 1px #0000001f',
      ':hover': `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 3px ${colorVars['--color-border-emphasized']}`,
      ':focus-visible': `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`,
    },
  },
  customOpen: {
    boxShadow: `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`,
  },
});
