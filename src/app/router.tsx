import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { EditorShell } from '../features/editor';
import {
  createDocumentId,
  loadDocument,
  pickInitialDocumentId,
  takeHandedOffDocument,
  type DocumentStore,
} from '../features/files';
import { createBitmapDocument, type BitmapDocument } from '../features/document';

interface RouterContext {
  documentStore: DocumentStore;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: async ({ context }) => {
    const docId = await pickInitialDocumentId(context.documentStore, createDocumentId);
    throw redirect({ to: '/d/$docId', params: { docId }, replace: true });
  },
});

/** A never-saved id (a fresh document, or one navigated to directly) resolves to a blank canvas
 *  rather than a not-found error: nothing is persisted until the first edit, so this is the
 *  expected state for a brand-new document's URL. */
const documentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/d/$docId',
  staleTime: Infinity, // never revalidate a document that may be mid-edit
  gcTime: 0, // always re-read on revisit, since a document may have changed size or content elsewhere
  loader: async ({ context, params }): Promise<{ document: BitmapDocument; isNew: boolean }> => {
    // A New or Open already decoded this exact document and durably saved it this same tick, so
    // the save it just awaited makes this read-back of its own data redundant work, not a safety
    // check — skip straight to it when it's still here. A reload, back/forward, or direct URL
    // navigation never populates this (in-memory only), and loads from IndexedDB as before.
    const handedOff = takeHandedOffDocument(params.docId);
    if (handedOff) return { document: handedOff, isNew: false };
    const document = await loadDocument(context.documentStore, params.docId);
    if (document) return { document, isNew: false };
    return { document: createBitmapDocument(params.docId, 64, 64), isNew: true };
  },
  component: EditorShell,
});

export function createAppRouter(documentStore: DocumentStore) {
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, documentRoute]),
    context: { documentStore },
    // Vite's `base`: `/` locally, `/pixels/` for the GitHub Pages playground.
    basepath: import.meta.env.BASE_URL,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
