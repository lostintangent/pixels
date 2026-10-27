import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, '../../dist-golden-export'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
