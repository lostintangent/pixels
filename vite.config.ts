import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin/vite';
import { Features } from 'lightningcss';
import { astryxMessages } from './src/shared/build/astryxMessages';
import { modulePreload } from './src/shared/build/modulePreload';

const preload = modulePreload();

export default defineConfig({
  // Native modulepreload is available in every browser Pixels supports. Keep lazy dependencies
  // parallel, but avoid sending the entry's already-loaded JS paths in every preload map.
  build: {
    modulePreload: { polyfill: false, resolveDependencies: preload.resolveDependencies },
  },
  // Reachable from other devices over Tailscale. `vp preview` inherits both settings.
  server: { host: true, allowedHosts: ['.ts.net'] },
  lint: {
    plugins: ['oxc', 'typescript', 'unicorn'],
    categories: { correctness: 'warn' },
    env: { builtin: true },
    ignorePatterns: ['dist/**', 'node_modules/**', '.playwright-cli/**'],
    jsPlugins: ['./lint/feature-boundaries.js'],
    rules: {
      'boundaries/public-feature-imports': 'error',
      'boundaries/framework-free-core': 'error',
      'typescript/no-explicit-any': 'error',
    },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    singleQuote: true,
    trailingComma: 'all',
    printWidth: 100,
    sortPackageJson: false,
    ignorePatterns: ['node_modules', 'dist', '.playwright-cli', 'bun.lock'],
  },
  plugins: [
    preload.plugin,
    astryxMessages(),
    stylex({
      devMode: 'full',
      useCSSLayers: true,
      // Astryx themes already require native light-dark(); the fallback breaks custom tokens.
      lightningcssOptions: { exclude: Features.LightDark },
    }),
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
