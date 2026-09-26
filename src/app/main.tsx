import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { router } from './router';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <React.StrictMode>
    <Theme theme={neutralTheme}>
      <RouterProvider router={router} />
    </Theme>
  </React.StrictMode>,
);
