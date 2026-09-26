import { loadavg } from 'node:os';
import { measure } from './harness';
import { corePerfCases } from './core-cases';

const repeatIndex = process.argv.indexOf('--repeat');
const repeat = repeatIndex >= 0 ? Number(process.argv[repeatIndex + 1]) : 1;
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
  throw new RangeError('--repeat must be 1 to 20');
const calibrate = process.argv.includes('--calibrate');
let failed = false;
console.log(
  `Pixels core perf on ${process.platform}/${process.arch}, Bun ${Bun.version}; ${repeat} run(s); loadavg ${loadavg()
    .map((value) => value.toFixed(2))
    .join('/')}`,
);
for (let run = 0; run < repeat; run++) {
  console.log(`Run ${run + 1}/${repeat}`);
  for (const perfCase of corePerfCases) {
    const result = measure(perfCase);
    if (!result.passed) failed = true;
    const status = result.passed ? 'PASS' : 'FAIL';
    console.log(
      `${status} ${result.name}: min ${result.minMs.toFixed(3)} ms, median ${result.medianMs.toFixed(3)} ms, p95 ${result.p95Ms.toFixed(3)} ms [${result.blockP95Ms.map((value) => value.toFixed(3)).join(', ')}], target ${result.targetP95Ms.toFixed(3)} ms`,
    );
  }
}
if (failed && !calibrate) process.exitCode = 1;
