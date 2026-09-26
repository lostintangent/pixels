import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { EditorShell } from '../features/editor';
import { createDocumentStore, loadDocument, loadMostRecentOrNew } from '../features/files';
import { createBitmapDocument, type BitmapDocument } from '../features/document';

/** One store for the app's lifetime; every route loader below shares it. */
const documentStore = createDocumentStore();

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: async () => {
    const { document } = await loadMostRecentOrNew(documentStore, () => crypto.randomUUID());
    throw redirect({ to: '/d/$docId', params: { docId: document.id }, replace: true });
  },
});

/** A never-saved id (a fresh document, or one navigated to directly) resolves to a blank canvas
 *  rather than a not-found error: nothing is persisted until the first edit, so this is the
 *  expected state for a brand-new document's URL. */
const documentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/d/$docId',
  staleTime: Infinity, // never revalidate a document that may be mid-edit
  loader: async ({ params }): Promise<{ document: BitmapDocument; isNew: boolean }> => {
    const document = await loadDocument(documentStore, params.docId);
    if (document) return { document, isNew: false };
    return { document: createBitmapDocument(params.docId, 64, 64), isNew: true };
  },
  component: EditorShell,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, documentRoute]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export { documentStore };
