import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

const THEME_ICONS = '/@astryxdesign/theme-neutral/dist/icons.mjs';
const DEFAULT_ICONS = '/@astryxdesign/core/dist/Icon/defaultIcons.js';
const ENTRY = /^ {2}(\w+): \/\* @__PURE__ \*\/ jsx\(\w+, \{ \.\.\.iconProps \}\),?$/gm;
// Whole-line comments only, so a string such as 'image/*' can't swallow code.
const COMMENT = /^\s*(?:\/\*[\s\S]*?\*\/|\/\/.*$)/gm;
const NAME = /\bicon[=:]\s*["'](\w+)["']|\b(?:use|get)Icon\(\s*["'](\w+)["']/g;

/**
 * The icons Astryx components in this app ask the theme for. The neutral theme registers 28
 * Lucide icons and Astryx bundles a heroicon-style fallback for each, all on the first load.
 * The build fails if a bundled module can ask for a theme icon missing from this list.
 */
export const THEME_ICON_NAMES = new Set([
  'check',
  'chevronDown',
  'chevronLeft',
  'chevronRight',
  'close',
  'info',
]);

/** Keeps only the theme icons the app uses, and drops Astryx's unused fallback set. */
export function astryxIcons(): Plugin {
  const registered = new Set<string>();
  return {
    name: 'astryx-icons',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (id.endsWith(DEFAULT_ICONS)) return { code: 'export const defaultIcons = {};', map: null };
      if (!id.endsWith(THEME_ICONS)) return null;
      const pruned = code.replace(ENTRY, (line, name: string) => {
        registered.add(name);
        return THEME_ICON_NAMES.has(name) ? line : '';
      });
      for (const name of THEME_ICON_NAMES)
        if (!registered.has(name)) this.error(`The theme no longer registers a "${name}" icon.`);
      return { code: pruned, map: null };
    },
    buildEnd(error) {
      if (error) return;
      const asked = new Set<string>();
      for (const id of this.getModuleIds()) {
        if (id.startsWith('\0') || !/\.[mc]?[jt]sx?$/.test(id.split('?')[0]!)) continue;
        const [file = id] = id.split('?');
        for (const [, a, b] of readFileSync(file, 'utf8').replace(COMMENT, '').matchAll(NAME))
          asked.add((a ?? b)!);
      }
      for (const name of asked) {
        if (registered.has(name) && !THEME_ICON_NAMES.has(name))
          this.error(`A bundled module asks for the "${name}" icon. Add it to THEME_ICON_NAMES.`);
      }
    },
  };
}
