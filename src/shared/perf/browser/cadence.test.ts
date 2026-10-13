import { expect, test } from 'bun:test';
import { dispatchCadence, editorGateVerdict } from './cadence';

test('a missed harness input deadline invalidates the trace without changing frame budgets', () => {
  const onTime = dispatchCadence([0, 17, 34, 51], 4, 30);
  expect(onTime.valid).toBe(true);
  expect(onTime.p95Ms).toBe(17);

  const late = dispatchCadence([0, 17, 51, 68], 4, 30);
  expect(late.valid).toBe(false);
  expect(late.lateGaps).toBe(1);
  expect(late.maxMs).toBe(34);

  expect(dispatchCadence([0, 17, 34], 4, 30).valid).toBe(false);
});

test('an injected main-thread regression fails even when the control loses cadence', () => {
  expect(
    editorGateVerdict({
      appMainPassed: false,
      appFramesPassed: false,
      appCadenceValid: true,
      controlPassed: false,
      controlCadenceValid: false,
    }),
  ).toEqual({ main: 'FAIL', frames: 'INVALID', verdict: 'FAIL' });

  expect(
    editorGateVerdict({
      appMainPassed: false,
      appFramesPassed: false,
      appCadenceValid: false,
      controlPassed: true,
      controlCadenceValid: true,
    }),
  ).toEqual({ main: 'INVALID', frames: 'INVALID', verdict: 'INVALID' });

  expect(
    editorGateVerdict({
      appMainPassed: true,
      appFramesPassed: false,
      appCadenceValid: true,
      controlPassed: true,
      controlCadenceValid: true,
    }),
  ).toEqual({ main: 'PASS', frames: 'FAIL', verdict: 'FAIL' });
});
