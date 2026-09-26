import * as stylex from '@stylexjs/stylex';
import { registerTheme, ThemeContext } from '@astryxdesign/core/theme';
import type { DefinedTheme, ThemeMode } from '@astryxdesign/core/theme';
import { colorVars, typographyVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useLayoutEffect, useMemo } from 'react';
import type { ReactNode } from 'react';

/**
 * The app's root theme provider, for a theme prebuilt by `astryx theme build`.
 *
 * It does exactly what Astryx's `Theme` does for a built theme, without statically importing the
 * runtime generator (color science, scale expansion, CSS emission) that only unbuilt themes use.
 * That is about 11 KiB gzip the first paint never runs. Nested themes still use Astryx's own.
 */
export function AppTheme({
  theme,
  mode,
  children,
}: {
  theme: DefinedTheme;
  mode: ThemeMode;
  children: ReactNode;
}) {
  registerTheme(theme);

  // `<html>` carries the mode so reset.css can set `color-scheme`, and the theme name so
  // `@scope`d theme rules reach portals outside this subtree.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    root.setAttribute('data-astryx-theme', theme.name);
    return () => {
      root.removeAttribute('data-theme');
      root.removeAttribute('data-astryx-theme');
    };
  }, [mode, theme.name]);

  const value = useMemo(() => ({ theme, mode }), [theme, mode]);
  return (
    <ThemeContext value={value}>
      <div
        {...stylex.props(styles.root)}
        data-astryx-theme={theme.name}
        data-theme={mode === 'system' ? undefined : mode}
      >
        {children}
      </div>
    </ThemeContext>
  );
}

const styles = stylex.create({
  root: {
    display: 'contents',
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-body'],
  },
});
