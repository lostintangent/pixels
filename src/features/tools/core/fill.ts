import type { BitmapDocument, PixelRect } from '../../document';
import type { DocumentHistory } from '../../history';
import type { FillInput, MutationResult } from './contracts';

const SOURCE_SAMPLE_COUNT = 1024;
const SOURCE_SAMPLE_THRESHOLD = 717; // At least 70% before the exact 75% count.
const BOUNDED_SNAPSHOT_SAMPLE_THRESHOLD = 614; // At least 60% in a small enough image.
const BOUNDED_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
const CAPTURE_BLOCK_SHIFT = 6;
const CAPTURE_BLOCK_SIZE = 1 << CAPTURE_BLOCK_SHIFT;
const LARGE_IMAGE_PIXELS = 1_048_576;

export class FillWorkspace {
  stack = new Uint32Array(1024);
  rowLeft = new Uint32Array(0);
  rowRight = new Uint32Array(0);
  capturedTiles = new Uint8Array(0);
}

function floodFillLarge(
  document: BitmapDocument,
  input: FillInput,
  history: DocumentHistory,
  workspace: FillWorkspace,
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

  // A full population count is useful only when a large source region might
  // justify a full history snapshot or the uniform-canvas fast path. For a
  // large mixed image, sample across the buffer first and avoid another full
  // read before walking the connected region.
  let hits = 0;
  for (let i = 0; i < SOURCE_SAMPLE_COUNT; i++) {
    const index = (Math.imul(i, 0x9e3779b1) >>> 0) % pixels.length;
    if (pixels[index] === source) hits++;
  }
  // A contiguous copy is cheaper than thousands of tile snapshots for a
  // screenshot-sized, mostly uniform window. Bound that tradeoff to 32 MiB;
  // larger images still need the exact 75% population to use a full copy.
  const boundedSnapshot =
    pixels.byteLength <= BOUNDED_SNAPSHOT_MAX_BYTES && hits >= BOUNDED_SNAPSHOT_SAMPLE_THRESHOLD;
  let sourceCount = 0;
  if (hits === SOURCE_SAMPLE_COUNT || (!boundedSnapshot && hits >= SOURCE_SAMPLE_THRESHOLD)) {
    for (let i = 0; i < pixels.length; i++) {
      if (pixels[i] === source) sourceCount++;
    }
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
  const fullSnapshot = boundedSnapshot || sourceCount >= pixels.length * 0.75;
  if (fullSnapshot) transaction.capture({ x: 0, y: 0, width, height });

  if (workspace.rowRight.length < height) {
    workspace.rowLeft = new Uint32Array(height);
    workspace.rowRight = new Uint32Array(height);
  } else workspace.rowRight.fill(0, 0, height);
  const rowLeft = workspace.rowLeft;
  const rowRight = workspace.rowRight;
  const tileColumns = Math.ceil(width / CAPTURE_BLOCK_SIZE);
  const tileCount = tileColumns * Math.ceil(height / CAPTURE_BLOCK_SIZE);
  if (!fullSnapshot) {
    if (workspace.capturedTiles.length < tileCount)
      workspace.capturedTiles = new Uint8Array(tileCount);
    else workspace.capturedTiles.fill(0, 0, tileCount);
  }
  const capturedTiles = workspace.capturedTiles;
  const tileRect: PixelRect = {
    x: 0,
    y: 0,
    width: CAPTURE_BLOCK_SIZE,
    height: CAPTURE_BLOCK_SIZE,
  };

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
    if (!fullSnapshot) {
      // Capture each block only before its first write; history owns the
      // actual snapshot tiles and clips edge blocks to the document.
      const tileRow = row >>> CAPTURE_BLOCK_SHIFT;
      const startTile = span.x >>> CAPTURE_BLOCK_SHIFT;
      const endTile = (span.x + span.width - 1) >>> CAPTURE_BLOCK_SHIFT;
      for (let tileX = startTile; tileX <= endTile; tileX++) {
        const tileIndex = tileRow * tileColumns + tileX;
        if (capturedTiles[tileIndex]) continue;
        tileRect.x = tileX << CAPTURE_BLOCK_SHIFT;
        tileRect.y = tileRow << CAPTURE_BLOCK_SHIFT;
        transaction.capture(tileRect);
        capturedTiles[tileIndex] = 1;
      }
    }
    pixels.fill(color, left, right + 1);
    rowLeft[row] = span.x;
    rowRight[row] = span.x + span.width;
    changedPixels += span.width;
    minX = Math.min(minX, span.x);
    maxX = Math.max(maxX, span.x + span.width - 1);
    minY = Math.min(minY, row);
    maxY = Math.max(maxY, row);
    for (let direction = -1; direction <= 1; direction += 2) {
      const neighborRow = row + direction;
      if (neighborRow < 0 || neighborRow >= height) continue;
      // A covered interval has already been painted, so it cannot offer a
      // source-colored seed. Wide flat regions avoid rescanning each row from
      // both sides while disjoint spans still take the exact scan path.
      if (rowLeft[neighborRow]! <= span.x && rowRight[neighborRow]! >= span.x + span.width)
        continue;
      const end = neighborRow * width + span.x + span.width;
      let index = neighborRow * width + span.x;
      while (index < end) {
        while (index < end && pixels[index] !== source) index++;
        if (index === end) break;
        if (top === stack.length) {
          const grown = new Uint32Array(stack.length * 2);
          grown.set(stack);
          stack = grown;
          workspace.stack = grown;
        }
        stack[top++] = index;
        while (index < end && pixels[index] === source) index++;
      }
    }
  }
  transaction.commit();
  const dirty = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  document.events.invalidate(dirty);
  return { dirty, changedPixels };
}

function floodFillCompact(
  document: BitmapDocument,
  input: FillInput,
  history: DocumentHistory,
  workspace: FillWorkspace,
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
      let index = neighborRow * width + span.x;
      while (index < end) {
        while (index < end && pixels[index] !== source) index++;
        if (index === end) break;
        if (top === stack.length) {
          const grown = new Uint32Array(stack.length * 2);
          grown.set(stack);
          stack = grown;
          workspace.stack = grown;
        }
        stack[top++] = index;
        while (index < end && pixels[index] === source) index++;
      }
    }
  }
  transaction.commit();
  const dirty = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  document.events.invalidate(dirty);
  return { dirty, changedPixels };
}

/** Keep the proven small-canvas path separate from screenshot-scale work so
 * JSC can optimize each without mixing their history-capture shapes. */
export function floodFill(
  document: BitmapDocument,
  input: FillInput,
  history: DocumentHistory,
  workspace = new FillWorkspace(),
): MutationResult {
  return document.pixels.length <= LARGE_IMAGE_PIXELS
    ? floodFillCompact(document, input, history, workspace)
    : floodFillLarge(document, input, history, workspace);
}
