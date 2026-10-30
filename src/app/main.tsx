import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { useAppearance } from '../features/editor';
import { router } from './router';
import { AppTheme } from './theme';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
// A plain `vite build` (perf, golden, the other production-preview harnesses) serves from `/`
// and never emits sw.js; only `build:playground`'s non-root base does. A static import would
// still ship this module's bytes in every build's initial JS even though it no-ops at runtime
// there, so this dynamic import keeps it out of the plain build's entry chunk entirely.
if (import.meta.env.BASE_URL !== '/') {
  void import('../shared/serviceWorker').then(({ registerServiceWorker }) =>
    registerServiceWorker(),
  );
}

function Root() {
  return (
    <AppTheme theme={neutralTheme} mode={useAppearance()}>
      <RouterProvider router={router} />
    </AppTheme>
  );
}
