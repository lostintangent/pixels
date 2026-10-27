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
import { DEFAULT_PALETTE, RECENT_LIMIT } from '../core/palette';
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
  recent: readonly PackedColor[];
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
  recent,
  primary,
  secondary,
  onChoose,
  onSwap,
}: ColorSheetProps) {
  const current = editing === 'primary' ? primary : secondary;
  const choose = (color: PackedColor) => onChoose(color, editing);
  // A swatch is a finished choice, so the sheet gets out of the way of the canvas. The picker
  // and hex field are for fine-tuning and keep it open.
  const chooseAndClose = (color: PackedColor) => {
    choose(color);
    onOpenChange(false);
  };
  return (
    <BottomSheet isOpen={isOpen} onOpenChange={onOpenChange} label="Colors" height="hug">
      <div data-passes-history {...stylex.props(styles.sheet)}>
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
        <div {...stylex.props(styles.picker)}>
          <ColorPicker color={current} onChange={choose} size="lg" />
        </div>
        <div {...stylex.props(styles.swatches)}>
          <div {...stylex.props(styles.label)}>Palette</div>
          <Swatches
            label="Palette"
            colors={DEFAULT_PALETTE}
            primary={current}
            onChoose={chooseAndClose}
            size="lg"
          />
          <div {...stylex.props(styles.label)}>Recent</div>
          <Swatches
            label="Recent colors"
            colors={recent}
            slots={RECENT_LIMIT}
            primary={current}
            onChoose={chooseAndClose}
            size="lg"
          />
        </div>
      </div>
    </BottomSheet>
  );
}

// A sideways phone has the width for the picker and the swatches side by side, and not the height
// to stack them, so the slots and picker take the left column and the swatches the right.
const LANDSCAPE = '@media (orientation: landscape) and (min-width: 600px)';

const styles = stylex.create({
  sheet: {
    display: { default: 'flex', [LANDSCAPE]: 'grid' },
    flexDirection: 'column',
    gridTemplateColumns: { default: null, [LANDSCAPE]: 'minmax(0, 1fr) 340px' },
    gridTemplateAreas: { default: null, [LANDSCAPE]: '"head swatches" "picker swatches"' },
    alignItems: { default: null, [LANDSCAPE]: 'start' },
    gap: spacingVars['--spacing-4'],
    columnGap: { default: null, [LANDSCAPE]: spacingVars['--spacing-6'] },
    paddingTop: spacingVars['--spacing-6'],
    paddingInline: spacingVars['--spacing-4'],
    paddingBottom: { default: spacingVars['--spacing-5'], [LANDSCAPE]: spacingVars['--spacing-4'] },
  },
  head: {
    gridArea: 'head',
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-3'],
  },
  picker: { gridArea: 'picker', display: { default: 'contents', [LANDSCAPE]: 'block' } },
  swatches: {
    gridArea: 'swatches',
    display: { default: 'contents', [LANDSCAPE]: 'flex' },
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
  },
  title: {
    flex: 1,
    minWidth: 0,
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
