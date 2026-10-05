import { Features } from 'lightningcss';

/**
 * The StyleX options the app builds with, shared with `astryxClasses.test.ts` so the guard compiles
 * exactly what ships.
 *
 * Astryx ships StyleX output precompiled with StyleX's default `x` class prefix, and its CSS
 * shares the page with ours. Atomic class names hash only the property and value, so the same
 * `x…` class in our later `priority` layers would override the conditional states Astryx
 * attaches to that class, such as a menu item's focus background. A prefix of our own keeps the
 * two sets disjoint.
 */
export const stylexOptions = {
  devMode: 'full',
  classNamePrefix: 'p',
  useCSSLayers: true,
  // Astryx themes already require native light-dark(); the fallback breaks custom tokens.
  lightningcssOptions: { exclude: Features.LightDark },
} as const;
