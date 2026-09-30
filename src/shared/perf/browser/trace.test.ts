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
      ['STATE_PRESENTED_PARTIAL', false],
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
  expect(summary.stageP95Ms.CrRendererMain).toBe(2.5);
  expect(summary.stageP95Ms.ThreadPoolForegroundWorker).toBe(3);
  expect(summary.stageP95Ms.CrGpuMain).toBe(1);
  expect(summary.maxMainTaskMs).toBe(60);
  expect(summary.refreshHz).toBeCloseTo(60, 1);
  expect(summary.eligibleFrames).toBe(5);
  expect(summary.onTimeFrames).toBe(1);
  expect(summary.droppedFrames).toBe(2);
  expect(summary.highLatencyFrames).toBe(1);
  expect(summary.presentationStates.STATE_PRESENTED_PARTIAL).toBe(1);
  expect(summary.missedFrameRuns).toEqual([
    { state: 'STATE_DROPPED', start: 2, end: 3 },
    { state: 'STATE_PRESENTED_ALL/HIGH', start: 4, end: 4 },
    { state: 'STATE_PRESENTED_PARTIAL', start: 5, end: 5 },
  ]);
  expect(summary.consecutiveDrops).toBe(true);
});

test('presentation eligibility begins strictly after the first input marker', () => {
  const events: TraceEvent[] = [
    { ...event('thread_name', 'M', 1, 10, 0), args: { name: 'CrRendererMain' } },
    { ...event('Scheduler::BeginFrame', 'X', 1, 11, 0), args: { args: { interval_us: 16_666 } } },
    { ...event('clock_sync', 'c', 2, 12, 15_000), args: { sync_id: 'pixels-first-input' } },
    ...[0, 15_000, 20_000, 30_000, 40_000].map((ts, frame_sequence) => ({
      ...event('PipelineReporter', 'b', 1, 11, ts),
      args: {
        frame_reporter: {
          frame_source: 1,
          frame_sequence,
          layer_tree_host_id: 1,
          state:
            frame_sequence === 2 || frame_sequence === 4 ? 'STATE_PRESENTED_ALL' : 'STATE_DROPPED',
          has_high_latency: false,
        },
      },
    })),
    ...[0, 10_000, 20_000, 30_000, 40_000, 50_000].map((ts) =>
      event('ProxyMain::BeginMainFrame', 'X', 1, 10, ts, 100),
    ),
  ];
  const summary = summarizeTrace(events);
  expect(summary.preInputEligibleFrames).toBe(2);
  expect(summary.preInputMisses).toEqual([
    { state: 'STATE_DROPPED', beforeInputMs: 15 },
    { state: 'STATE_DROPPED', beforeInputMs: 0 },
  ]);
  expect(summary.eligibleFrames).toBe(3);
  expect(summary.onTimeFrames).toBe(2);
  expect(summary.droppedFrames).toBe(1);
  expect(summary.missedFrameRuns).toEqual([{ state: 'STATE_DROPPED', start: 2, end: 2 }]);
  expect(summary.consecutiveDrops).toBe(false);
  expect(summary.frameCount).toBe(3);
});

test('forked Chrome reporters do not replace a complete primary frame', () => {
  const reporter = (sequence: number, state: string, frame_type?: string): TraceEvent => ({
    ...event('PipelineReporter', 'b', 1, 11, sequence * 16_666),
    args: {
      frame_reporter: {
        frame_source: 1,
        frame_sequence: sequence,
        layer_tree_host_id: 1,
        state,
        frame_type,
        has_high_latency: false,
      },
    },
  });
  const summary = summarizeTrace([
    { ...event('thread_name', 'M', 1, 10, 0), args: { name: 'CrRendererMain' } },
    { ...event('Scheduler::BeginFrame', 'X', 1, 11, 0), args: { args: { interval_us: 16_666 } } },
    reporter(0, 'STATE_PRESENTED_ALL'),
    reporter(0, 'STATE_PRESENTED_PARTIAL', 'FORKED'),
    reporter(1, 'STATE_DROPPED', 'FORKED'),
    reporter(1, 'STATE_PRESENTED_ALL'),
    reporter(2, 'STATE_PRESENTED_ALL'),
    reporter(3, 'STATE_PRESENTED_PARTIAL'),
    reporter(3, 'STATE_PRESENTED_ALL', 'FORKED'),
    ...[0, 16_666, 33_332, 49_998, 66_664].map((ts) =>
      event('ProxyMain::BeginMainFrame', 'X', 1, 10, ts, 100),
    ),
  ]);
  expect(summary.eligibleFrames).toBe(4);
  expect(summary.onTimeFrames).toBe(3);
  expect(summary.droppedFrames).toBe(0);
  expect(summary.presentationStates.STATE_PRESENTED_PARTIAL).toBe(1);
  expect(summary.missedFrameRuns).toEqual([{ state: 'STATE_PRESENTED_PARTIAL', start: 4, end: 4 }]);
});
