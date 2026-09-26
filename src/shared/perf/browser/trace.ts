/** Chrome trace timestamps and durations are microseconds. */
export interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: {
    name?: string;
    frame_reporter?: {
      frame_source: number;
      frame_sequence: number;
      layer_tree_host_id: number;
      state: string;
      has_high_latency: boolean;
    };
    args?: { interval_us?: number };
  };
}

export interface TraceSummary {
  frameCount: number;
  mainP95Ms: number;
  pipelineP95Ms: number;
  maxMainTaskMs: number;
  eventCount: number;
  refreshHz: number;
  eligibleFrames: number;
  onTimeFrames: number;
  droppedFrames: number;
  highLatencyFrames: number;
  consecutiveDrops: boolean;
}

function p95(sorted: number[]): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function overlap(start: number, end: number, task: TraceEvent): number {
  return Math.max(0, Math.min(end, task.ts + task.dur!) - Math.max(start, task.ts));
}

function unionDuration(intervals: Array<{ start: number; end: number }>): number {
  intervals.sort((a, b) => a.start - b.start);
  let duration = 0;
  let until = -Infinity;
  for (const interval of intervals) {
    duration += Math.max(0, interval.end - Math.max(interval.start, until));
    until = Math.max(until, interval.end);
  }
  return duration;
}

export function summarizeTrace(events: TraceEvent[]): TraceSummary {
  const threads = new Map<string, string>();
  for (const event of events) {
    if (event.name === 'thread_name' && event.args?.name)
      threads.set(`${event.pid}:${event.tid}`, event.args.name);
  }
  const mainThread = [...threads].find(([, name]) => name === 'CrRendererMain')?.[0];
  if (!mainThread) throw new Error('Chrome trace has no renderer main thread');
  const rendererPid = Number(mainThread.split(':')[0]);
  const reports = new Map<string, NonNullable<NonNullable<TraceEvent['args']>['frame_reporter']>>();
  const reportTimes = new Map<string, number>();
  const refreshIntervals: number[] = [];
  for (const event of events) {
    if (event.pid !== rendererPid) continue;
    const report = event.args?.frame_reporter;
    if (event.name === 'PipelineReporter' && event.ph === 'b' && report) {
      const key = `${report.frame_source}:${report.frame_sequence}:${report.layer_tree_host_id}`;
      reports.set(key, report);
      reportTimes.set(key, event.ts);
    }
    if (event.name === 'Scheduler::BeginFrame') {
      const interval = event.args?.args?.interval_us;
      if (interval && interval > 0) refreshIntervals.push(interval);
    }
  }
  if (!reports.size) throw new Error('Chrome trace has no frame presentation reports');
  if (!refreshIntervals.length) throw new Error('Chrome trace has no refresh intervals');
  const orderedReports = [...reports].sort(([a], [b]) => reportTimes.get(a)! - reportTimes.get(b)!);
  let eligibleFrames = 0;
  let onTimeFrames = 0;
  let droppedFrames = 0;
  let highLatencyFrames = 0;
  let consecutiveDrops = false;
  let previousDropped = false;
  for (const [, report] of orderedReports) {
    if (report.state === 'STATE_NO_UPDATE_DESIRED') {
      previousDropped = false;
      continue;
    }
    eligibleFrames++;
    const dropped = report.state === 'STATE_DROPPED';
    if (dropped) droppedFrames++;
    if (report.has_high_latency) highLatencyFrames++;
    if (report.state === 'STATE_PRESENTED_ALL' && !report.has_high_latency) onTimeFrames++;
    if (dropped && previousDropped) consecutiveDrops = true;
    previousDropped = dropped;
  }
  refreshIntervals.sort((a, b) => a - b);
  const refreshHz = 1_000_000 / refreshIntervals[Math.floor(refreshIntervals.length / 2)]!;
  const frames = events
    .filter(
      (event) =>
        event.name === 'ProxyMain::BeginMainFrame' &&
        event.ph === 'X' &&
        `${event.pid}:${event.tid}` === mainThread,
    )
    .map((event) => event.ts)
    .sort((a, b) => a - b);
  const tasks = events.filter(
    (event) =>
      (event.name === 'ThreadControllerImpl::RunTask' || event.name === 'ThreadPool_RunTask') &&
      event.ph === 'X' &&
      typeof event.dur === 'number' &&
      event.dur > 0,
  );
  let maxMainTaskMs = 0;
  for (const task of tasks) {
    if (`${task.pid}:${task.tid}` === mainThread)
      maxMainTaskMs = Math.max(maxMainTaskMs, task.dur! / 1000);
  }
  const mainTimes: number[] = [];
  const pipelineTimes: number[] = [];
  for (let i = 0; i < frames.length - 1; i++) {
    const start = frames[i]!;
    const end = frames[i + 1]!;
    const intervals = new Map<string, Array<{ start: number; end: number }>>();
    for (const task of tasks) {
      const duration = overlap(start, end, task);
      if (!duration) continue;
      const key = `${task.pid}:${task.tid}`;
      const thread = threads.get(key);
      if (
        thread !== 'CrRendererMain' &&
        thread !== 'Compositor' &&
        thread !== 'ThreadPoolForegroundWorker' &&
        thread !== 'VizCompositorThread' &&
        thread !== 'CrGpuMain'
      )
        continue;
      const list = intervals.get(key) ?? [];
      list.push({ start: Math.max(start, task.ts), end: Math.min(end, task.ts + task.dur!) });
      intervals.set(key, list);
    }
    let pipeline = 0;
    for (const [key, list] of intervals) {
      const duration = unionDuration(list);
      if (key === mainThread) mainTimes.push(duration / 1000);
      pipeline += duration;
    }
    if (mainTimes.length < i + 1) mainTimes.push(0);
    pipelineTimes.push(pipeline / 1000);
  }
  mainTimes.sort((a, b) => a - b);
  pipelineTimes.sort((a, b) => a - b);
  return {
    frameCount: mainTimes.length,
    mainP95Ms: p95(mainTimes),
    pipelineP95Ms: p95(pipelineTimes),
    maxMainTaskMs,
    eventCount: events.length,
    refreshHz,
    eligibleFrames,
    onTimeFrames,
    droppedFrames,
    highLatencyFrames,
    consecutiveDrops,
  };
}
