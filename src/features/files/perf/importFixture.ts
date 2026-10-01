import { packRgba } from '../../document';
import { encodePng } from '../core/png';
import { importPng } from '../import';

/** Photo-like gradient-plus-noise content: unlike blocky pixel art, this is what actually stresses
 *  a decoder — every byte differs from its neighbor, so DEFLATE inflates to a large literal
 *  stream and every sample goes through the real per-pixel unfiltering and (for this fixture)
 *  8-bit path. Deterministic (no `Math.random`) so repeated runs measure the same bytes. */
function photoLikePixels(width: number, height: number): Uint32Array {
  const pixels = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const noise = (x * 2654435761 + y * 2246822519) >>> 24; // cheap, deterministic, well-mixed
      const r = (x % 256) ^ (noise & 0xff);
      const g = (y % 256) ^ ((noise >> 3) & 0xff);
      const b = ((x + y) % 256) ^ ((noise >> 5) & 0xff);
      pixels[y * width + x] = packRgba(r, g, b, 255);
    }
  }
  return pixels;
}

interface LongTask {
  startTime: number;
  duration: number;
  name: string;
}

export interface ImportPerfResult {
  /** Wall-clock time from the click handler's first line to the finished, live document. */
  ms: number;
  width: number;
  height: number;
  longTasks: LongTask[];
}

export interface ImportPerfApi {
  /** Encodes a fresh photo-like PNG at `width` × `height`, untimed. */
  prepare(width: number, height: number): Promise<void>;
  /** Resolves with the next click's result. Call before dispatching the click. */
  waitForClick(): Promise<ImportPerfResult>;
}

let currentBytes: Uint8Array | undefined;
let resolveResult: ((result: ImportPerfResult) => void) | null = null;

async function performImport(): Promise<ImportPerfResult> {
  if (!currentBytes) throw new Error('prepare() must be called before clicking import');
  const longTasks: LongTask[] = [];
  // The Long Tasks API reports exactly what this gate cares about — any main-thread task over
  // 50 ms — without needing to capture and parse a Chrome trace for a single one-shot operation.
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });
  });
  observer.observe({ entryTypes: ['longtask'] });
  const start = performance.now();
  const document = await importPng(currentBytes, 'import-perf');
  const ms = performance.now() - start;
  observer.disconnect();
  return { ms, width: document.width, height: document.height, longTasks };
}

const button = document.querySelector<HTMLButtonElement>('#import')!;
button.addEventListener('click', () => {
  void performImport().then((result) => {
    resolveResult?.(result);
    resolveResult = null;
  });
});

const api: ImportPerfApi = {
  async prepare(width, height) {
    const pixels = photoLikePixels(width, height);
    currentBytes = await encodePng(width, height, pixels);
  },
  waitForClick() {
    return new Promise((resolve) => {
      resolveResult = resolve;
    });
  },
};

declare global {
  interface Window {
    __pixelsImportPerf?: ImportPerfApi;
  }
}
Object.assign(window, { __pixelsImportPerf: api });
