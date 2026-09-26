import type { BrowserContext, Page } from 'playwright';
import { summarizeTrace, type TraceEvent, type TraceSummary } from './trace';

export async function captureTrace(
  context: BrowserContext,
  page: Page,
  action: () => Promise<void>,
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
  try {
    await action();
  } finally {
    await session.send('Tracing.end');
  }
  await complete;
  await session.detach();
  return summarizeTrace(events);
}
