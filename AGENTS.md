# Pixels engineering decisions

- Source of truth: the shared Pixels spec in the Toy Box channel. Keep features public through their `index.ts` and framework-free `core/` modules.
- Bun remains the package manager, test runner, and perf runner. Vite+ runs dev and build (`vp dev`, `vp build`) under Bun, and owns Oxlint and Oxfmt (`vp check`). A bounded Bun-native spike proved StyleX and Astryx CSS compile and live StyleX CSS reloads when the generated file enters Bun's asset graph. TanStack Router then crashed in Bun's HMR module loader on an import cycle: `Cannot read properties of null (reading 'replaceRouteChunk')`. This is [Bun issue #40378](https://github.com/oven-sh/bun/issues/40378). The required router cannot run in Bun's dev server until that is fixed. Revisit Bun-native bundling when bun#40378 closes and a browser smoke test passes with the then-current TanStack Router.
- The Vite+ StyleX plugin handles production CSS extraction. In development the HTML plugin loads `/virtual:stylex.css` and `virtual:stylex:runtime` so style edits update live.
- Performance budgets are p95 gates on deterministic fixtures. Report the machine, command, and actual measurements before changing any budget. Never widen a budget just to pass a run.

- Feature-boundary and framework-free core imports are enforced by `lint/feature-boundaries.js` through `lint.jsPlugins`. A deliberate private cross-feature import produced `error boundaries(public-feature-imports)` in `vp lint`; the import was then removed.
