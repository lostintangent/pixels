import * as stylex from '@stylexjs/stylex';
import { Kbd } from '@astryxdesign/core/Kbd';
import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { SHAPES } from '../core/tools';
import type { ShapeKind } from '../core/tools';
import type { Layout } from '../session/session';
import { SHAPE_ICONS } from './ShapeIcons';
import { pixelVars } from './tokens.stylex';

interface ShapesPopoverProps {
  open: boolean;
  layout: Layout;
  shapeKind: ShapeKind;
  /** The rail's Shapes item. Desktop opens beside it, phone centers above it. */
  anchor: RefObject<HTMLElement | null>;
  /** The phone dock, which the popover clears by 8px. */
  dock?: RefObject<HTMLElement | null>;
  onPick: (kind: ShapeKind) => void;
  onClose: () => void;
}

interface Placement {
  left: number;
  top: number;
}

/**
 * Preview's Shapes popover. Not modal: a press outside closes it and still reaches the canvas, so
 * picking a shape and starting to draw is one motion.
 */
export function ShapesPopover({
  open,
  layout,
  shapeKind,
  anchor,
  dock,
  onPick,
  onClose,
}: ShapesPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const phone = layout === 'phone';

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = () => {
      const button = anchor.current?.getBoundingClientRect();
      const menu = ref.current;
      if (!button || !menu) return;
      const { offsetWidth: width, offsetHeight: height } = menu;
      if (phone) {
        const top = (dock?.current?.getBoundingClientRect().top ?? button.top) - height - 8;
        const centered = button.left + button.width / 2 - width / 2;
        setPlacement({ left: Math.max(12, Math.min(innerWidth - width - 12, centered)), top });
      } else {
        // The rail island's inner padding plus its 10px gap to the canvas edge.
        const top = Math.max(12, button.top + button.height / 2 - height / 2);
        setPlacement({ left: button.right + 14, top });
      }
    };
    place();
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [open, phone, anchor, dock]);

  useEffect(() => {
    if (!open) return;
    const menu = ref.current;
    menu?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    // Capture beats the editor's own shortcuts, so Escape closes the menu and nothing else.
    const keys = (event: KeyboardEvent) => {
      if (!menu) return;
      const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      const current = items.indexOf(document.activeElement as HTMLElement);
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      const shape = SHAPES.find((info) => info.key === event.key.toLowerCase());
      if (event.key === 'Escape') {
        onClose();
        anchor.current?.focus();
      } else if (event.key === 'Tab') {
        onClose();
        return;
      } else if (step) {
        items[(Math.max(current, 0) + step + items.length) % items.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
      } else if (shape && !event.metaKey && !event.ctrlKey && !event.altKey) {
        onPick(shape.kind);
      } else {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('pointerdown', away, true);
    addEventListener('keydown', keys, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      removeEventListener('keydown', keys, true);
    };
  }, [open, anchor, onClose, onPick]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Shapes"
      aria-orientation={phone ? 'horizontal' : 'vertical'}
      style={placement ?? { visibility: 'hidden', left: 0, top: 0 }}
      {...stylex.props(styles.menu, phone ? styles.phone : styles.desktop)}
    >
      {SHAPES.map((shape) => {
        const Icon = SHAPE_ICONS[shape.kind];
        const checked = shape.kind === shapeKind;
        return (
          <button
            key={shape.kind}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            aria-keyshortcuts={shape.key.toUpperCase()}
            tabIndex={-1}
            onClick={() => onPick(shape.kind)}
            {...stylex.props(
              styles.item,
              phone ? styles.tile : styles.row,
              checked && styles.checked,
            )}
          >
            <Icon size={20} strokeWidth={1.75} aria-hidden />
            <span {...stylex.props(!phone && styles.label)}>{shape.label}</span>
            {!phone && <Kbd keys={shape.key.toUpperCase()} />}
          </button>
        );
      })}
    </div>
  );
}

const pop = stylex.keyframes({
  from: { opacity: 0, transform: 'scale(0.96)' },
  to: { opacity: 1, transform: 'none' },
});

const FORCED = '@media (forced-colors: active)';

const styles = stylex.create({
  menu: {
    outline: { default: null, [FORCED]: '1px solid CanvasText' },
    position: 'fixed',
    zIndex: 4,
    display: 'flex',
    backgroundColor: colorVars['--color-background-surface'],
    color: colorVars['--color-text-primary'],
    boxShadow:
      '0 0 0 1px var(--color-border), 0 1px 2px light-dark(#0000000a, #00000066), 0 10px 32px -8px light-dark(#00000033, #000000c0)',
    animationName: pop,
    animationDuration: {
      default: durationVars['--duration-fast'],
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    animationTimingFunction: pixelVars.ease,
  },
  desktop: {
    flexDirection: 'column',
    gap: 2,
    width: 208,
    padding: pixelVars.islandPad,
    borderRadius: pixelVars.islandRadius,
    transformOrigin: 'left center',
  },
  phone: {
    flexDirection: 'row',
    gap: 4,
    padding: 6,
    borderRadius: 18,
    transformOrigin: 'center bottom',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    borderWidth: 0,
    borderRadius: 10,
    padding: 0,
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': colorVars['--color-overlay-hover'] },
    },
    outline: {
      default: 'none',
      [FORCED]: { default: 'none', ':focus-visible': '2px solid CanvasText' },
    },
    outlineOffset: -2,
    boxShadow: {
      default: null,
      ':focus-visible': `inset 0 0 0 2px ${colorVars['--color-text-primary']}`,
    },
    transitionProperty: 'background-color',
    transitionDuration: durationVars['--duration-fast'],
    transitionTimingFunction: pixelVars.ease,
  },
  row: {
    gap: 10,
    height: pixelVars.tool,
    paddingInline: '9px 8px',
    fontSize: 13,
    textAlign: 'left',
  },
  tile: {
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 4,
    width: 88,
    height: 64,
    borderRadius: 13,
    fontSize: 12,
  },
  label: { flex: 1 },
  checked: {
    fontWeight: 600,
    backgroundColor: {
      default: colorVars['--color-background-muted'],
      '@media (hover: hover)': { ':hover': colorVars['--color-background-muted'] },
    },
    // A Highlight fill would put the label on Chrome's Canvas text backplate, so it's an edge.
    outline: {
      default: 'none',
      [FORCED]: { default: '2px solid Highlight', ':focus-visible': '3px solid Highlight' },
    },
  },
});
