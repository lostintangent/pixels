import * as stylex from '@stylexjs/stylex';
import { colorVars } from '@astryxdesign/core/theme/tokens.stylex';
import type { ReactNode, Ref } from 'react';
import { pixelVars } from './tokens.stylex';

type IslandElement = 'div' | 'header' | 'nav' | 'aside';

interface IslandProps {
  as?: IslandElement;
  axis?: 'x' | 'y';
  role?: string;
  'aria-label'?: string;
  inert?: boolean;
  xstyle?: stylex.StyleXStyles;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}

/**
 * Islands are the only chrome. They float over a full-bleed canvas, so switching
 * tools or opening panels never shifts the document.
 */
export function Island({
  as: Element = 'div',
  axis = 'x',
  xstyle,
  ref,
  children,
  ...aria
}: IslandProps) {
  return (
    <Element
      ref={ref as Ref<HTMLDivElement>}
      {...aria}
      {...stylex.props(styles.island, axis === 'y' && styles.column, xstyle)}
    >
      {children}
    </Element>
  );
}

export function IslandDivider({ axis = 'x' }: { axis?: 'x' | 'y' }) {
  return (
    <span
      aria-hidden
      {...stylex.props(styles.divider, axis === 'y' ? styles.dividerY : styles.dividerX)}
    />
  );
}

const styles = stylex.create({
  island: {
    position: 'absolute',
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: pixelVars.islandPad,
    backgroundColor: colorVars['--color-background-surface'],
    color: colorVars['--color-text-primary'],
    borderRadius: pixelVars.islandRadius,
    boxShadow: pixelVars.islandShadow,
    // Forced colors drop the shadow, which is the island's only edge.
    outline: { default: null, '@media (forced-colors: active)': '1px solid CanvasText' },
  },
  column: { flexDirection: 'column' },
  divider: { flexShrink: 0, backgroundColor: colorVars['--color-border'] },
  dividerX: { width: 1, height: 20, marginInline: 4 },
  dividerY: { height: 1, width: 20, marginBlock: 4 },
});
