import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { isSimpleMessage } from './messageFormat.ts';

const CATALOG_ID = '\0astryx-en-catalog';
const PLACEHOLDER = /(["'`])__ASTRYX_EN_CATALOG__\1/;
const KEY = /["'`](@astryx\.[\w.]+)["'`]/g;
const ASTRYX = '/@astryxdesign/core/dist/';
const FORMATTER = fileURLToPath(new URL('./messageFormat.ts', import.meta.url));

type Catalog = Record<string, { defaultMessage: string }>;

/**
 * Astryx ships its whole English catalog (about 1,100 messages) and `intl-messageformat`
 * with every component. This keeps only the messages the bundled components can ask for,
 * and swaps in a formatter sized to them.
 */
export function astryxMessages(): Plugin {
  let catalogPath = '';
  return {
    name: 'astryx-messages',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer?.includes(`${ASTRYX}i18n/`)) return null;
      if (source.endsWith('/locales/en.json')) {
        catalogPath = resolve(dirname(importer), source);
        return CATALOG_ID;
      }
      return source === 'intl-messageformat' ? FORMATTER : null;
    },
    load(id) {
      return id === CATALOG_ID ? 'export default JSON.parse("__ASTRYX_EN_CATALOG__");' : null;
    },
    renderChunk(code) {
      const placeholder = PLACEHOLDER.exec(code);
      if (!placeholder) return null;
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;
      const used: Catalog = {};
      for (const id of this.getModuleIds()) {
        if (!id.includes(ASTRYX)) continue;
        const [file = id] = id.split('?');
        for (const [, key = ''] of readFileSync(file, 'utf8').matchAll(KEY)) {
          const message = catalog[key]?.defaultMessage;
          if (message === undefined) continue;
          if (!isSimpleMessage(message))
            this.error(`${key} needs ICU features the lean formatter lacks: "${message}"`);
          used[key] = { defaultMessage: message };
        }
      }
      const literal = JSON.stringify(JSON.stringify(used));
      const at = placeholder.index;
      return {
        code: code.slice(0, at) + literal + code.slice(at + placeholder[0].length),
        map: null,
      };
    },
  };
}
