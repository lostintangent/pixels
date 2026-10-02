import * as stylex from '@stylexjs/stylex';
import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { ImageUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MAX_DOCUMENT_SIDE } from '../../../document';
import { pixelVars } from '../tokens.stylex';

/** The drop target's visual. It loads with the dialogs, at idle or on the first drag over the window. */
export function DropCard({ isOver }: { isOver: boolean }) {
  // A transition skips a node's first style, so a card first mounted mid-drag fades in a frame later.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const over = isOver && ready;
  return (
    <div aria-hidden data-over={over} {...stylex.props(styles.overlay, over && styles.over)}>
      <div {...stylex.props(styles.card)}>
        <ImageUp size={22} strokeWidth={1.75} aria-hidden {...stylex.props(styles.icon)} />
        <span {...stylex.props(styles.title)}>Drop to open</span>
        <span {...stylex.props(styles.note)}>
          PNG up to {MAX_DOCUMENT_SIDE} × {MAX_DOCUMENT_SIDE}
        </span>
      </div>
    </div>
  );
}

const styles = stylex.create({
  overlay: {
    position: 'fixed',
    inset: pixelVars.edge,
    zIndex: 10,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 20,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colorVars['--color-accent'],
    backgroundColor: `color-mix(in srgb, ${pixelVars.canvasBg} 72%, transparent)`,
    opacity: 0,
    // Hidden, not just transparent, so no idle layer sits over the live canvas. The visibility
    // flip waits out the fade on the way out.
    visibility: 'hidden',
    pointerEvents: 'none',
    transitionProperty: 'opacity, visibility',
    transitionDuration: {
      default: durationVars['--duration-fast'],
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    transitionTimingFunction: pixelVars.ease,
  },
  // The blur exists only while a file is over the window.
  over: { opacity: 1, visibility: 'visible', backdropFilter: 'blur(2px)' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    paddingBlock: spacingVars['--spacing-5'],
    paddingInline: spacingVars['--spacing-6'],
    borderRadius: pixelVars.islandRadius,
    backgroundColor: colorVars['--color-background-popover'],
    boxShadow: pixelVars.islandShadow,
  },
  icon: { color: colorVars['--color-icon-accent'], marginBottom: spacingVars['--spacing-1'] },
  title: { fontSize: 15, fontWeight: 600, color: colorVars['--color-text-primary'] },
  note: {
    fontSize: 13,
    color: colorVars['--color-text-secondary'],
    fontVariantNumeric: 'tabular-nums',
  },
});
