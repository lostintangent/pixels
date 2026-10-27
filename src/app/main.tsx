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

function Root() {
  return (
    <AppTheme theme={neutralTheme} mode={useAppearance()}>
      <RouterProvider router={router} />
    </AppTheme>
  );
}
