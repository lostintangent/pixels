import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { useAppearance } from '../features/editor';
import { createDocumentStore } from '../features/files';
import { createAppRouter } from './router';
import { AppTheme } from './theme';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

/** One store for the app's lifetime; every route loader shares it via router context. */
const router = createAppRouter(createDocumentStore());

createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

function Root() {
  return (
    <AppTheme theme={neutralTheme} mode={useAppearance()}>
      <RouterProvider router={router} />
    </AppTheme>
  );
}
