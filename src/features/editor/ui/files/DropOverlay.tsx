import * as stylex from '@stylexjs/stylex';
import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { ImageUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MAX_DOCUMENT_SIDE } from '../../../document';
import { pixelVars } from '../tokens.stylex';
import { useFileActions } from './FileActions';

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

/** Dropping a PNG anywhere on the window opens it as a new canvas. */
export function DropOverlay() {
  const files = useFileActions();
  const [isOver, setOver] = useState(false);

  useEffect(() => {
    // Enter and leave fire for every child crossed, so only the outermost pair counts.
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setOver(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      const file = event.dataTransfer?.files[0];
      if (file) files.openFile(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [files]);

  return (
    <div aria-hidden data-over={isOver} {...stylex.props(styles.overlay, isOver && styles.over)}>
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
    backdropFilter: 'blur(2px)',
    opacity: 0,
    pointerEvents: 'none',
    transitionProperty: 'opacity',
    transitionDuration: {
      default: durationVars['--duration-fast'],
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    transitionTimingFunction: pixelVars.ease,
  },
  over: { opacity: 1 },
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
