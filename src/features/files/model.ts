/** Files' framework-free entry: the raw PNG codec, safe to import from any core (including the
 *  shared perf suite, which measures pure encode/decode cost directly rather than through the
 *  worker-offloaded `exportPng`). Everything else file-related goes through the main index. */
export { decodePng, encodePng } from './core/png';
export type { DecodedPng } from './core/png';
