import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin/vite';

export default defineConfig({
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
