import { expect, test } from 'bun:test';
import { summarizeTrace, type TraceEvent } from './trace';

const event = (
  name: string,
  ph: string,
  pid: number,
  tid: number,
  ts: number,
  dur?: number,
): TraceEvent => ({ name, ph, pid, tid, ts, dur });

test('Chrome trace summary clips tasks to frame windows and includes compositor and raster work', () => {
  const events: TraceEvent[] = [
    { ...event('thread_name', 'M', 1, 10, 0), args: { name: 'CrRendererMain' } },
    { ...event('thread_name', 'M', 1, 11, 0), args: { name: 'Compositor' } },
    { ...event('thread_name', 'M', 1, 12, 0), args: { name: 'ThreadPoolForegroundWorker' } },
    { ...event('thread_name', 'M', 2, 13, 0), args: { name: 'CrBrowserMain' } },
    { ...event('thread_name', 'M', 3, 14, 0), args: { name: 'CrGpuMain' } },
    {
      ...event('Scheduler::BeginFrame', 'X', 1, 11, 0),
      args: { args: { interval_us: 16_666 } },
    },
    ...[
      ['STATE_PRESENTED_ALL', false],
      ['STATE_DROPPED', false],
      ['STATE_DROPPED', false],
      ['STATE_PRESENTED_ALL', true],
      ['STATE_NO_UPDATE_DESIRED', false],
    ].map(([state, hasHighLatency], index) => ({
      ...event('PipelineReporter', 'b', 1, 11, index * 10_000),
      args: {
        frame_reporter: {
          frame_source: 1,
          frame_sequence: index,
          layer_tree_host_id: 1,
          state: state as string,
          has_high_latency: hasHighLatency as boolean,
        },
      },
    })),
    event('ProxyMain::BeginMainFrame', 'X', 1, 10, 0, 100),
    event('ProxyMain::BeginMainFrame', 'X', 1, 10, 10_000, 100),
    event('ProxyMain::BeginMainFrame', 'X', 1, 10, 20_000, 100),
    event('ProxyMain::BeginMainFrame', 'X', 1, 10, 30_000, 100),
    event('ThreadControllerImpl::RunTask', 'X', 1, 10, 1_000, 2_000),
    event('ThreadControllerImpl::RunTask', 'X', 1, 10, 9_500, 2_000),
    event('ThreadControllerImpl::RunTask', 'X', 1, 10, 21_000, 1_000),
    event('ThreadControllerImpl::RunTask', 'X', 1, 11, 5_000, 1_000),
    event('ThreadControllerImpl::RunTask', 'X', 1, 12, 12_000, 2_000),
    event('ThreadPool_RunTask', 'X', 1, 12, 13_000, 2_000),
    event('ThreadControllerImpl::RunTask', 'X', 2, 13, 12_000, 10_000),
    event('ThreadControllerImpl::RunTask', 'X', 3, 14, 20_000, 1_000),
    event('ThreadControllerImpl::RunTask', 'X', 1, 10, 40_000, 60_000),
  ];
  const summary = summarizeTrace(events);
  expect(summary.frameCount).toBe(3);
  expect(summary.mainP95Ms).toBe(2.5);
  expect(summary.pipelineP95Ms).toBe(4.5);
  expect(summary.maxMainTaskMs).toBe(60);
  expect(summary.refreshHz).toBeCloseTo(60, 1);
  expect(summary.eligibleFrames).toBe(4);
  expect(summary.onTimeFrames).toBe(1);
  expect(summary.droppedFrames).toBe(2);
  expect(summary.highLatencyFrames).toBe(1);
  expect(summary.consecutiveDrops).toBe(true);
});
