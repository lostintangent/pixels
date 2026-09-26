import * as stylex from '@stylexjs/stylex';

/** Pixels layout tokens, layered on Astryx. Islands float over a full-bleed canvas. */
export const pixelVars = stylex.defineVars({
  /** Every island sits this far from the viewport edge. */
  edge: '12px',
  islandRadius: '14px',
  /** Islands hug their controls. */
  islandPad: '4px',
  /** Tool target: 36px for fine pointers, 44px for touch. */
  tool: '36px',
  canvasBg: 'light-dark(#e9e9ec, #141415)',
  islandShadow:
    '0 0 0 1px var(--color-border), 0 1px 2px light-dark(#0000000a, #00000066), 0 6px 20px -6px light-dark(#0000001f, #000000a0)',
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
  safeTop: 'max(env(safe-area-inset-top), 12px)',
  safeBottom: 'max(env(safe-area-inset-bottom), 12px)',
});
