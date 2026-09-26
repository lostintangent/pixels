import { useToast } from '@astryxdesign/core/Toast';
import { useNavigate } from '@tanstack/react-router';
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createBitmapDocument } from '../../../document';
import type { BitmapDocument, PackedColor } from '../../../document';
import { exportPng, ImportError, importPng, saveDocument } from '../../../files';
import type { DocumentId, DocumentStore } from '../../../files';
import { TRANSPARENT } from '../../../palette';
import type { EditorSession, Layout } from '../../session/session';

/** Everything the chrome can do with files. Failures surface as toasts, never as throws. */
export interface FileActions {
  readonly store: DocumentStore;
  newCanvas(width: number, height: number, background: PackedColor): void;
  /** Shows the system file picker and opens the chosen PNG as a new canvas. */
  pickFile(): void;
  openFile(file: Blob, name?: string): void;
  /** Pastes an outside image into this canvas, or opens it as a new one when it won't fit. */
  pasteFile(file: Blob): void;
  openRecent(id: DocumentId): void;
  exportPng(fileName: string, scale: number): void;
}

const FileActionsContext = createContext<FileActions | null>(null);

export function useFileActions(): FileActions {
  const actions = useContext(FileActionsContext);
  if (!actions) throw new Error('useFileActions needs a FileActionsProvider');
  return actions;
}

export function FileActionsProvider({
  session,
  store,
  layout,
  children,
}: {
  session: EditorSession;
  store: DocumentStore;
  layout: Layout;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const showToast = useToast();

  const actions = useMemo<FileActions>(() => {
    const show = (id: DocumentId) => void navigate({ to: '/d/$docId', params: { docId: id } });
    const fail = (error: unknown, fallback: string) =>
      showToast({
        type: 'error',
        body: error instanceof ImportError ? error.message : fallback,
        uniqueID: 'file-error',
      });
    /** An explicit New or Open is an intent to keep, so it's stored before the route reads it. */
    const keep = async (document: BitmapDocument) => {
      await saveDocument(document, store);
      show(document.id);
    };
    const decode = (file: Blob, name?: string) =>
      importPng(file, crypto.randomUUID(), name ?? nameOf(file));

    const openFile = (file: Blob, name?: string) => {
      decode(file, name)
        .then(keep)
        .catch((error: unknown) => fail(error, 'This file couldn’t be opened.'));
    };

    /** On a phone, the share sheet is how an image reaches Photos. Elsewhere it downloads. */
    const deliver = async (file: File) => {
      if (layout === 'phone' && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
        }
      }
      const url = URL.createObjectURL(file);
      const link = globalThis.document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    };

    return {
      store,
      newCanvas(width, height, background) {
        const document = createBitmapDocument(crypto.randomUUID(), width, height);
        if (background !== TRANSPARENT) document.pixels.fill(background);
        keep(document).catch((error: unknown) => fail(error, 'The new canvas couldn’t be saved.'));
      },
      pickFile() {
        const input = globalThis.document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png';
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          if (file) openFile(file);
        });
        input.click();
      },
      openFile,
      pasteFile(file) {
        decode(file, 'Pasted image')
          .then(async (image) => {
            if (session.place(image)) return;
            await keep(image);
            showToast({ body: `Opened as a new ${image.width} × ${image.height} canvas.` });
          })
          .catch((error: unknown) => fail(error, 'This image couldn’t be pasted.'));
      },
      openRecent: show,
      exportPng(fileName, scale) {
        exportPng(session.bitmap.state, { scale })
          .then((bytes) => deliver(new File([bytes as BlobPart], fileName, { type: 'image/png' })))
          .catch((error: unknown) => fail(error, 'The PNG couldn’t be exported.'));
      },
    };
  }, [session, store, layout, navigate, showToast]);

  return <FileActionsContext.Provider value={actions}>{children}</FileActionsContext.Provider>;
}

function nameOf(file: Blob): string {
  const name = file instanceof File ? file.name.replace(/\.png$/i, '').trim() : '';
  return name || 'Untitled';
}
