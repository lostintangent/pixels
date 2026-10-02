import { expect, test } from 'bun:test';
import type { Annotation } from '../core/contracts';
import { paintAnnotation } from './paint';

function record(shape: Annotation): Array<[string, ...number[]]> {
  const calls: Array<[string, ...number[]]> = [];
  const log =
    (name: string) =>
    (...args: number[]) =>
      calls.push([name, ...args]);
  const ctx = {
    rect: log('rect'),
    moveTo: log('moveTo'),
    lineTo: log('lineTo'),
    beginPath() {},
    stroke() {},
    fill() {},
    closePath() {},
  } as unknown as CanvasRenderingContext2D;
  paintAnnotation(ctx, shape, 'srgb');
  return calls;
}

const shape = (kind: Annotation['kind'], width: number): Annotation => ({
  id: 'a',
  kind,
  start: { x: 8, y: 4 },
  end: { x: 24, y: 4 + (kind === 'rectangle' ? 10 : 0) },
  width,
  color: 0xff0000ff,
});

test('odd-width rectangles stroke the pixels inside the dragged grid lines', () => {
  expect(record(shape('rectangle', 1))).toEqual([['rect', 8.5, 4.5, 15, 9]]);
  expect(record(shape('rectangle', 3))).toEqual([['rect', 8.5, 4.5, 15, 9]]);
  expect(record(shape('rectangle', 2))).toEqual([['rect', 8, 4, 16, 10]]);
});

test('odd-width arrows move onto pixel centers so straight shafts fill whole rows', () => {
  const odd = record(shape('arrow', 1));
  expect(odd[0]).toEqual(['moveTo', 8.5, 4.5]);
  expect(odd.slice(0, 2).every(([, , y]) => y === 4.5)).toBe(true);
  expect(odd[2]).toEqual(['moveTo', 24.5, 4.5]);
  const even = record(shape('arrow', 2));
  expect(even[0]).toEqual(['moveTo', 8, 4]);
  expect(even[2]).toEqual(['moveTo', 24, 4]);
});
