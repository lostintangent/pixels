import { expect, test } from 'bun:test';
import stylex from '@stylexjs/unplugin/vite';

type Transform = (this: unknown, code: string, id: string) => Promise<unknown>;

const source = `import * as stylex from '@stylexjs/stylex';
export const styles = stylex.create({
  target: {
    width: { default: 36, '@media (pointer: coarse)': 44 },
    color: { default: 'red', '@media (hover: hover)': { ':hover': 'blue' } },
  },
});`;

// Bun's optimizing JIT miscompiles the tokenizer's end-of-input check inside StyleX, so
// unpatched dev servers reject valid media queries after about 30 files. See AGENTS.md.
// This checks correctness, not speed: 200 transforms usually take about 0.35 s, but ten busy CPU
// workers stretched them to 1.7 to 5.4 s, past Bun's 5 s default timeout.
test('StyleX keeps compiling media queries after the JIT warms up', async () => {
  const transform = (stylex({ useCSSLayers: true }) as unknown as { transform: Transform })
    .transform;
  for (let file = 0; file < 200; file++) {
    const result = await transform.call({}, source, `${import.meta.dir}/fixture-${file}.tsx`);
    expect(result).toBeDefined();
  }
}, 20_000);
