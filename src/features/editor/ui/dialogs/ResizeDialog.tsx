import * as stylex from '@stylexjs/stylex';
import { colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useEffect, useState } from 'react';
import type { CanvasAnchor } from '../../../document';
import type { Layout } from '../../session/session';
import { useEditor, useEditorState } from '../EditorContext';
import { Dimensions, Field, Footer, Form, Hint, sideError, Surface } from './Surface';

const ANCHORS: readonly { anchor: CanvasAnchor; label: string }[] = [
  { anchor: 'top-left', label: 'Top left' },
  { anchor: 'top', label: 'Top' },
  { anchor: 'top-right', label: 'Top right' },
  { anchor: 'left', label: 'Left' },
  { anchor: 'center', label: 'Center' },
  { anchor: 'right', label: 'Right' },
  { anchor: 'bottom-left', label: 'Bottom left' },
  { anchor: 'bottom', label: 'Bottom' },
  { anchor: 'bottom-right', label: 'Bottom right' },
];

export function ResizeDialog({ layout }: { layout: Layout }) {
  const session = useEditor();
  const isOpen = useEditorState((state) => state.panel === 'resize');
  const current = useEditorState((state) => state.document);
  const [width, setWidth] = useState(current.width);
  const [height, setHeight] = useState(current.height);
  const [isLinked, setLinked] = useState(false);
  const [anchor, setAnchor] = useState<CanvasAnchor>('center');

  useEffect(() => {
    if (!isOpen) return;
    setWidth(current.width);
    setHeight(current.height);
  }, [isOpen, current.width, current.height]);

  const valid = !sideError(width) && !sideError(height);
  const changed = width !== current.width || height !== current.height;
  const crops = width < current.width || height < current.height;
  const close = () => session.setPanel(null);
  const resize = () => {
    session.resizeDocument(width, height, anchor);
    close();
  };

  return (
    <Surface
      layout={layout}
      isOpen={isOpen}
      onOpenChange={(open) => !open && close()}
      title="Resize canvas"
      subtitle="Changes the canvas size without scaling pixels."
      width={420}
    >
      <Form>
        <Dimensions
          width={width}
          height={height}
          onWidthChange={(value) => {
            setWidth(value);
            if (isLinked)
              setHeight(Math.max(1, Math.round((value * current.height) / current.width)));
          }}
          onHeightChange={(value) => {
            setHeight(value);
            if (isLinked)
              setWidth(Math.max(1, Math.round((value * current.width) / current.height)));
          }}
          isLinked={isLinked}
          onLinkedChange={setLinked}
        />
        <div {...stylex.props(styles.anchorRow)}>
          <Field label="Anchor">
            <AnchorPicker value={anchor} onChange={setAnchor} />
          </Field>
          <div {...stylex.props(styles.anchorHint)}>
            <Hint>
              {!changed
                ? 'Pixels stay where the anchor is. New space is transparent.'
                : crops
                  ? 'Pixels outside the new bounds will be cropped. You can undo this.'
                  : 'New space is added around the anchor and left transparent.'}
            </Hint>
          </div>
        </div>
      </Form>
      <Footer
        layout={layout}
        note={`${current.width} × ${current.height}  →  ${width || '–'} × ${height || '–'}`}
        action="Resize"
        isDisabled={!valid || !changed}
        onAction={resize}
        onCancel={close}
      />
    </Surface>
  );
}

function AnchorPicker({
  value,
  onChange,
}: {
  value: CanvasAnchor;
  onChange: (anchor: CanvasAnchor) => void;
}) {
  const index = ANCHORS.findIndex((entry) => entry.anchor === value);
  const move = (event: React.KeyboardEvent) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const row = Math.floor(index / 3);
    const next = index + delta;
    if (next < 0 || next > 8) return;
    if (Math.abs(delta) === 1 && Math.floor(next / 3) !== row) return;
    onChange(ANCHORS[next]!.anchor);
    const group = event.currentTarget as HTMLElement;
    (group.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Anchor" onKeyDown={move} {...stylex.props(styles.anchors)}>
      {ANCHORS.map((entry) => {
        const checked = entry.anchor === value;
        return (
          <button
            key={entry.anchor}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={entry.label}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(entry.anchor)}
            {...stylex.props(styles.anchor, checked && styles.anchorChecked)}
          >
            <span
              aria-hidden
              {...stylex.props(styles.anchorDot, checked && styles.anchorDotChecked)}
            />
          </button>
        );
      })}
    </div>
  );
}

const styles = stylex.create({
  anchorRow: { display: 'flex', alignItems: 'center', gap: spacingVars['--spacing-4'] },
  anchorHint: { flex: 1 },
  anchors: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 28px)',
    gap: 4,
    padding: 4,
    width: 'max-content',
    borderRadius: 10,
    backgroundColor: colorVars['--color-background-muted'],
    boxShadow: `inset 0 0 0 1px ${colorVars['--color-border']}`,
  },
  anchor: {
    width: 28,
    height: 28,
    display: 'grid',
    placeItems: 'center',
    padding: 0,
    borderWidth: 0,
    borderRadius: 6,
    cursor: 'pointer',
    outline: 'none',
    color: colorVars['--color-text-secondary'],
    backgroundColor: { default: 'transparent', ':hover': colorVars['--color-overlay-hover'] },
    boxShadow: {
      default: null,
      ':focus-visible': `0 0 0 2px ${colorVars['--color-text-primary']}`,
    },
  },
  anchorChecked: {
    color: colorVars['--color-on-accent'],
    backgroundColor: {
      default: colorVars['--color-accent'],
      ':hover': colorVars['--color-accent'],
    },
  },
  anchorDot: {
    display: 'block',
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'currentColor',
  },
  anchorDotChecked: { width: 10, height: 10, borderRadius: 3 },
});
