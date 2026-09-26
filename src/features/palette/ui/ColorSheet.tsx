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
import { formatColor } from '../core/color';
import { ColorPicker } from './ColorPicker';
import { ColorSlots } from './ColorSlots';
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
          <ColorSlots
            editing={editing}
            onEditingChange={onEditingChange}
            primary={primary}
            secondary={secondary}
          />
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
