import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { EditorShell } from '../features/editor';

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: EditorShell,
});
const documentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/d/$docId',
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
