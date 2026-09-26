export interface PerfCase {
  name: string;
  targetP95Ms: number;
  samples: number;
  /** Amortize timer resolution for operations faster than one microsecond. */
  batchSize?: number;
  prepare(): void;
  reset(): void;
  run(): number | void;
}

export interface PerfResult {
  name: string;
  targetP95Ms: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  passed: boolean;
  checksum: number;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function measure(perfCase: PerfCase): PerfResult {
  Bun.gc(true);
  perfCase.prepare();
  const warmupEnd = performance.now() + 250;
  let warmupCount = 0;
  while (performance.now() < warmupEnd || warmupCount < 20) {
    perfCase.reset();
    perfCase.run();
    warmupCount++;
  }
  Bun.gc(true);
  const times = Array.from({ length: perfCase.samples }, () => 0);
  const batchSize = perfCase.batchSize ?? 1;
  let checksum = 0;
  for (let i = 0; i < times.length; i++) {
    perfCase.reset();
    const start = performance.now();
    for (let batch = 0; batch < batchSize; batch++) checksum += perfCase.run() ?? 0;
    times[i] = (performance.now() - start) / batchSize;
  }
  times.sort((a, b) => a - b);
  const p95Ms = percentile(times, 0.95);
  return {
    name: perfCase.name,
    targetP95Ms: perfCase.targetP95Ms,
    minMs: times[0]!,
    medianMs: percentile(times, 0.5),
    p95Ms,
    passed: p95Ms <= perfCase.targetP95Ms,
    checksum,
  };
}
