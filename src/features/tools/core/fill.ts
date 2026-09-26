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
  // JSC handles signed 32-bit values in the integer fast path. Opaque ABGR
  // colors exceed 2³¹, so compare through a signed view of the same buffer.
  const pixels = new Int32Array(
    document.pixels.buffer,
    document.pixels.byteOffset,
    document.pixels.length,
  );
  const source = pixels[y * width + x]!;
  const color = input.color | 0;
  if (source === color) return { dirty: null, changedPixels: 0 };

  let sourceCount = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] === source) sourceCount++;
  }
  const transaction = history.begin('Fill', document);
  if (sourceCount === pixels.length) {
    const dirty = { x: 0, y: 0, width, height };
    transaction.capture(dirty);
    pixels.fill(color);
    transaction.commit();
    document.events.invalidate(dirty);
    return { dirty, changedPixels: pixels.length };
  }

  // A large source population makes repeated tile probes more expensive than
  // one contiguous snapshot, even when obstacles split the fill into spans.
  const fullSnapshot = sourceCount >= pixels.length * 0.75;
  if (fullSnapshot) transaction.capture({ x: 0, y: 0, width, height });

  let stack = workspace.stack;
  let top = 0;
  stack[top++] = y * width + x;
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
    if (!fullSnapshot) transaction.capture(span);
    pixels.fill(color, left, right + 1);
    changedPixels += span.width;
    minX = Math.min(minX, span.x);
    maxX = Math.max(maxX, span.x + span.width - 1);
    minY = Math.min(minY, row);
    maxY = Math.max(maxY, row);
    for (let direction = -1; direction <= 1; direction += 2) {
      const neighborRow = row + direction;
      if (neighborRow < 0 || neighborRow >= height) continue;
      const end = neighborRow * width + span.x + span.width;
      let inRun = false;
      for (let index = neighborRow * width + span.x; index < end; index++) {
        if (pixels[index] === source) {
          if (!inRun) {
            if (top === stack.length) {
              const grown = new Uint32Array(stack.length * 2);
              grown.set(stack);
              stack = grown;
              workspace.stack = grown;
            }
            stack[top++] = index;
          }
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
