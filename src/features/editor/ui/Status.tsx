import * as stylex from '@stylexjs/stylex';
import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useEffect, useRef, useState } from 'react';
import { getPixel, type PixelPoint, type PixelRect } from '../../document';
import { alpha, formatColor, toCss } from '../../palette';
import type { SaveStatus } from '../core/state';
import { useEditor, useEditorState } from './EditorContext';
import { pixelVars } from './tokens.stylex';

/**
 * Pointer position and the color beneath it. It updates at pointer rate, so it writes to the DOM
 * directly instead of re-rendering, into fixed-size contained slots: a per-move text change lays
 * out only its own slot and never dirties the layout the canvas reads its pointer geometry from.
 */
export function StatusPill() {
  const session = useEditor();
  const side = useEditorState((state) => Math.max(state.document.width, state.document.height));
  const root = useRef<HTMLDivElement>(null);
  const position = useRef<HTMLElement>(null);
  const chip = useRef<HTMLSpanElement>(null);
  const hex = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!position.current || !hex.current) return;
    // Each slot keeps one Text node whose data is rewritten. Assigning textContent would swap in a
    // new node, rebuilding layout objects and dirtying layout from the document root on every move.
    const positionText = textOf(position.current);
    const hexText = textOf(hex.current);
    // Only what changed is written, so a stroke in one color repaints just the position slot.
    const shown = { idle: 'true', position: '', chip: '', hex: '' };
    const render = () => {
      const point = session.pointer.state;
      const node = root.current;
      if (!node || !chip.current) return;
      const idle = point ? 'false' : 'true';
      if (shown.idle !== idle) node.dataset.idle = shown.idle = idle;
      if (!point) return;
      const at = `${point.x}, ${point.y}`;
      if (shown.position !== at) positionText.data = shown.position = at;
      const color = getPixel(session.bitmap.state, point);
      const visible = color !== null && alpha(color) > 0;
      // A transparent pixel keeps the chip as an empty ring, so the readout never shifts.
      const fill = visible ? toCss(color) : 'transparent';
      if (shown.chip !== fill) chip.current.style.backgroundColor = shown.chip = fill;
      const label = visible ? formatColor(color) : 'Transparent';
      if (shown.hex !== label) hexText.data = shown.hex = label;
    };
    render();
    const pointer = session.pointer.subscribe(render);
    // An edit under a resting pointer changes its color, so the readout follows the document too.
    let stopEdits = () => {};
    const watch = () => {
      stopEdits();
      stopEdits = session.bitmap.state.events.subscribe((rect) => {
        const point = session.pointer.state;
        if (point && contains(rect, point)) render();
      });
      render();
    };
    watch();
    const bitmap = session.bitmap.subscribe(watch);
    return () => {
      pointer.unsubscribe();
      bitmap.unsubscribe();
      stopEdits();
    };
  }, [session]);

  return (
    <div ref={root} data-idle="true" aria-hidden {...stylex.props(styles.pill)}>
      <div {...stylex.props(styles.readout)}>
        <b ref={position} {...stylex.props(styles.slot, styles.position(digits(side - 1)))} />
        <span ref={chip} {...stylex.props(styles.chip)} />
        <span ref={hex} {...stylex.props(styles.slot, styles.hex)} />
      </div>
    </div>
  );
}

/**
 * "32 × 32 · Saved", the document's quiet vital signs. A never-edited canvas shows only its size.
 * Autosave usually lands in milliseconds, so "Saving…" appears only for a save that is actually slow.
 * Until then the previous settled status holds, which avoids a flicker without claiming a save that
 * hasn't happened.
 */
export function DocumentMeta() {
  const width = useEditorState((state) => state.document.width);
  const height = useEditorState((state) => state.document.height);
  const save = useSettledSave();
  if (save === 'error') return <span {...stylex.props(styles.meta, styles.error)}>Not saved</span>;
  return (
    <span {...stylex.props(styles.meta)}>
      {width} × {height}
      {save && (
        <>
          <span aria-hidden {...stylex.props(styles.dot)} />
          {save === 'saving' ? 'Saving…' : 'Saved'}
        </>
      )}
    </span>
  );
}

const digits = (value: number) => String(value).length;

// React renders these slots empty, so the Text node is ours. Reused across effect re-runs.
const textOf = (slot: HTMLElement): Text =>
  slot.firstChild instanceof Text ? slot.firstChild : slot.appendChild(document.createTextNode(''));

const contains = (rect: PixelRect, point: PixelPoint) =>
  point.x >= rect.x &&
  point.y >= rect.y &&
  point.x < rect.x + rect.width &&
  point.y < rect.y + rect.height;

const SLOW_SAVE_MS = 400;

function useSettledSave(): SaveStatus | null {
  const save = useEditorState((state) => state.save);
  const settled = useRef<SaveStatus | null>(save === 'saving' ? null : save);
  const [slow, setSlow] = useState(false);
  if (save !== 'saving') settled.current = save;

  useEffect(() => {
    if (save !== 'saving') return setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_SAVE_MS);
    return () => clearTimeout(timer);
  }, [save]);

  return save === 'saving' && !slow ? settled.current : save;
}

const styles = stylex.create({
  pill: {
    position: 'absolute',
    zIndex: 2,
    left: pixelVars.edge,
    bottom: pixelVars.safeBottom,
    paddingBlock: 6,
    paddingInline: 10,
    borderRadius: 999,
    fontSize: 13,
    fontVariantNumeric: 'tabular-nums',
    color: colorVars['--color-text-secondary'],
    // Solid like the islands: a backdrop blur would re-filter the live canvas on every frame.
    backgroundColor: colorVars['--color-background-surface'],
    boxShadow: pixelVars.islandShadow,
    pointerEvents: 'none',
    contain: 'layout paint',
    opacity: { default: 1, ':is([data-idle=true])': 0 },
    transitionProperty: 'opacity',
    transitionDuration: {
      default: durationVars['--duration-fast'],
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
  },
  // Its own compositing layer, so a readout change re-rasters only this strip of text and never
  // the surface and soft shadow behind it.
  // A line of inline blocks rather than a flex row: Chromium never treats a flex or grid item as a
  // relayout boundary, so a contained slot in a flex row still dirtied layout from the document.
  readout: {
    display: 'block',
    lineHeight: '16px',
    whiteSpace: 'nowrap',
    willChange: 'transform',
  },
  // A relayout boundary: its size never depends on the text written into it.
  slot: {
    display: 'inline-block',
    verticalAlign: 'top',
    contain: 'strict',
    blockSize: 16,
  },
  // Tabular digits are 1ch each. The widest position is two of the largest coordinate plus ", ".
  position: (places: number) => ({
    inlineSize: `calc(${places * 2}ch + 0.8em)`,
    fontWeight: 500,
    color: colorVars['--color-text-primary'],
  }),
  chip: {
    display: 'inline-block',
    verticalAlign: 'top',
    marginBlockStart: 3,
    marginInline: spacingVars['--spacing-2'],
    width: 10,
    height: 10,
    borderRadius: 3,
    boxShadow: `inset 0 0 0 1px ${colorVars['--color-border']}`,
  },
  // Fits "Transparent", the longest readout.
  hex: { inlineSize: 76 },
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
