import path from 'node:path';
import { definePlugin, defineRule } from 'vite-plus/lint/plugins';

function importedPath(context, node) {
  const specifier = node.source?.value;
  if (typeof specifier !== 'string') return null;
  const sourceFile = path.resolve(context.filename);
  return {
    specifier,
    sourceFile,
    target: specifier.startsWith('.') ? path.resolve(path.dirname(sourceFile), specifier) : null,
  };
}

/** `model.ts` is a feature's optional framework-free entry, so cores can import it without UI. */
const PUBLIC_ENTRIES = ['index', 'model'];

const publicFeatureImports = defineRule({
  meta: {
    messages: {
      privateImport: 'Import another feature through its public index.ts or model.ts.',
    },
  },
  create(context) {
    const check = (node) => {
      const imported = importedPath(context, node);
      if (!imported?.target) return;
      const ownFeature = imported.sourceFile.match(/\/src\/features\/([^/]+)\//)?.[1];
      const feature = imported.target.match(/\/src\/features\/([^/]+)(?:\/|$)/)?.[1];
      if (!feature || feature === ownFeature) return;
      const publicRoot = imported.target.slice(
        0,
        imported.target.indexOf(`/features/${feature}`) + `/features/${feature}`.length,
      );
      const isPublic =
        imported.target === publicRoot ||
        PUBLIC_ENTRIES.some((entry) => imported.target === `${publicRoot}/${entry}`);
      if (!isPublic) context.report({ node, messageId: 'privateImport' });
    };
    return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
  },
});

const frameworkFreeCore = defineRule({
  meta: {
    messages: {
      frameworkImport: 'Feature core must not import React, UI packages, or DOM adapters.',
    },
  },
  create(context) {
    if (!/\/src\/features\/[^/]+\/core\//.test(path.resolve(context.filename))) return {};
    const check = (node) => {
      const specifier = node.source?.value;
      if (typeof specifier !== 'string') return;
      if (/^(react(?:-dom)?(?:\/|$)|@tanstack\/|@astryxdesign\/)/.test(specifier))
        context.report({ node, messageId: 'frameworkImport' });
    };
    return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
  },
});

export default definePlugin({
  meta: { name: 'boundaries' },
  rules: {
    'public-feature-imports': publicFeatureImports,
    'framework-free-core': frameworkFreeCore,
  },
});
