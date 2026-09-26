import * as stylex from '@stylexjs/stylex';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useState } from 'react';
import { packRgba } from '../../../document';
import { toCss, TRANSPARENT } from '../../../palette';
import type { Layout } from '../../session/session';
import { useEditor, useEditorState } from '../EditorContext';
import { useFileActions } from '../files/FileActions';
import { Dimensions, Field, Footer, Form, formatBytes, sideError, Surface } from './Surface';

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
  const [width, setWidth] = useState(64);
  const [height, setHeight] = useState(64);
  const [isLinked, setLinked] = useState(true);
  const [background, setBackground] = useState<Background>('transparent');
  const valid = !sideError(width) && !sideError(height);
  const close = () => session.setPanel(null);
  const create = () => {
    const fill =
      background === 'transparent'
        ? TRANSPARENT
        : background === 'white'
          ? packRgba(255, 255, 255)
          : primary;
    files.newCanvas(width, height, fill);
    close();
  };

  return (
    <Surface
      layout={layout}
      isOpen={isOpen}
      onOpenChange={(open) => !open && close()}
      title="New canvas"
      subtitle="Your current canvas stays in Recent."
    >
      <Form>
        <div role="radiogroup" aria-label="Preset sizes" {...stylex.props(styles.presets)}>
          {PRESETS.map((preset) => {
            const scale = 24 / Math.max(preset.width, preset.height);
            const checked = preset.width === width && preset.height === height;
            return (
              <button
                key={preset.name}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => {
                  setWidth(preset.width);
                  setHeight(preset.height);
                }}
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
        <Dimensions
          width={width}
          height={height}
          onWidthChange={(value) => {
            setWidth(value);
            if (isLinked) setHeight(value);
          }}
          onHeightChange={(value) => {
            setHeight(value);
            if (isLinked) setWidth(value);
          }}
          isLinked={isLinked}
          onLinkedChange={setLinked}
        />
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
        onAction={create}
        onCancel={close}
      />
    </Surface>
  );
}

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
    outline: 'none',
    backgroundColor: colorVars['--color-background-muted'],
    boxShadow: {
      default: `inset 0 0 0 1px ${colorVars['--color-border']}`,
      ':hover': `inset 0 0 0 1px ${colorVars['--color-border-emphasized']}`,
      ':focus-visible': ring,
    },
    transitionProperty: 'box-shadow, background-color',
    transitionDuration: durationVars['--duration-fast'],
  },
  presetChecked: {
    backgroundColor: colorVars['--color-background-surface'],
    boxShadow: {
      default: `inset 0 0 0 2px ${colorVars['--color-text-primary']}`,
      ':hover': `inset 0 0 0 2px ${colorVars['--color-text-primary']}`,
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
    backgroundColor: colorVars['--color-text-primary'],
  }),
  presetSize: { fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  presetName: { fontSize: 13, color: colorVars['--color-text-secondary'], marginTop: -6 },
  primaryChip: {
    width: 12,
    height: 12,
    borderRadius: 3,
    boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.15)',
  },
  chipColor: (css: string) => ({ backgroundColor: css }),
});
