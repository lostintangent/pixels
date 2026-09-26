import type { BitmapDocument, PixelRect } from '../../document';
import type { DocumentHistory } from '../../history';
import type { FillInput, MutationResult } from './contracts';

export class FillWorkspace {
  stack = new Uint32Array(1024);
}

export function floodFill(
  document: BitmapDocument,
  input: FillInput,
  history: DocumentHistory,
  workspace = new FillWorkspace(),
): MutationResult {
  const x = Math.floor(input.at.x);
  const y = Math.floor(input.at.y);
  const width = document.width;
  const height = document.height;
  if (x < 0 || y < 0 || x >= width || y >= height) return { dirty: null, changedPixels: 0 };
  const pixels = document.pixels;
  const source = pixels[y * width + x]!;
  const color = input.color >>> 0;
  if (source === color) return { dirty: null, changedPixels: 0 };

  let uniform = true;
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] !== source) {
      uniform = false;
      break;
    }
  }
  const transaction = history.begin('Fill', document);
  if (uniform) {
    const dirty = { x: 0, y: 0, width, height };
    transaction.capture(dirty);
    pixels.fill(color);
    transaction.commit();
    document.events.invalidate(dirty);
    return { dirty, changedPixels: pixels.length };
  }

  let stack = workspace.stack;
  let top = 0;
  const push = (index: number) => {
    if (top === stack.length) {
      const grown = new Uint32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
      workspace.stack = grown;
    }
    stack[top++] = index;
  };
  push(y * width + x);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let changedPixels = 0;
  const span: PixelRect = { x: 0, y: 0, width: 0, height: 1 };
  while (top > 0) {
    const seed = stack[--top]!;
    if (pixels[seed] !== source) continue;
    const row = Math.floor(seed / width);
    const rowStart = row * width;
    let left = seed;
    let right = seed;
    while (left > rowStart && pixels[left - 1] === source) left--;
    while (right < rowStart + width - 1 && pixels[right + 1] === source) right++;
    span.x = left - rowStart;
    span.y = row;
    span.width = right - left + 1;
    transaction.capture(span);
    pixels.fill(color, left, right + 1);
    changedPixels += span.width;
    minX = Math.min(minX, span.x);
    maxX = Math.max(maxX, span.x + span.width - 1);
    minY = Math.min(minY, row);
    maxY = Math.max(maxY, row);
    for (let direction = -1; direction <= 1; direction += 2) {
      const neighborRow = row + direction;
      if (neighborRow < 0 || neighborRow >= height) continue;
      let inRun = false;
      for (let nx = span.x; nx < span.x + span.width; nx++) {
        const index = neighborRow * width + nx;
        if (pixels[index] === source) {
          if (!inRun) push(index);
          inRun = true;
        } else inRun = false;
      }
    }
  }
  transaction.commit();
  const dirty = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  document.events.invalidate(dirty);
  return { dirty, changedPixels };
}
