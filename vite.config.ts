import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin/vite';

export default defineConfig({
  plugins: [
    stylex({ devMode: 'full', useCSSLayers: true }),
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
