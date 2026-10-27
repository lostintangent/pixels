import * as stylex from '@stylexjs/stylex';
import { SegmentedControl } from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { colorVars, shadowVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useSelector } from '@tanstack/react-store';
import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { findAnnotationsFor } from '../../../annotations/model';
import type { BitmapDocument } from '../../../document';
import { exportFileName, exportSizeLabel } from '../../core/exportName';
import type { Layout } from '../../session/session';
import { useEditor, useEditorState } from '../EditorContext';
import type { PreviewRequest, PreviewResponse } from './previewWorker';
import { Field, Footer, Form, Segment, Surface } from './Surface';

const SCALES = [1, 2, 4, 8, 16] as const;
const LARGEST_FIRST = [...SCALES].reverse();
/** Browsers and image viewers get unreliable past this side length. */
const MAX_EXPORT_SIDE = 16384;
/** Sprites default to the largest scale that keeps the long side within this. Images get 1×. */
const DEFAULT_EXPORT_SIDE = 1024;
const PREVIEW_INSET = 12;

const fits = (document: BitmapDocument, scale: number, side: number) =>
  Math.max(document.width, document.height) * scale <= side;

/** The chosen scale, or the largest allowed one below it. 1× always fits a document. */
function allowedScale(document: BitmapDocument, scale: number): number {
  return (
    LARGEST_FIRST.find((value) => value <= scale && fits(document, value, MAX_EXPORT_SIDE)) ?? 1
  );
}

function defaultScale(document: BitmapDocument): number {
  return allowedScale(
    document,
    LARGEST_FIRST.find((value) => value <= 8 && fits(document, value, DEFAULT_EXPORT_SIDE)) ?? 1,
  );
}

interface PreviewFit {
  width: number;
  height: number;
  /** Device pixels the worker renders. For a smooth (shrinking) fit this stays at or below the
   *  document; for a pixelated (upscaling) fit it's the full zoomed-and-DPR device resolution, so
   *  shapes rasterize directly at that resolution instead of being upscaled afterward. */
  target: { width: number; height: number };
  pixelated: boolean;
}

/** Whole-number zoom up to the export scale when the image fits, otherwise a smooth fit. */
function fitPreview(
  document: BitmapDocument,
  room: { width: number; height: number },
  scale: number,
  dpr: number,
): PreviewFit {
  const { width, height } = document;
  const fit = Math.min(
    (room.width - 2 * PREVIEW_INSET) / width,
    (room.height - 2 * PREVIEW_INSET) / height,
  );
  if (fit >= 1) {
    const zoom = Math.min(Math.floor(fit), scale);
    return {
      width: width * zoom,
      height: height * zoom,
      target: {
        width: Math.max(1, Math.round(width * zoom * dpr)),
        height: Math.max(1, Math.round(height * zoom * dpr)),
      },
      pixelated: true,
    };
  }
  const css = { width: Math.max(1, width * fit), height: Math.max(1, height * fit) };
  return {
    ...css,
    target: {
      width: Math.min(width, Math.max(1, Math.round(css.width * dpr))),
      height: Math.min(height, Math.max(1, Math.round(css.height * dpr))),
    },
    pixelated: false,
  };
}

interface ExportDialogProps {
  layout: Layout;
  onExport: (fileName: string, scale: number) => void;
}

let worker: Worker | undefined;
let lastRequest = 0;

function createPreviewWorker(): Worker {
  const created = new Worker(new URL('./previewWorker.ts', import.meta.url), { type: 'module' });
  created.addEventListener('error', () => {
    // A script-load failure (a flaky network, or a server restart that changed chunk hashes
    // under an open tab) can never recover on this worker: it won't deliver a message for the
    // in-flight request, or any future one, so the preview would stay blank for the rest of the
    // session if this cache weren't cleared. Terminating it and dropping the cache here means the
    // next `renderPreview` call creates a fresh worker instead of reusing a dead one — the same
    // fix as `pngWorkerClient.ts`'s own cached client.
    created.terminate();
    if (worker === created) worker = undefined;
  });
  return created;
}

/** Renders the preview off the main thread, so a 4096² document opens the dialog without jank. */
function renderPreview(
  document: BitmapDocument,
  target: PreviewFit['target'],
  pixelated: boolean,
  onImage: (image: ImageBitmap) => void,
): () => void {
  worker ??= createPreviewWorker();
  // Captured once per call rather than read through the mutable module-level `worker` binding
  // below, so a fatal error that rotates in a fresh worker before this request's own message (or
  // the returned cleanup) runs can never add or remove a listener on the wrong instance.
  const activeWorker = worker;
  const id = ++lastRequest;
  const rgba = document.rgbaBytes.slice().buffer;
  const request: PreviewRequest = {
    id,
    width: document.width,
    height: document.height,
    colorSpace: document.colorSpace,
    rgba,
    shapes: findAnnotationsFor(document)?.snapshot() ?? [],
    target,
    pixelated,
  };
  const receive = ({ data }: MessageEvent<PreviewResponse>) => {
    if (data.id !== id) return;
    activeWorker.removeEventListener('message', receive);
    onImage(data.image);
  };
  activeWorker.addEventListener('message', receive);
  activeWorker.postMessage(request, [rgba]);
  return () => activeWorker.removeEventListener('message', receive);
}

export function ExportDialog({ layout, onExport }: ExportDialogProps) {
  const session = useEditor();
  const isOpen = useEditorState((state) => state.panel === 'export');
  const documentName = useEditorState((state) => state.document.name);
  const bitmap = useSelector(session.bitmap, (document) => document);
  const [choice, setChoice] = useState<{ document: BitmapDocument; scale: number }>();
  const scale = allowedScale(
    bitmap,
    choice?.document === bitmap ? choice.scale : defaultScale(bitmap),
  );
  // The field opens on the document's current name. Setting it here, during the render that
  // opens the dialog, rather than in an effect, means no commit ever shows an empty field, which
  // would push "Name the file" into the assertive live region on every open.
  const [name, setName] = useState(documentName);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setName(documentName);
  }
  const room = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const [fit, setFit] = useState<{ document: BitmapDocument; room: PreviewFit['target'] }>();

  useEffect(() => {
    const host = room.current;
    if (!isOpen || !host) return;
    // Layout size, not the bounding box, which the dialog's entrance transform scales. A phone
    // turned sideways while the sheet is open gives the preview a different room.
    const measure = () =>
      setFit({ document: bitmap, room: { width: host.clientWidth, height: host.clientHeight } });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [isOpen, bitmap]);

  const layoutFit = fit?.document === bitmap ? fit : undefined;
  const shown =
    layoutFit && fitPreview(bitmap, layoutFit.room, scale, globalThis.devicePixelRatio || 1);
  const targetWidth = shown?.target.width;
  const targetHeight = shown?.target.height;
  const pixelated = shown?.pixelated ?? false;

  useEffect(() => {
    const canvas = preview.current;
    if (!isOpen || !canvas || !targetWidth || !targetHeight) return;
    return renderPreview(
      bitmap,
      { width: targetWidth, height: targetHeight },
      pixelated,
      (image) => {
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext('2d', { colorSpace: bitmap.colorSpace })?.drawImage(image, 0, 0);
        image.close();
      },
    );
  }, [isOpen, bitmap, targetWidth, targetHeight, pixelated]);

  const fileName = exportFileName(name);
  const close = () => session.setPanel(null);
  // Return closes the dialog and hands focus back to its opener, which may be the Document menu
  // button. Without preventDefault, the same keypress would then click that button open.
  const exportOnReturn = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || !fileName) return;
    event.preventDefault();
    onExport(fileName, scale);
  };

  return (
    <Surface
      layout={layout}
      isOpen={isOpen}
      onOpenChange={(open) => !open && close()}
      title="Export PNG"
      width={420}
    >
      <Form>
        <div ref={room} {...stylex.props(styles.preview)}>
          {shown && (
            // A context's color space is fixed, so a document in another space gets a new canvas.
            <canvas
              key={`${bitmap.colorSpace}`}
              ref={preview}
              aria-label="Export preview"
              {...stylex.props(
                styles.canvas,
                shown.pixelated && styles.pixelated,
                styles.size(shown.width, shown.height),
              )}
            />
          )}
        </div>
        <Field label="Scale">
          <SegmentedControl
            label="Scale"
            value={String(scale)}
            onChange={(value) => setChoice({ document: bitmap, scale: Number(value) })}
            layout="fill"
          >
            {SCALES.map((value) => (
              <Segment
                key={value}
                value={String(value)}
                label={`${value}×`}
                isDisabled={!fits(bitmap, value, MAX_EXPORT_SIDE)}
              />
            ))}
          </SegmentedControl>
        </Field>
        <TextInput
          label="File name"
          value={name}
          onChange={setName}
          onKeyDown={exportOnReturn}
          status={fileName ? undefined : { type: 'error', message: 'Name the file' }}
          statusVariant="detached"
        />
      </Form>
      <Footer
        layout={layout}
        note={exportSizeLabel(bitmap.width, bitmap.height, scale)}
        action="Export"
        actionIcon={<Download size={16} />}
        isDisabled={!fileName}
        onAction={() => fileName && onExport(fileName, scale)}
        onCancel={close}
      />
    </Surface>
  );
}

const SIDEWAYS = '@media (orientation: landscape) and (max-height: 539px)';

const styles = stylex.create({
  preview: {
    display: 'grid',
    placeItems: 'center',
    // A sideways phone's sheet is short, so the preview gives up height before the fields do.
    height: { default: 176, [SIDEWAYS]: 112 },
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: colorVars['--color-background-muted'],
    boxShadow: `inset 0 0 0 1px ${colorVars['--color-border']}`,
  },
  canvas: {
    boxShadow: shadowVars['--shadow-low'],
    backgroundImage:
      'repeating-conic-gradient(light-dark(#fff, #3a3a3c) 0 25%, light-dark(#ebebef, #313133) 0 50%)',
    backgroundSize: '8px 8px',
  },
  pixelated: {
    imageRendering: 'pixelated',
  },
  size: (width: number, height: number) => ({ width, height }),
});
