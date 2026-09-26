export interface PerfCase {
  name: string;
  targetP95Ms: number;
  samples: number;
  prepare(): void;
  reset(): void;
  /** Most cases are pure, synchronous typed-array work. A case whose real cost is inherently
   *  asynchronous (e.g. `encodePng`'s `CompressionStream` deflate) may return a promise instead;
   *  `measure` only awaits it when one comes back, so synchronous cases keep their exact timing. */
  run(): void | Promise<unknown>;
}

export interface PerfResult {
  name: string;
  targetP95Ms: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  blockP95Ms: [number, number, number];
  passed: boolean;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Promise<unknown>).then === 'function'
  );
}

export async function measure(perfCase: PerfCase): Promise<PerfResult> {
  Bun.gc(true);
  perfCase.prepare();
  const warmupEnd = performance.now() + 250;
  let warmupCount = 0;
  while (performance.now() < warmupEnd || warmupCount < 20) {
    perfCase.reset();
    const warmupResult = perfCase.run();
    if (isPromise(warmupResult)) await warmupResult;
    warmupCount++;
  }
  const blockP95Ms: [number, number, number] = [0, 0, 0];
  const blockMedianMs: [number, number, number] = [0, 0, 0];
  let minMs = Infinity;
  for (let block = 0; block < 3; block++) {
    Bun.gc(true);
    const times = Array.from({ length: perfCase.samples }, () => 0);
    for (let i = 0; i < times.length; i++) {
      perfCase.reset();
      const start = performance.now();
      const result = perfCase.run();
      if (isPromise(result)) await result;
      times[i] = performance.now() - start;
    }
    times.sort((a, b) => a - b);
    minMs = Math.min(minMs, times[0]!);
    blockMedianMs[block] = percentile(times, 0.5);
    blockP95Ms[block] = percentile(times, 0.95);
  }
  const p95Ms = percentile(
    [...blockP95Ms].sort((a, b) => a - b),
    0.5,
  );
  return {
    name: perfCase.name,
    targetP95Ms: perfCase.targetP95Ms,
    minMs,
    medianMs: percentile(
      [...blockMedianMs].sort((a, b) => a - b),
      0.5,
    ),
    p95Ms,
    blockP95Ms,
    passed: p95Ms <= perfCase.targetP95Ms,
  };
}
