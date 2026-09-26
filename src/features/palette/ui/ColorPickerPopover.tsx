import * as stylex from '@stylexjs/stylex';
import { Popover } from '@astryxdesign/core/Popover';
import { colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import type { ReactNode, RefObject } from 'react';
import type { PackedColor } from '../../document';
import { ColorPicker } from './ColorPicker';

export interface ColorPickerPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  color: PackedColor;
  onChange: (color: PackedColor) => void;
  placement?: 'above' | 'below' | 'start' | 'end';
  alignment?: 'start' | 'center' | 'end';
  /** Extra header controls, like a swap button. */
  actions?: ReactNode;
}

/** The on-demand picker. Palette and recents stay visible; the picker appears only when asked. */
export function ColorPickerPopover({
  anchorRef,
  isOpen,
  onOpenChange,
  title,
  color,
  onChange,
  placement = 'end',
  alignment = 'start',
  actions,
}: ColorPickerPopoverProps) {
  return (
    <Popover
      anchorRef={anchorRef as RefObject<HTMLElement>}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement={placement}
      alignment={alignment}
      width={244}
      label={title}
      isModal={false}
      content={
        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.head)}>
            <span {...stylex.props(styles.title)}>{title}</span>
            {actions}
          </div>
          <ColorPicker color={color} onChange={onChange} />
        </div>
      }
    />
  );
}

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    padding: spacingVars['--spacing-3'],
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 20 },
  title: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.02em',
    color: colorVars['--color-text-secondary'],
  },
});
