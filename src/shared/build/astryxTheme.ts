import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

const USE_THEME = '/@astryxdesign/core/dist/theme/useTheme.js';
const CORE = '/@astryxdesign/core/dist/';
const RESOLVER = '?resolver';
const HOOK = 'export function useTheme() {';
const TOKENS = 'import { resolveThemeTokens } from "./tokens.js";';
const IMPORT = /^import [^;]+;$/gm;
const DECLARATION = /^(export )?(?:function|const|let|var|class) (\w+)/gm;
const REFERENCE = /(?:import|export) \{([^}]*)\} from "((?:\.\.?\/)+(?:theme\/)?useTheme\.js)";/g;

/**
 * Astryx's `useTheme.js` holds both `useThemeName`, which every Icon calls at first paint, and
 * `useTheme()`, which resolves every token to a raw value and so imports the token resolver, the
 * color parser, and every default token, chart and syntax colors included. Only lazy surfaces
 * call `useTheme()`. Splitting the hook into its own module lets those imports leave the entry.
 *
 * Returns the module without the hook, which exports the locals the hook reads, and the hook's
 * own module, which imports them back. Throws when the source no longer has the expected shape.
 */
export function splitUseTheme(code: string): { identity: string; resolver: string } {
  const start = code.indexOf(HOOK);
  if (start < 0) throw new Error('useTheme.js no longer declares `export function useTheme() {`.');
  const end = code.indexOf('\n}', start) + 2;
  if (end < 2) throw new Error('useTheme.js: `useTheme` has no closing brace at column 0.');
  if (!code.includes(TOKENS)) throw new Error(`useTheme.js no longer has \`${TOKENS}\`.`);

  const hook = code.slice(start, end);
  const identity = (code.slice(0, start) + code.slice(end)).replace(TOKENS, '');
  if (/\bresolveThemeTokens\b/.test(identity))
    throw new Error('useTheme.js reads resolveThemeTokens outside `useTheme`.');

  const locals = Array.from(identity.matchAll(DECLARATION), ([, exported, name]) => ({
    name: name!,
    exported: Boolean(exported),
  })).filter(({ name }) => new RegExp(`\\b${name}\\b`).test(hook));
  const shared = locals.map(({ name }) => name);
  const unexported = locals.filter(({ exported }) => !exported).map(({ name }) => name);
  return {
    identity: unexported.length ? `${identity}\nexport { ${unexported.join(', ')} };\n` : identity,
    resolver: [
      ...Array.from(code.matchAll(IMPORT), ([line]) => line),
      `import { ${shared.join(', ')} } from "./useTheme.js";`,
      hook,
    ].join('\n'),
  };
}

/**
 * Points every import or re-export of `useTheme` from `useTheme.js` at the split hook, keeping
 * the module's other names where they were.
 */
export function redirectUseTheme(code: string): string {
  return code.replace(REFERENCE, (statement, list: string, path: string) => {
    const names = list.split(',').map((name) => name.trim());
    if (!names.includes('useTheme')) return statement;
    const keyword = statement.startsWith('import') ? 'import' : 'export';
    const rest = names.filter((name) => name && name !== 'useTheme');
    const hook = `${keyword} { useTheme } from "${path}${RESOLVER}";`;
    return rest.length ? `${keyword} { ${rest.join(', ')} } from "${path}";\n${hook}` : hook;
  });
}

/**
 * Moves Astryx's `useTheme()` and everything only it imports out of the first load. A missed
 * importer fails the build, because the split `useTheme.js` no longer exports the hook.
 */
export function astryxTheme(): Plugin {
  return {
    name: 'astryx-theme',
    apply: 'build',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith(USE_THEME + RESOLVER)) return null;
      const source = await readFile(id.slice(0, -RESOLVER.length), 'utf8');
      return { code: splitUseTheme(source).resolver, map: null };
    },
    transform(code, id) {
      if (id.endsWith(USE_THEME)) {
        try {
          return { code: splitUseTheme(code).identity, map: null };
        } catch (error) {
          this.error(error instanceof Error ? error.message : String(error));
        }
      }
      if (!id.includes(CORE) || !code.includes('useTheme.js"')) return null;
      const redirected = redirectUseTheme(code);
      return redirected === code ? null : { code: redirected, map: null };
    },
  };
}
