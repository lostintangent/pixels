import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { EditorShell, RouteError } from '../features/editor';
import {
  createDocumentId,
  createDocumentStore,
  loadDocument,
  pickInitialDocumentId,
  takeHandedOffDocument,
  type DocumentStore,
} from '../features/files';
import { createBitmapDocument } from '../features/document';

const rootRoute = createRootRouteWithContext<{ documentStore: DocumentStore }>()();

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: async ({ context }) => {
    const docId = await pickInitialDocumentId(context.documentStore, createDocumentId);
    throw redirect({ to: '/d/$docId', params: { docId }, replace: true });
  },
});

const documentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/d/$docId',
  staleTime: Infinity, // never revalidate a document that may be mid-edit
  gcTime: 0, // always re-read on revisit, since a document may have changed size or content elsewhere
  loader: async ({ context, params }) => {
    // New and Open hand over the document they just saved, so skip reading it back.
    const handedOff = takeHandedOffDocument(params.docId);
    if (handedOff) return { document: handedOff, isNew: false };
    const document = await loadDocument(context.documentStore, params.docId);
    if (document) return { document, isNew: false };
    // Nothing is saved until the first edit, so an unknown id is a blank canvas, not a 404.
    return { document: createBitmapDocument(params.docId, 64, 64), isNew: true };
  },
  component: EditorShell,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, documentRoute]),
  context: { documentStore: createDocumentStore() },
  defaultErrorComponent: RouteError,
  // Vite's `base`: `/` locally, `/pixels/` for the GitHub Pages playground.
  basepath: import.meta.env.BASE_URL,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
