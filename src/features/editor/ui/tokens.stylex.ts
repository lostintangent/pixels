import * as stylex from '@stylexjs/stylex';

// Width picks the layout. The pointer picks target size, so a tablet keeps desktop chrome with
// touch-sized targets. StyleX resolves media queries at compile time, so files that need one
// declare it locally.
const COARSE = '@media (pointer: coarse)';

/** Pixels layout tokens, layered on Astryx. Islands float over a full-bleed canvas. */
export const pixelVars = stylex.defineVars({
  /** Every island sits this far from the viewport edge. */
  edge: '12px',
  islandRadius: '14px',
  /** Islands hug their controls. */
  islandPad: '4px',
  /** Tool target: 36px for a fine pointer, 44px for any coarse one, whatever the layout. */
  tool: { default: '36px', [COARSE]: '44px' },
  canvasBg: 'light-dark(#e9e9ec, #141415)',
  islandShadow:
    '0 0 0 1px var(--color-border), 0 1px 2px light-dark(#0000000a, #00000066), 0 6px 20px -6px light-dark(#0000001f, #000000a0)',
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
  safeTop: 'max(env(safe-area-inset-top), 12px)',
  safeBottom: 'max(env(safe-area-inset-bottom), 12px)',
  /** A landscape phone's notch and rounded corners sit on a side. */
  safeLeft: 'max(env(safe-area-inset-left), 12px)',
  safeRight: 'max(env(safe-area-inset-right), 12px)',
});
