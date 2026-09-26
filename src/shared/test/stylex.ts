import { mock } from 'bun:test';
import * as runtime from '@stylexjs/stylex';

/**
 * StyleX compiles its authoring calls away at build time and throws if they run.
 * Tests import UI modules without the compiler, so authoring calls return inert
 * compiled-shaped values while `props` and `attrs` keep their real runtime.
 */
const compiled = { $$css: true } as const;
const variables = (group: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(group).map((key) => [key, `var(--${key.replace(/^--/, '')})`]));
const selector = () => ':where(.stylex-test)';

void mock.module('@stylexjs/stylex', () => ({
  ...runtime,
  create: (styles: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(styles).map(([key, value]) => [
        key,
        typeof value === 'function' ? () => compiled : compiled,
      ]),
    ),
  createTheme: () => compiled,
  defineVars: variables,
  defineConsts: (group: Record<string, unknown>) => group,
  defineMarker: () => compiled,
  defaultMarker: () => compiled,
  keyframes: () => 'stylex-test-keyframes',
  positionTry: () => 'stylex-test-position',
  viewTransitionClass: () => 'stylex-test-transition',
  firstThatWorks: (...values: unknown[]) => values[0],
  when: {
    ancestor: selector,
    descendant: selector,
    siblingBefore: selector,
    siblingAfter: selector,
    anySibling: selector,
  },
}));
