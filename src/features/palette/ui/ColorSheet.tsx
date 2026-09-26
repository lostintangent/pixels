import * as stylex from '@stylexjs/stylex';
import { BottomSheet } from '@astryxdesign/core/BottomSheet';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  colorVars,
  fontWeightVars,
  spacingVars,
  textSizeVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { ArrowLeftRight } from 'lucide-react';
import type { PackedColor } from '../../document';
import { formatColor, toCss } from '../core/color';
import { ColorPicker } from './ColorPicker';
import { Swatches } from './Swatches';
import type { SwatchSlot } from './Swatches';

export interface ColorSheetProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  editing: SwatchSlot;
  onEditingChange: (slot: SwatchSlot) => void;
  palette: readonly PackedColor[];
  recent: readonly PackedColor[];
  recentSlots: number;
  primary: PackedColor;
  secondary: PackedColor;
  onChoose: (color: PackedColor, slot: SwatchSlot) => void;
  onSwap: () => void;
}

/** Phone color editing: one sheet with both slots, the picker, palette, and recents. */
export function ColorSheet({
  isOpen,
  onOpenChange,
  editing,
  onEditingChange,
  palette,
  recent,
  recentSlots,
  primary,
  secondary,
  onChoose,
  onSwap,
}: ColorSheetProps) {
  const current = editing === 'primary' ? primary : secondary;
  const choose = (color: PackedColor) => onChoose(color, editing);
  return (
    <BottomSheet isOpen={isOpen} onOpenChange={onOpenChange} label="Colors" height="hug">
      <div {...stylex.props(styles.sheet)}>
        <div {...stylex.props(styles.head)}>
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
                    styles.fill(toCss(color)),
                    editing === slot && styles.slotActive,
                  )}
                />
              );
            })}
          </div>
          <div {...stylex.props(styles.title)}>
            <span>{editing === 'primary' ? 'Primary' : 'Secondary'}</span>
            <span {...stylex.props(styles.hex)}>{formatColor(current)}</span>
          </div>
          <IconButton
            variant="ghost"
            size="lg"
            label="Swap colors"
            icon={<ArrowLeftRight size={20} />}
            onClick={onSwap}
          />
        </div>
        <ColorPicker color={current} onChange={choose} size="lg" />
        <div {...stylex.props(styles.label)}>Palette</div>
        <Swatches label="Palette" colors={palette} primary={current} onChoose={choose} size="lg" />
        <div {...stylex.props(styles.label)}>Recent</div>
        <Swatches
          label="Recent colors"
          colors={recent}
          slots={recentSlots}
          primary={current}
          onChoose={choose}
          size="lg"
        />
      </div>
    </BottomSheet>
  );
}

const styles = stylex.create({
  sheet: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    paddingTop: spacingVars['--spacing-6'],
    paddingInline: spacingVars['--spacing-4'],
    paddingBottom: spacingVars['--spacing-5'],
  },
  head: { display: 'flex', alignItems: 'center', gap: spacingVars['--spacing-3'] },
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
  slotActive: {
    boxShadow: {
      default: `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`,
      ':focus-visible': `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`,
    },
  },
  fill: (css: string) => ({ backgroundColor: css }),
  title: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    fontSize: textSizeVars['--font-size-sm'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  hex: {
    fontSize: 12,
    fontWeight: fontWeightVars['--font-weight-normal'],
    color: colorVars['--color-text-secondary'],
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'var(--font-family-code)',
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.02em',
    color: colorVars['--color-text-secondary'],
    marginBottom: -8,
  },
});
