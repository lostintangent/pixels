import { expect, test } from 'bun:test';
import stylex from '@stylexjs/unplugin/vite';

type Transform = (this: unknown, code: string, id: string) => Promise<unknown>;

const source = (file: number) => `import * as stylex from '@stylexjs/stylex';
export const styles = stylex.create({
  target: {
    width: { default: ${36 + (file % 8)}, '@media (pointer: coarse)': 44 },
    color: { default: 'red', '@media (hover: hover)': { ':hover': 'blue' } },
    minHeight: { default: 24, '@media (min-width: ${600 + file}px)': 32 },
  },
});`;

// Bun 1.4.2's JIT miscompiles StyleX's tokenizer, which then rejects valid media queries after
// the compiler warms up. See AGENTS.md. Each source varies to exercise compilation rather than a
// cache of identical input. This checks correctness, not speed. A busy machine can exceed the
// default 5 s timeout.
test('StyleX keeps compiling media queries after the JIT warms up', async () => {
  const transform = (stylex({ useCSSLayers: true }) as unknown as { transform: Transform })
    .transform;
  for (let file = 0; file < 200; file++) {
    const id = `${import.meta.dir}/fixture-${file}.tsx`;
    const result = await transform.call({}, source(file), id).catch((cause: unknown) => {
      throw new Error(
        `Bun ${Bun.version} (${Bun.revision.slice(0, 9)}) broke StyleX at fixture ${file}. ` +
          'Run `bun upgrade --canary` to get 1.4.3-canary.1 (4b02e1031) or newer.',
        { cause },
      );
    });
    expect(result).toBeDefined();
  }
}, 20_000);
