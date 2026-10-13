/** The harness timestamps each input just before sending it to Chrome. A late
 * send means a missing ink frame can belong to the driver rather than Pixels. */
export interface GapDistribution {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface DispatchCadence extends GapDistribution {
  expectedSamples: number;
  lateGaps: number;
  maxAllowedGapMs: number;
  valid: boolean;
}

export function gapDistribution(timesMs: number[]): GapDistribution {
  const gaps = timesMs
    .slice(1)
    .map((time, index) => time - timesMs[index]!)
    .sort((a, b) => a - b);
  const p50Ms = gaps[Math.floor((gaps.length - 1) / 2)] ?? 0;
  const p95Ms = gaps[Math.max(0, Math.ceil(gaps.length * 0.95) - 1)] ?? 0;
  const maxMs = gaps.at(-1) ?? 0;
  return { samples: timesMs.length, p50Ms, p95Ms, maxMs };
}

export function dispatchCadence(
  dispatchTimesMs: number[],
  expectedSamples: number,
  maxAllowedGapMs: number,
): DispatchCadence {
  const distribution = gapDistribution(dispatchTimesMs);
  const gaps = dispatchTimesMs.slice(1).map((time, index) => time - dispatchTimesMs[index]!);
  const lateGaps = gaps.filter((gap) => gap > maxAllowedGapMs).length;
  return {
    ...distribution,
    expectedSamples,
    lateGaps,
    maxAllowedGapMs,
    valid: dispatchTimesMs.length === expectedSamples && lateGaps === 0,
  };
}

type GateResult = 'PASS' | 'FAIL' | 'INVALID';

export function editorGateVerdict(input: {
  appMainPassed: boolean;
  appFramesPassed: boolean;
  appCadenceValid: boolean;
  controlPassed: boolean;
  controlCadenceValid: boolean;
}): { main: GateResult; frames: GateResult; verdict: GateResult } {
  const main: GateResult = !input.appCadenceValid
    ? 'INVALID'
    : input.appMainPassed
      ? 'PASS'
      : 'FAIL';
  const frames: GateResult =
    !input.appCadenceValid || !input.controlCadenceValid || !input.controlPassed
      ? 'INVALID'
      : input.appFramesPassed
        ? 'PASS'
        : 'FAIL';
  const verdict: GateResult =
    main === 'FAIL' || frames === 'FAIL'
      ? 'FAIL'
      : main === 'INVALID' || frames === 'INVALID'
        ? 'INVALID'
        : 'PASS';
  return { main, frames, verdict };
}
