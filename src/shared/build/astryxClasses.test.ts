import { expect, test } from 'bun:test';
import stylex from '@stylexjs/unplugin/vite';
import { dirname, join, resolve } from 'node:path';
import { stylexOptions } from './stylexOptions';

const ROOT = resolve(import.meta.dir, '../../..');

interface StylexPlugin {
  transform(this: unknown, code: string, id: string): Promise<unknown>;
  __stylexGetSharedStore(): { rulesById: Map<string, [string, ...unknown[]][]> };
}

/** Every class our sources generate, compiled by the plugin and options the build uses. */
async function appClasses(): Promise<Map<string, string>> {
  const prefix = process.env.PIXELS_STYLEX_PREFIX ?? stylexOptions.classNamePrefix;
  const plugin = stylex({ ...stylexOptions, classNamePrefix: prefix }) as unknown as StylexPlugin;
  const classes = new Map<string, string>();
  for await (const file of new Bun.Glob('src/**/*.{ts,tsx}').scan({ cwd: ROOT })) {
    if (file.endsWith('.test.ts')) continue;
    const id = join(ROOT, file);
    const code = await Bun.file(id).text();
    if (!code.includes('@stylexjs/stylex')) continue;
    await plugin.transform.call({}, code, id);
    for (const [name] of plugin.__stylexGetSharedStore().rulesById.get(id) ?? []) {
      classes.set(name, file);
    }
  }
  return classes;
}

/** Class selectors in a stylesheet and every stylesheet it `@import`s. */
async function importedClasses(entry: string, seen = new Set<string>()): Promise<Set<string>> {
  const classes = new Set<string>();
  if (seen.has(entry)) return classes;
  seen.add(entry);
  const css = await Bun.file(entry).text();
  for (const [, spec = ''] of css.matchAll(/@import\s+['"]([^'"]+)['"]/g)) {
    const path = spec.startsWith('.') ? resolve(dirname(entry), spec) : Bun.resolveSync(spec, ROOT);
    for (const name of await importedClasses(path, seen)) classes.add(name);
  }
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '');
  for (const [, name = ''] of rules.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(name);
  return classes;
}

// Atomic classes hash only the property and value, so a name we share with Astryx would carry
// our base declaration in a later layer and drop the states Astryx attaches to it. See AGENTS.md.
// `PIXELS_STYLEX_PREFIX=x bun test src/shared/build/astryxClasses.test.ts` shows the old clash.
test("no StyleX class of ours shares a name with Astryx's precompiled CSS", async () => {
  const ours = await appClasses();
  const theirs = await importedClasses(join(ROOT, 'src/app/global.css'));
  expect(ours.size).toBeGreaterThan(100);
  expect(theirs.size).toBeGreaterThan(1000);
  const shared = [...ours].filter(([name]) => theirs.has(name));
  if (shared.length > 0) {
    const sample = shared.slice(0, 8).map(([name, file]) => `${name} (${file})`);
    throw new Error(
      `${shared.length} of our ${ours.size} StyleX classes share a name with Astryx's CSS, ` +
        `which drops Astryx's states on them. Keep \`classNamePrefix\` distinct from Astryx's ` +
        `\`x\`. First few: ${sample.join(', ')}`,
    );
  }
}, 30_000);
