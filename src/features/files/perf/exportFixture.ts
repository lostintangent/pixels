import { createBitmapDocument, packRgba } from '../../document';
import { exportPng } from '../export';

/** Blocky pixel-art content: the common case an artist actually produces, and what this gate is
 *  meant to represent (mirrors `shared/perf/files-cases.ts`'s content, kept local since this
 *  fixture runs in the browser rather than `bun test`/`bun run perf`). */
function blockyPixels(side: number): Uint32Array {
  const pixels = new Uint32Array(side * side);
  const palette = [
    packRgba(32, 110, 201, 255),
    packRgba(25, 25, 25, 255),
    packRgba(255, 255, 255, 255),
    packRgba(76, 175, 80, 255),
    packRgba(255, 152, 0, 255),
  ];
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      pixels[y * side + x] = palette[((x >> 4) + (y >> 4)) % palette.length]!;
    }
  }
  return pixels;
}

interface LongTask {
  startTime: number;
  duration: number;
  name: string;
}

export interface ExportPerfResult {
  /** Wall-clock time from the click handler's first line to the finished `Blob`. */
  ms: number;
  byteLength: number;
  longTasks: LongTask[];
}

export interface ExportPerfApi {
  /** Builds a fresh document of blocky pixel-art content at `side` × `side`, untimed. */
  prepare(side: number): void;
  /** Resolves with the next click's result. Call before dispatching the click. */
  waitForClick(): Promise<ExportPerfResult>;
}

let currentDocument: ReturnType<typeof createBitmapDocument> | undefined;
let resolveResult: ((result: ExportPerfResult) => void) | null = null;

async function performExport(): Promise<ExportPerfResult> {
  if (!currentDocument) throw new Error('prepare() must be called before clicking export');
  const longTasks: LongTask[] = [];
  // The Long Tasks API reports exactly what this gate cares about — any main-thread task over
  // 50 ms — without needing to capture and parse a Chrome trace for a single one-shot operation.
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });
  });
  observer.observe({ entryTypes: ['longtask'] });
  const start = performance.now();
  const bytes = await exportPng(currentDocument);
  const blob = new Blob([bytes as BlobPart], { type: 'image/png' });
  const ms = performance.now() - start;
  observer.disconnect();
  return { ms, byteLength: blob.size, longTasks };
}

const button = document.querySelector<HTMLButtonElement>('#export')!;
button.addEventListener('click', () => {
  void performExport().then((result) => {
    resolveResult?.(result);
    resolveResult = null;
  });
});

const api: ExportPerfApi = {
  prepare(side) {
    currentDocument = createBitmapDocument('export-perf', side, side);
    currentDocument.pixels.set(blockyPixels(side));
  },
  waitForClick() {
    return new Promise((resolve) => {
      resolveResult = resolve;
    });
  },
};

declare global {
  interface Window {
    __pixelsExportPerf?: ExportPerfApi;
  }
}
Object.assign(window, { __pixelsExportPerf: api });
