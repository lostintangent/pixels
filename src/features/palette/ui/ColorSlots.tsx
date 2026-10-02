import * as stylex from '@stylexjs/stylex';
import { colorVars } from '@astryxdesign/core/theme/tokens.stylex';
import { use } from 'react';
import type { PackedColor } from '../../document';
import { formatColor, toCss } from '../core/color';
import { PaletteColorSpace } from './colorSpace';
import type { SwatchSlot } from './Swatches';

export interface ColorSlotsProps {
  editing: SwatchSlot;
  onEditingChange: (slot: SwatchSlot) => void;
  primary: PackedColor;
  secondary: PackedColor;
}

/** Which color is being edited, as two 44px chips. Touch surfaces use it where the well can't. */
export function ColorSlots({ editing, onEditingChange, primary, secondary }: ColorSlotsProps) {
  const space = use(PaletteColorSpace);
  return (
    <div role="radiogroup" aria-label="Color slot" {...stylex.props(styles.slots)}>
      {(['primary', 'secondary'] as const).map((slot) => {
        const color = slot === 'primary' ? primary : secondary;
        return (
          <button
            key={slot}
            type="button"
            role="radio"
            aria-checked={editing === slot}
            aria-label={`${slot === 'primary' ? 'Primary' : 'Secondary'}, ${formatColor(color)}`}
            onClick={() => onEditingChange(slot)}
            {...stylex.props(
              styles.slot,
              styles.fill(toCss(color, space)),
              editing === slot && styles.active,
            )}
          />
        );
      })}
    </div>
  );
}

const ring = `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`;

const styles = stylex.create({
  slots: { display: 'flex', gap: 8 },
  slot: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 0,
    cursor: 'pointer',
    outline: 'none',
    boxShadow: {
      default: 'inset 0 0 0 1px light-dark(#0000001a, #ffffff1f)',
      ':focus-visible': `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-secondary']}`,
    },
  },
  active: {
    boxShadow: { default: ring, ':focus-visible': ring },
  },
  fill: (css: string) => ({ backgroundColor: css }),
});
