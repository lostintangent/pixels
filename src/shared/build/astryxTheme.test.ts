import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { redirectUseTheme, splitUseTheme } from './astryxTheme';

const read = (path: string) =>
  readFileSync(
    new URL(`../../../node_modules/@astryxdesign/core/dist/${path}`, import.meta.url),
    'utf8',
  );
const scan = (code: string) => new Bun.Transpiler({ loader: 'js' }).scan(code);

test("useTheme's token resolver leaves the module Icon reads at first paint", () => {
  const { identity, resolver } = splitUseTheme(read('theme/useTheme.js'));
  const kept = scan(identity);
  expect(kept.exports).toEqual(expect.arrayContaining(['ThemeContext', 'useThemeName']));
  expect(kept.exports).not.toContain('useTheme');
  expect(kept.imports.map(({ path }) => path)).not.toContain('./tokens.js');

  const hook = scan(resolver);
  expect(hook.exports).toEqual(['useTheme']);
  expect(hook.imports.map(({ path }) => path)).toContain('./tokens.js');
  // Every local the hook reads comes back from the split module, which must export it.
  const shared = /import \{ ([^}]+) \} from "\.\/useTheme\.js";/.exec(resolver)![1]!.split(', ');
  expect(shared).toEqual(expect.arrayContaining(['ThemeContext', 'useRootModeAttr']));
  expect(kept.exports).toEqual(expect.arrayContaining(shared));
});

test('only useTheme is redirected, from imports and re-exports alike', () => {
  expect(redirectUseTheme(read('theme/index.js'))).toContain(
    'export { useThemeName, ThemeContext } from "./useTheme.js";\nexport { useTheme } from "./useTheme.js?resolver";',
  );
  expect(redirectUseTheme(read('hooks/useAutoMediaMode.js'))).toContain(
    'import { useTheme } from "../theme/useTheme.js?resolver";',
  );
  const icon = read('Icon/Icon.js');
  expect(redirectUseTheme(icon)).toBe(icon);
});
