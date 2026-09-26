import { expect, test } from 'bun:test';

interface ModuleInput {
  imports: Array<{ path: string }>;
}

function forbidden(path: string): boolean {
  return (
    /(?:^|\/)node_modules\/(?:react(?:-dom)?|@stylexjs|@astryxdesign)(?:\/|$)/.test(path) ||
    /(?:^|\/)src\/features\/[^/]+\/ui\//.test(path)
  );
}

function findForbiddenChain(inputs: Record<string, ModuleInput>, entry: string): string[] | null {
  const queue: string[][] = [[entry]];
  const seen = new Set<string>();
  while (queue.length) {
    const chain = queue.shift()!;
    const current = chain.at(-1)!;
    if (forbidden(current)) return chain;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const imported of inputs[current]?.imports ?? []) {
      if (!seen.has(imported.path)) queue.push([...chain, imported.path]);
    }
  }
  return null;
}

test('purity graph check catches a UI package reached through a feature index', () => {
  const inputs = {
    'src/features/editor/core/state.ts': { imports: [{ path: 'src/features/palette/index.ts' }] },
    'src/features/palette/index.ts': { imports: [{ path: 'src/features/palette/ui/Swatch.tsx' }] },
    'src/features/palette/ui/Swatch.tsx': {
      imports: [{ path: 'node_modules/@stylexjs/stylex/lib/index.js' }],
    },
  };
  expect(findForbiddenChain(inputs, 'src/features/editor/core/state.ts')).toEqual([
    'src/features/editor/core/state.ts',
    'src/features/palette/index.ts',
    'src/features/palette/ui/Swatch.tsx',
  ]);
});

test('every feature core has no transitive React, StyleX, Astryx, or feature UI imports', async () => {
  const glob = new Bun.Glob('src/features/**/core/**/*.{ts,tsx}');
  const entrypoints = [...glob.scanSync({ cwd: process.cwd() })]
    .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
    .sort();
  expect(entrypoints.length).toBeGreaterThan(10);
  const build = await Bun.build({ entrypoints, target: 'browser', metafile: true });
  if (!build.success || !build.metafile)
    throw new Error(`Core import graph build failed: ${build.logs.map(String).join('\n')}`);
  const failures = entrypoints
    .map((entry) => findForbiddenChain(build.metafile!.inputs, entry))
    .filter((chain): chain is string[] => chain !== null);
  expect(failures.map((chain) => chain.join(' -> '))).toEqual([]);
});
