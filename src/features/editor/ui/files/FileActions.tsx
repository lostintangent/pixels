import * as stylex from '@stylexjs/stylex';
import { colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { CircleAlert } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createBitmapDocument } from '../../../document';
import type { BitmapDocument, PackedColor } from '../../../document';
import {
  clearHandedOffDocument,
  createDocumentId,
  exportPng,
  handOffDocument,
  ImportError,
  importPng,
  normalizeDocumentName,
  renameDocument,
  SaveError,
  saveDocument,
} from '../../../files';
import type { DocumentId, DocumentStore } from '../../../files';
import { TRANSPARENT } from '../../../palette';
import { exportSizeLabel } from '../../core/exportName';
import type { EditorSession, Layout } from '../../session/session';
import { useToast } from '../toasts';
import { whenSlow } from './whenSlow';

const SLOW_EXPORT_MS = 500;

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
  /** Applies a cleaned-up name. An empty or unchanged name keeps the current one. */
  rename(input: string): void;
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
    let slow: ReturnType<typeof setTimeout> | undefined;
    const opening = (on: boolean) => session.state.setState((state) => ({ ...state, opening: on }));
    const show = (id: DocumentId) => void navigate({ to: '/d/$docId', params: { docId: id } });
    // A bad file, or a keep that ran out of room, is a small, recoverable mistake, so it gets a
    // calm toast. Red is saved for "Not saved". `ImportError` carries its own plain-sentence
    // message. `SaveError` carries only a reason — "no room" reads differently from each action
    // (New has no image to reassure anyone about; Rename has no "it" to keep), so every call site
    // below supplies its own sentence for it instead of one trying to fit every action.
    const fail = (error: unknown, fallback: string, storageFull?: string) => {
      clearTimeout(slow);
      opening(false);
      const message =
        error instanceof SaveError && storageFull
          ? storageFull
          : error instanceof ImportError
            ? error.message
            : fallback;
      showToast({
        body: <Problem>{message}</Problem>,
        autoHideDuration: 8000,
        uniqueID: 'file-error',
      });
    };
    /** An explicit New or Open is an intent to keep, so it's stored before the route reads it.
     *  The route's own loader would otherwise re-read the exact bytes already decoded right
     *  here, so this hands the live document to it directly and skips that round trip. A
     *  navigation that never lands (superseded by a second open, or a rejected `navigate`) must
     *  not leave that hand-off — potentially a large decoded image — pinned in memory, so a
     *  failed navigate clears its own entry and the opening title; a superseding one already
     *  overwrites it. */
    const keep = async (document: BitmapDocument) => {
      await saveDocument(document, store);
      handOffDocument(document);
      await navigate({ to: '/d/$docId', params: { docId: document.id } }).catch(() => {
        clearHandedOffDocument(document.id);
        clearTimeout(slow);
        opening(false);
      });
    };
    const decode = (file: Blob, name?: string) =>
      importPng(file, createDocumentId(), name ?? nameOf(file));

    /** Open and paste share this exact sentence: both are keeping an image that was never
     *  itself the problem. New and rename each need their own below, since neither has an "it"
     *  this phrasing would refer to. */
    const noRoomForImage =
      'This image is fine, but there’s no room to keep it. Free up some space and try again.';

    /** A big image takes a moment. An open under 150 ms lands before the title would change. */
    const openFile = (file: Blob, name?: string) => {
      slow = setTimeout(opening, 150, true);
      decode(file, name)
        .then(keep)
        .catch((error: unknown) => fail(error, 'This file couldn’t be opened.', noRoomForImage));
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
        const document = createBitmapDocument(createDocumentId(), width, height);
        if (background !== TRANSPARENT) document.pixels.fill(background);
        keep(document).catch((error: unknown) =>
          fail(
            error,
            'The new canvas couldn’t be saved.',
            'There’s no room for a new canvas. Free up some space and try again.',
          ),
        );
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
          .catch((error: unknown) => fail(error, 'This image couldn’t be pasted.', noRoomForImage));
      },
      openRecent: show,
      exportPng(fileName, scale) {
        session.commitFloatingSelection();
        const document = session.bitmap.state;
        const size = exportSizeLabel(document.width, document.height, scale);
        // Most exports finish well under half a second and show nothing. A large one says what
        // it's making until the bytes arrive, then gets out of the way of the download or share
        // sheet. The encoder can't be cancelled yet, so the notice offers no Cancel.
        whenSlow(
          exportPng(document, { scale }),
          () => showToast({ body: `Exporting ${size}…`, isAutoHide: false }),
          SLOW_EXPORT_MS,
        )
          .then((bytes) => deliver(new File([bytes as BlobPart], fileName, { type: 'image/png' })))
          .catch((error: unknown) => fail(error, 'The PNG couldn’t be exported.'));
      },
      rename(input) {
        const name = normalizeDocumentName(input);
        const document = session.bitmap.state;
        if (!name || name === document.name) return;
        session.rename(name);
        // A blank canvas that was never edited isn't stored yet. Naming it keeps it.
        const isStored = session.state.state.save !== null;
        if (!isStored) session.setSaveStatus('saving');
        renameDocument(document, name, store, isStored).then(
          () => {
            if (!isStored) session.setSaveStatus('saved');
          },
          (error: unknown) => {
            if (!isStored) session.setSaveStatus('error');
            fail(
              error,
              'The new name couldn’t be saved.',
              'There’s no room to save the new name. Free up some space and try again.',
            );
          },
        );
      },
    };
  }, [session, store, layout, navigate, showToast]);

  return <FileActionsContext.Provider value={actions}>{children}</FileActionsContext.Provider>;
}

function nameOf(file: Blob): string {
  const name = file instanceof File ? file.name.replace(/\.png$/i, '').trim() : '';
  return name || 'Untitled';
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <span {...stylex.props(styles.problem)}>
      <CircleAlert size={16} strokeWidth={2} aria-hidden {...stylex.props(styles.glyph)} />
      {children}
    </span>
  );
}

const styles = stylex.create({
  problem: { display: 'flex', alignItems: 'flex-start', gap: spacingVars['--spacing-2'] },
  glyph: { flexShrink: 0, marginBlockStart: 2, color: colorVars['--color-error'] },
});
