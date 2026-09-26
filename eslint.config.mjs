import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import path from 'node:path';

const boundaryPlugin = {
  rules: {
    'public-feature-imports': {
      meta: {
        type: 'problem',
        messages: { privateImport: 'Import another feature through its public index.ts.' },
      },
      create(context) {
        const sourceFile = path.resolve(context.filename);
        const ownFeature = sourceFile.match(/\/src\/features\/([^/]+)\//)?.[1];
        return {
          ImportDeclaration(node) {
            const specifier = node.source.value;
            if (typeof specifier !== 'string' || !specifier.startsWith('.')) return;
            const target = path.resolve(path.dirname(sourceFile), specifier);
            const feature = target.match(/\/src\/features\/([^/]+)(?:\/|$)/)?.[1];
            if (!feature || feature === ownFeature) return;
            const publicRoot = target.slice(
              0,
              target.indexOf(`/features/${feature}`) + `/features/${feature}`.length,
            );
            if (target !== publicRoot && target !== `${publicRoot}/index`) {
              context.report({ node, messageId: 'privateImport' });
            }
          },
        };
      },
    },
  },
};

export default [
  { ignores: ['dist/**', 'node_modules/**', '.playwright-cli/**', 'src/app/stylex.generated.css'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries: boundaryPlugin },
    rules: {
      'boundaries/public-feature-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/features/*/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['react', 'react-dom', '@tanstack/*', '@astryxdesign/*'] },
      ],
    },
  },
];
