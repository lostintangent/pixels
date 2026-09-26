import * as stylex from '@stylexjs/stylex';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { colorVars, shadowVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useSelector } from '@tanstack/react-store';
import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Layout } from '../../session/session';
import { useEditor, useEditorState } from '../EditorContext';
import { Field, Footer, Form, Surface } from './Surface';

const SCALES = [1, 2, 4, 8, 16] as const;
/** Browsers and image viewers get unreliable past this side length. */
const MAX_EXPORT_SIDE = 16384;
const PREVIEW = { width: 240, height: 120 };

export interface ExportDialogProps {
  layout: Layout;
  onExport: (fileName: string, scale: number) => void;
}

export function ExportDialog({ layout, onExport }: ExportDialogProps) {
  const session = useEditor();
  const isOpen = useEditorState((state) => state.panel === 'export');
  const documentName = useEditorState((state) => state.document.name);
  const bitmap = useSelector(session.bitmap, (document) => document);
  const [scale, setScale] = useState(8);
  const [name, setName] = useState('');
  const preview = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (isOpen) setName(documentName.toLowerCase().replace(/\s+/g, '-'));
  }, [isOpen, documentName]);

  useEffect(() => {
    const canvas = preview.current;
    if (!isOpen || !canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas
      .getContext('2d')
      ?.putImageData(new ImageData(bitmap.rgbaBytes.slice(), bitmap.width, bitmap.height), 0, 0);
    const fit = Math.max(
      1,
      Math.floor(Math.min(PREVIEW.width / bitmap.width, PREVIEW.height / bitmap.height, scale)),
    );
    canvas.style.width = `${bitmap.width * fit}px`;
    canvas.style.height = `${bitmap.height * fit}px`;
  }, [isOpen, bitmap, scale]);

  const tooLarge =
    bitmap.width * scale > MAX_EXPORT_SIDE || bitmap.height * scale > MAX_EXPORT_SIDE;
  const trimmed = name.trim();
  const close = () => session.setPanel(null);

  return (
    <Surface
      layout={layout}
      isOpen={isOpen}
      onOpenChange={(open) => !open && close()}
      title="Export PNG"
      width={420}
    >
      <Form>
        <div {...stylex.props(styles.preview)}>
          <canvas ref={preview} aria-label="Export preview" {...stylex.props(styles.canvas)} />
        </div>
        <Field label="Scale">
          <SegmentedControl
            label="Scale"
            value={String(scale)}
            onChange={(value) => setScale(Number(value))}
            layout="fill"
          >
            {SCALES.map((value) => (
              <SegmentedControlItem key={value} value={String(value)} label={`${value}×`} />
            ))}
          </SegmentedControl>
        </Field>
        <TextInput
          label="File name"
          value={name}
          onChange={setName}
          onEnter={() => trimmed && !tooLarge && onExport(`${trimmed}.png`, scale)}
          status={trimmed ? undefined : { type: 'error', message: 'Name the file' }}
          statusVariant="detached"
        />
      </Form>
      <Footer
        layout={layout}
        note={
          tooLarge
            ? `Up to ${MAX_EXPORT_SIDE} px per side. Try a smaller scale.`
            : `${bitmap.width * scale} × ${bitmap.height * scale} px`
        }
        action="Export"
        actionIcon={<Download size={16} />}
        isDisabled={!trimmed || tooLarge}
        onAction={() => onExport(`${trimmed}.png`, scale)}
        onCancel={close}
      />
    </Surface>
  );
}

const styles = stylex.create({
  preview: {
    display: 'grid',
    placeItems: 'center',
    height: 148,
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: colorVars['--color-background-muted'],
    boxShadow: `inset 0 0 0 1px ${colorVars['--color-border']}`,
  },
  canvas: {
    imageRendering: 'pixelated',
    boxShadow: shadowVars['--shadow-low'],
    backgroundImage:
      'repeating-conic-gradient(light-dark(#fff, #3a3a3c) 0 25%, light-dark(#ebebef, #313133) 0 50%)',
    backgroundSize: '8px 8px',
  },
});
