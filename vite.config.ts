import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin/vite';
import { astryxIcons } from './src/shared/build/astryxIcons.ts';
import { astryxMessages } from './src/shared/build/astryxMessages.ts';
import { modulePreload } from './src/shared/build/modulePreload.ts';
import { stylexOptions } from './src/shared/build/stylexOptions.ts';

const preload = modulePreload();

export default defineConfig({
  // Native modulepreload is available in every browser Pixels supports. Keep lazy dependencies
  // parallel, but avoid sending the entry's already-loaded JS paths in every preload map.
  build: {
    // The folded entry is ~520 kB minified; perf:app gates its actual 170 KiB gzip cost.
    chunkSizeWarningLimit: 550,
    modulePreload: { polyfill: false, resolveDependencies: preload.resolveDependencies },
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: 'initial', tags: ['$initial'] }] },
      },
    },
  },
  // Reachable from other devices over Tailscale. `vite preview` inherits both settings.
  server: { host: true, allowedHosts: ['.ts.net'] },
  plugins: [
    preload.plugin,
    astryxMessages(),
    astryxIcons(),
    stylex(stylexOptions),
    react(),
    {
      name: 'stylex-dev-html',
      transformIndexHtml(_html, context) {
        if (!context.server) return [];
        return [
          {
            tag: 'link',
            attrs: { rel: 'stylesheet', href: '/virtual:stylex.css' },
            injectTo: 'head' as const,
          },
          {
            tag: 'script',
            attrs: { type: 'module', src: '/@id/virtual:stylex:runtime' },
            injectTo: 'head' as const,
          },
        ];
      },
    },
  ],
});
