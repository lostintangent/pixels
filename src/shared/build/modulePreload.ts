import type { Plugin, ResolveModulePreloadDependenciesFn } from 'vite';

/**
 * Preload a lazy module's missing JS and CSS, omitting files the entry already imports.
 * The bundle graph is available before Vite resolves dynamic-import dependencies.
 */
export function modulePreload(): {
  plugin: Plugin;
  resolveDependencies: ResolveModulePreloadDependenciesFn;
} {
  let entryGraph: Set<string> | undefined;
  return {
    plugin: {
      name: 'entry-module-preload',
      apply: 'build',
      buildStart() {
        entryGraph = undefined;
      },
      generateBundle: {
        order: 'pre',
        handler(_options, bundle) {
          const seen = new Set<string>();
          const visit = (name: string): void => {
            if (seen.has(name)) return;
            seen.add(name);
            const chunk = bundle[name];
            if (chunk?.type === 'chunk') for (const imported of chunk.imports) visit(imported);
          };
          for (const item of Object.values(bundle)) {
            if (item.type === 'chunk' && item.isEntry) visit(item.fileName);
          }
          if (seen.size) entryGraph = seen;
        },
      },
    },
    // A missing graph retains Vite's full list, so an unexpected hook order cannot silently
    // remove a dependency. The initial-size gate will catch the resulting extra bytes.
    resolveDependencies: (filename, deps) => {
      const graph = entryGraph;
      // A failed JS modulepreload keeps WebKit's matching dynamic import failed after reconnect.
      // Let retryable editor surfaces fetch their JS through the module loader; retain CSS hints.
      const safeDeps = /(?:^|\/)(?:shapes|all|picker|surfaces)-[^/]+\.js$/.test(filename)
        ? deps.filter((dep) => !dep.endsWith('.js'))
        : deps;
      return graph ? safeDeps.filter((dep) => !graph.has(dep)) : safeDeps;
    },
  };
}
