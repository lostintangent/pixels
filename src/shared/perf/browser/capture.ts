import type { BrowserContext, Page } from 'playwright';
import { summarizeTrace, type TraceEvent, type TraceSummary } from './trace';

export async function captureTrace(
  context: BrowserContext,
  page: Page,
  action: (markFirstInput: () => Promise<void>) => Promise<void>,
): Promise<TraceSummary> {
  const session = await context.newCDPSession(page);
  const events: TraceEvent[] = [];
  session.on('Tracing.dataCollected', ({ value }) =>
    events.push(...(value as unknown as TraceEvent[])),
  );
  const complete = new Promise<void>((resolve, reject) => {
    session.once('Tracing.tracingComplete', ({ dataLossOccurred }) => {
      if (dataLossOccurred) reject(new Error('Chrome trace lost data'));
      else resolve();
    });
  });
  await session.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame,cc,toplevel',
    transferMode: 'ReportEvents',
  });
  let marked = false;
  const markFirstInput = async () => {
    if (marked) throw new Error('First input was marked twice');
    marked = true;
    await session.send('Tracing.recordClockSyncMarker', { syncId: 'pixels-first-input' });
  };
  try {
    await action(markFirstInput);
  } finally {
    await session.send('Tracing.end');
  }
  await complete;
  await session.detach();
  if (!marked) throw new Error('Trace action did not mark its first input');
  if (
    !events.some(
      (event) => event.name === 'clock_sync' && event.args?.sync_id === 'pixels-first-input',
    )
  )
    throw new Error('Chrome trace has no first-input clock marker');
  return summarizeTrace(events);
}
