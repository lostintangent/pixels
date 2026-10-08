import * as stylex from '@stylexjs/stylex';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useState } from 'react';
import { packRgba } from '../../../document';
import { toCss, TRANSPARENT } from '../../../palette';
import type { Layout } from '../../session/session';
import { useEditor, useEditorState } from '../EditorContext';
import { useFileActions } from '../files/FileActions';
import type { Size } from '../../core/dimensions';
import {
  Dimensions,
  Field,
  Footer,
  Form,
  formatBytes,
  sideError,
  Surface,
  useSizeFields,
} from './Surface';

const PRESETS = [
  { width: 16, height: 16, name: 'Icon' },
  { width: 32, height: 32, name: 'Sprite' },
  { width: 64, height: 64, name: 'Character' },
  { width: 128, height: 128, name: 'Tile set' },
  { width: 256, height: 256, name: 'Scene' },
  { width: 320, height: 180, name: 'Widescreen' },
] as const;

type Background = 'transparent' | 'white' | 'primary';

export function NewCanvasDialog({ layout }: { layout: Layout }) {
  const session = useEditor();
  const files = useFileActions();
  const isOpen = useEditorState((state) => state.panel === 'new');
  const primary = useEditorState((state) => state.primary);
  // A blank canvas that was never edited isn't stored, so only a kept one can promise Recent.
  const isKept = useEditorState((state) => state.save === 'saved' || state.save === 'saving');
  const fields = useSizeFields({ width: 64, height: 64 }, true);
  const { width, height } = fields;
  const [background, setBackground] = useState<Background>('transparent');
  const valid = !sideError(width) && !sideError(height);
  const selected = PRESETS.findIndex(
    (preset) => preset.width === width && preset.height === height,
  );
  const choose = (index: number) => fields.reset(PRESETS[index]!);
  const close = () => session.setPanel(null);
  const create = (size: Size = fields.latest()) => {
    const fill =
      background === 'transparent'
        ? TRANSPARENT
        : background === 'white'
          ? packRgba(255, 255, 255)
          : primary;
    files.newCanvas(size.width, size.height, fill);
    close();
  };

  return (
    <Surface
      layout={layout}
      isOpen={isOpen}
      onOpenChange={(open) => !open && close()}
      title="New canvas"
      subtitle={isKept ? 'Your current canvas stays in Recent.' : undefined}
    >
      <Form>
        <div
          role="radiogroup"
          aria-label="Preset sizes"
          onKeyDown={(event) => {
            const next = presetKeyTarget(event.key, selected);
            if (next === null) return;
            event.preventDefault();
            choose(next);
            (event.currentTarget.children[next] as HTMLElement | undefined)?.focus();
          }}
          {...stylex.props(styles.presets)}
        >
          {PRESETS.map((preset, index) => {
            const scale = 24 / Math.max(preset.width, preset.height);
            const checked = index === selected;
            return (
              <button
                key={preset.name}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={index === Math.max(0, selected) ? 0 : -1}
                onClick={() => choose(index)}
                {...stylex.props(styles.preset, checked && styles.presetChecked)}
              >
                <span aria-hidden {...stylex.props(styles.glyph)}>
                  <i
                    {...stylex.props(
                      styles.glyphShape(
                        Math.max(6, preset.width * scale),
                        Math.max(6, preset.height * scale),
                        0.25 + (0.6 * (Math.log2(preset.width) - 3)) / 6,
                      ),
                    )}
                  />
                </span>
                <span {...stylex.props(styles.presetSize)}>
                  {preset.width} × {preset.height}
                </span>
                <span {...stylex.props(styles.presetName)}>{preset.name}</span>
              </button>
            );
          })}
        </div>
        <Dimensions fields={fields} onSubmit={create} />
        <Field label="Background">
          <SegmentedControl
            label="Background"
            value={background}
            onChange={(value) => setBackground(value as Background)}
            layout="fill"
          >
            <SegmentedControlItem value="transparent" label="Transparent" />
            <SegmentedControlItem value="white" label="White" />
            <SegmentedControlItem
              value="primary"
              label="Primary"
              icon={
                <span {...stylex.props(styles.primaryChip, styles.chipColor(toCss(primary)))} />
              }
            />
          </SegmentedControl>
        </Field>
      </Form>
      <Footer
        layout={layout}
        note={
          valid
            ? `${width} × ${height}  ·  ${formatBytes(width * height * 4)}`
            : 'Choose a size up to 4096 × 4096'
        }
        action="Create"
        isDisabled={!valid}
        onAction={() => create()}
        onCancel={close}
      />
    </Surface>
  );
}

/**
 * The presets are one Tab stop, like the Background control below them. Arrows choose within
 * the three-column grid: left and right run through all six, up and down move a row.
 */
function presetKeyTarget(key: string, selected: number): number | null {
  const last = PRESETS.length - 1;
  const from = Math.max(0, selected);
  switch (key) {
    case 'ArrowLeft':
      return from === 0 ? last : from - 1;
    case 'ArrowRight':
      return from === last ? 0 : from + 1;
    case 'ArrowUp':
      return from >= 3 ? from - 3 : null;
    case 'ArrowDown':
      return from + 3 <= last ? from + 3 : null;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

const FORCED = '@media (forced-colors: active)';

const ring = `0 0 0 2px ${colorVars['--color-background-surface']}, 0 0 0 4px ${colorVars['--color-text-primary']}`;

const styles = stylex.create({
  presets: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: spacingVars['--spacing-2'],
  },
  preset: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 8,
    minHeight: 44,
    paddingTop: 10,
    paddingInline: 12,
    paddingBottom: 12,
    borderWidth: 0,
    borderRadius: 12,
    textAlign: 'left',
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    outline: {
      default: 'none',
      [FORCED]: { default: '1px solid CanvasText', ':focus-visible': '2px solid CanvasText' },
    },
    outlineOffset: { default: null, [FORCED]: { default: -1, ':focus-visible': 2 } },
    backgroundColor: colorVars['--color-background-muted'],
    boxShadow: {
      [FORCED]: 'none',
      default: `inset 0 0 0 1px ${colorVars['--color-border']}`,
      '@media (hover: hover)': {
        ':hover': `inset 0 0 0 1px ${colorVars['--color-border-emphasized']}`,
      },
      ':focus-visible': ring,
    },
    transitionProperty: 'box-shadow, background-color',
    transitionDuration: durationVars['--duration-fast'],
  },
  presetChecked: {
    backgroundColor: colorVars['--color-background-surface'],
    outline: {
      default: 'none',
      [FORCED]: { default: '2px solid Highlight', ':focus-visible': '3px solid Highlight' },
    },
    outlineOffset: { default: null, [FORCED]: { default: -2, ':focus-visible': 2 } },
    boxShadow: {
      [FORCED]: 'none',
      default: `inset 0 0 0 2px ${colorVars['--color-text-primary']}`,
      '@media (hover: hover)': {
        ':hover': `inset 0 0 0 2px ${colorVars['--color-text-primary']}`,
      },
      ':focus-visible': ring,
    },
  },
  glyph: { height: 28, display: 'flex', alignItems: 'flex-end' },
  glyphShape: (width: number, height: number, opacity: number) => ({
    display: 'block',
    width,
    height,
    opacity,
    borderRadius: 2,
    backgroundColor: { default: colorVars['--color-text-primary'], [FORCED]: 'CanvasText' },
  }),
  presetSize: { fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  presetName: { fontSize: 13, color: colorVars['--color-text-secondary'], marginTop: -6 },
  primaryChip: {
    forcedColorAdjust: 'none',
    width: 12,
    height: 12,
    borderRadius: 3,
    boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.15)',
  },
  chipColor: (css: string) => ({ backgroundColor: css }),
});
