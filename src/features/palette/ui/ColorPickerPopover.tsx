import * as stylex from '@stylexjs/stylex';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Popover } from '@astryxdesign/core/Popover';
import { colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Ref, RefObject } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import type { PackedColor } from '../../document';
import { ColorPicker } from './ColorPicker';
import { ColorSlots } from './ColorSlots';
import type { ColorSlotsProps } from './ColorSlots';

export interface ColorPickerPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  color: PackedColor;
  onChange: (color: PackedColor) => void;
  placement?: 'above' | 'below' | 'start' | 'end';
  alignment?: 'start' | 'center' | 'end';
  /**
   * Slot choice and swap, shown only under a coarse pointer. A touch well is one target, so the
   * picker it opens carries the controls a mouse finds on the well itself.
   */
  slots?: ColorSlotsProps & { onSwap: () => void };
}

/**
 * The on-demand picker. Palette and recents stay visible; the picker appears only when asked.
 * It opens beside `anchorRef`, usually a whole island, while the controls that open it keep
 * their own clicks and ARIA. A press outside both closes it. Presses inside the anchor belong to
 * its controls, so switching from one color chip to the other retargets instead of closing.
 */
export function ColorPickerPopover({
  anchorRef,
  isOpen,
  onOpenChange,
  title,
  color,
  onChange,
  placement = 'end',
  alignment = 'start',
  slots,
}: ColorPickerPopoverProps) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const layer = body.current?.closest('[popover]');
      if (anchorRef.current?.contains(target) || layer?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [isOpen, anchorRef, onOpenChange]);

  return (
    <Popover
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement={placement}
      alignment={alignment}
      width={244}
      label={title}
      isModal={false}
      hasLightDismiss={false}
      content={
        <div ref={body} {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.head)}>
            <span {...stylex.props(styles.title, slots && styles.titleWithSlots)}>{title}</span>
            {slots && (
              <div {...stylex.props(styles.slots)}>
                <ColorSlots {...slots} />
                <IconButton
                  variant="ghost"
                  label="Swap colors"
                  icon={<ArrowLeftRight size={20} />}
                  onClick={slots.onSwap}
                />
              </div>
            )}
          </div>
          <ColorPicker color={color} onChange={onChange} />
        </div>
      }
    >
      {({ ref }) => <Anchor target={anchorRef} attach={ref} />}
    </Popover>
  );
}

/**
 * Points the popover's anchor at `target` without making it the trigger. Sibling mode would
 * wire toggling and ARIA onto the first button inside the anchor, which for an island is the
 * wrong control.
 */
function Anchor({
  target,
  attach,
}: {
  target: RefObject<HTMLElement | null>;
  attach: Ref<HTMLElement>;
}) {
  useLayoutEffect(() => {
    if (typeof attach !== 'function') return;
    attach(target.current);
    return () => {
      attach(null);
    };
  }, [target, attach]);
  return null;
}

const COARSE = '@media (pointer: coarse)';

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
  // The checked chip names the slot, and the popover's label still carries the title.
  titleWithSlots: { display: { default: null, [COARSE]: 'none' } },
  slots: {
    display: { default: 'none', [COARSE]: 'flex' },
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
