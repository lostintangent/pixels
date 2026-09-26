import * as stylex from '@stylexjs/stylex';
import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useEffect, useRef } from 'react';
import { getPixel } from '../../document';
import { alpha, formatColor, toCss } from '../../palette';
import { useEditor, useEditorState } from './EditorContext';
import { pixelVars } from './tokens.stylex';

/**
 * Pointer position and the color beneath it. It updates at pointer rate, so it
 * writes to the DOM directly instead of re-rendering.
 */
export function StatusPill() {
  const session = useEditor();
  const root = useRef<HTMLDivElement>(null);
  const position = useRef<HTMLElement>(null);
  const chip = useRef<HTMLSpanElement>(null);
  const hex = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const render = () => {
      const point = session.pointer.state;
      const node = root.current;
      if (!node || !position.current || !chip.current || !hex.current) return;
      node.dataset.idle = point ? 'false' : 'true';
      if (!point) return;
      position.current.textContent = `${point.x}, ${point.y}`;
      const color = getPixel(session.bitmap.state, point);
      const visible = color !== null && alpha(color) > 0;
      chip.current.style.opacity = visible ? '1' : '0';
      if (visible) chip.current.style.backgroundColor = toCss(color);
      hex.current.textContent = visible ? formatColor(color) : 'Transparent';
    };
    render();
    const subscription = session.pointer.subscribe(render);
    return () => subscription.unsubscribe();
  }, [session]);

  return (
    <div ref={root} data-idle="true" aria-hidden {...stylex.props(styles.pill)}>
      <b ref={position} {...stylex.props(styles.position)} />
      <span ref={chip} {...stylex.props(styles.chip)} />
      <span ref={hex} {...stylex.props(styles.hex)} />
    </div>
  );
}

/** "32 × 32 · Saved", the document's quiet vital signs. */
export function DocumentMeta() {
  const width = useEditorState((state) => state.document.width);
  const height = useEditorState((state) => state.document.height);
  const save = useEditorState((state) => state.save);
  if (save === 'error') return <span {...stylex.props(styles.meta, styles.error)}>Not saved</span>;
  return (
    <span {...stylex.props(styles.meta)}>
      {width} × {height}
      <span aria-hidden {...stylex.props(styles.dot)} />
      {save === 'saving' ? 'Saving…' : save === 'unsaved' ? 'Edited' : 'Saved'}
    </span>
  );
}

const styles = stylex.create({
  pill: {
    position: 'absolute',
    zIndex: 2,
    left: pixelVars.edge,
    bottom: pixelVars.safeBottom,
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    paddingBlock: 6,
    paddingInline: 10,
    borderRadius: 999,
    fontSize: 13,
    fontVariantNumeric: 'tabular-nums',
    color: colorVars['--color-text-secondary'],
    backgroundColor: `color-mix(in srgb, ${colorVars['--color-background-surface']} 72%, transparent)`,
    backdropFilter: 'blur(12px)',
    pointerEvents: 'none',
    opacity: { default: 1, ':is([data-idle=true])': 0 },
    transitionProperty: 'opacity',
    transitionDuration: {
      default: durationVars['--duration-fast'],
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
  },
  position: {
    fontWeight: 500,
    color: colorVars['--color-text-primary'],
    minWidth: 48,
    display: 'inline-block',
  },
  chip: {
    width: 10,
    height: 10,
    borderRadius: 3,
    boxShadow: `inset 0 0 0 1px ${colorVars['--color-border']}`,
  },
  hex: { minWidth: 76 },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
    color: colorVars['--color-text-secondary'],
  },
  error: { color: colorVars['--color-error'] },
  dot: { width: 3, height: 3, borderRadius: '50%', backgroundColor: 'currentColor', opacity: 0.5 },
});
