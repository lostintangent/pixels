import * as stylex from '@stylexjs/stylex';
import { TextInput } from '@astryxdesign/core/TextInput';
import { colorVars, radiusVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { use, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { PackedColor } from '../../document';
import { formatColor, fromHsv, readHexDraft, toCss, toHsvKeepingHue } from '../core/color';
import type { Hsv } from '../core/color';
import { PaletteColorSpace } from './colorSpace';

export interface ColorPickerProps {
  color: PackedColor;
  onChange: (color: PackedColor) => void;
  /** Taller field for touch. */
  size?: 'md' | 'lg';
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// The hue thumb stays inside its rail, so its travel is inset by its radius on both ends.
const HUE_THUMB = 16;

/**
 * Calls `onPoint` with normalized coordinates for a pointer drag, including the first press.
 * `inset` shrinks the horizontal travel to match a thumb that stays inside its track.
 */
function dragHandler(onPoint: (x: number, y: number) => void, inset = 0) {
  return (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    // A sheet arms its pull-to-dismiss from a pointer press anywhere in its body.
    event.stopPropagation();
    const rect = element.getBoundingClientRect();
    element.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent | ReactPointerEvent) =>
      onPoint(
        clamp01((next.clientX - rect.left - inset) / (rect.width - inset * 2)),
        clamp01((next.clientY - rect.top) / rect.height),
      );
    move(event);
    const stop = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', stop);
      element.removeEventListener('pointercancel', stop);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', stop);
    element.addEventListener('pointercancel', stop);
  };
}

/**
 * Keeps a drag on this control from also dragging the sheet around it. Astryx BottomSheet
 * tracks every touch in its body with native listeners, so React's propagation can't stop it.
 * `touch-action: none` already keeps the browser from scrolling, so nothing is cancelled here.
 */
function ownsTouchDrag(element: HTMLElement | null) {
  if (!element) return;
  const stop = (event: TouchEvent) => event.stopPropagation();
  element.addEventListener('touchstart', stop, { passive: true });
  element.addEventListener('touchmove', stop, { passive: true });
  return () => {
    element.removeEventListener('touchstart', stop);
    element.removeEventListener('touchmove', stop);
  };
}

/** Saturation and value field, hue rail, and hex entry. */
export function ColorPicker({ color, onChange, size = 'md' }: ColorPickerProps) {
  // Hue lives here so dragging through greys and black doesn't lose it.
  const [hsv, setHsv] = useState<Hsv>(() => toHsvKeepingHue(color, { h: 0, s: 0, v: 0 }));
  const [draft, setDraft] = useState(() => formatColor(color));
  const emitted = useRef(color);

  useEffect(() => {
    if (color !== emitted.current) {
      setHsv((previous) => toHsvKeepingHue(color, previous));
      emitted.current = color;
    }
    setDraft(formatColor(color));
  }, [color]);

  const commit = (next: Hsv) => {
    setHsv(next);
    const packed = fromHsv(next);
    emitted.current = packed;
    onChange(packed);
  };

  const { h, s, v } = hsv;
  const onField = dragHandler((x, y) => commit({ h, s: x, v: 1 - y }));
  const onHue = dragHandler((x) => commit({ h: Math.min(359.9, x * 360), s, v }), HUE_THUMB / 2);

  const onFieldKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    commit({ h, s: clamp01(s + delta[0]!), v: clamp01(v + delta[1]!) });
  };
  const onHueKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 1;
    const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[
      event.key
    ];
    if (delta === undefined) return;
    event.preventDefault();
    commit({ h: (h + delta + 360) % 360, s, v });
  };

  const apply = (next: PackedColor) => {
    emitted.current = next;
    setHsv((previous) => toHsvKeepingHue(next, previous));
    onChange(next);
  };
  // Three digits and a same-color entry don't change `color`, so the draft is normalized here.
  const commitDraft = () => {
    const read = readHexDraft(draft);
    if (read.kind === 'complete' || read.kind === 'short') {
      if (read.color !== color) apply(read.color);
      setDraft(formatColor(read.color));
    } else if (read.kind === 'partial') setDraft(formatColor(color));
  };

  const invalid = draft !== formatColor(color) && readHexDraft(draft).kind === 'invalid';
  const space = use(PaletteColorSpace);
  const css = toCss(color, space);
  // The field and rail are drawn in the document's space too, so a hue looks the same as it paints.
  const p3 = space === 'display-p3';
  const pure = p3 ? toCss(fromHsv({ h, s: 1, v: 1 }), space) : `hsl(${h} 100% 50%)`;

  return (
    <div {...stylex.props(styles.picker)}>
      <div
        ref={ownsTouchDrag}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`}
        onPointerDown={onField}
        onKeyDown={onFieldKey}
        {...stylex.props(
          stylex.defaultMarker(),
          styles.field,
          size === 'lg' && styles.fieldLarge,
          styles.fill(pure),
        )}
      >
        <div {...stylex.props(styles.thumb, styles.at(s, 1 - v), styles.fill(css))} />
      </div>
      <div
        ref={ownsTouchDrag}
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(h)}
        onPointerDown={onHue}
        onKeyDown={onHueKey}
        {...stylex.props(stylex.defaultMarker(), styles.hue, p3 && styles.hueP3)}
      >
        <div
          {...stylex.props(styles.thumb, styles.hueThumb, styles.hueAt(h / 360), styles.fill(pure))}
        />
      </div>
      <div {...stylex.props(styles.hexRow)}>
        <div aria-hidden {...stylex.props(styles.current, styles.fill(css))} />
        <div {...stylex.props(styles.hexField)}>
          <TextInput
            label="Hex color"
            isLabelHidden
            value={draft}
            onChange={(value: string) => {
              setDraft(value);
              const read = readHexDraft(value);
              if (read.kind === 'complete' && read.color !== color) apply(read.color);
            }}
            onEnter={commitDraft}
            onBlur={() => {
              if (readHexDraft(draft).kind === 'invalid') setDraft(formatColor(color));
              else commitDraft();
            }}
            status={invalid ? { type: 'error', message: 'Use 3 or 6 hex digits' } : undefined}
            statusVariant="tooltip"
          />
        </div>
      </div>
    </div>
  );
}

const COARSE = '@media (pointer: coarse)';
const FORCED = '@media (forced-colors: active)';

const thumbRing = '0 0 0 2px #fff, 0 0 0 3px #0000004d, 0 2px 6px #00000059';
const thumbFocus = `0 0 0 2px #fff, 0 0 0 4px ${colorVars['--color-text-primary']}, 0 2px 6px #00000059`;

const styles = stylex.create({
  picker: {
    display: 'flex',
    flexDirection: 'column',
    gap: { default: spacingVars['--spacing-2'], [COARSE]: 16 },
  },
  field: {
    position: 'relative',
    height: 136,
    borderRadius: 10,
    cursor: 'crosshair',
    touchAction: 'none',
    forcedColorAdjust: 'none',
    outline: { default: 'none', [FORCED]: { ':focus-visible': '2px solid CanvasText' } },
    outlineOffset: 2,
    backgroundImage:
      'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
    boxShadow: 'inset 0 0 0 1px light-dark(#0000001a, #ffffff14)',
  },
  fieldLarge: { height: 148 },
  hue: {
    position: 'relative',
    height: 12,
    borderRadius: radiusVars['--radius-full'],
    cursor: 'pointer',
    touchAction: 'none',
    forcedColorAdjust: 'none',
    outline: { default: 'none', [FORCED]: { ':focus-visible': '2px solid CanvasText' } },
    outlineOffset: 2,
    backgroundImage:
      'linear-gradient(to right, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00)',
    // On touch the thin rail takes presses across a 44px band that fills the gaps around it.
    '::before': {
      content: { default: null, [COARSE]: "''" },
      position: 'absolute',
      insetInline: 0,
      insetBlock: -16,
    },
  },
  hueP3: {
    backgroundImage:
      'linear-gradient(to right in display-p3, color(display-p3 1 0 0), color(display-p3 1 1 0) 17%, color(display-p3 0 1 0) 33%, color(display-p3 0 1 1) 50%, color(display-p3 0 0 1) 67%, color(display-p3 1 0 1) 83%, color(display-p3 1 0 0))',
  },
  thumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: '50%',
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none',
    boxShadow: {
      default: thumbRing,
      [stylex.when.ancestor(':focus-visible')]: thumbFocus,
    },
  },
  hueThumb: { width: HUE_THUMB, height: HUE_THUMB },
  hueAt: (x: number) => ({
    left: `calc(${HUE_THUMB / 2}px + (100% - ${HUE_THUMB}px) * ${x})`,
    top: '50%',
  }),
  at: (x: number, y: number) => ({ left: `${x * 100}%`, top: `${y * 100}%` }),
  fill: (css: string) => ({ backgroundColor: css }),
  hexRow: { display: 'flex', alignItems: 'center', gap: spacingVars['--spacing-2'] },
  hexField: { flex: 1, minWidth: 0 },
  current: {
    width: { default: 32, [COARSE]: 44 },
    height: { default: 32, [COARSE]: 44 },
    borderRadius: 8,
    flexShrink: 0,
    forcedColorAdjust: 'none',
    outline: { default: null, [FORCED]: '1px solid CanvasText' },
    boxShadow: 'inset 0 0 0 1px light-dark(#0000001a, #ffffff1f)',
  },
});
