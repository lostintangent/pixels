/** One steady CPU worker keeps background Chromium on a consistent macOS performance tier. */
export async function withConditionedCpu<T>(label: string, run: () => Promise<T>): Promise<T> {
  const worker = Bun.spawn(['yes'], { stdout: 'ignore', stderr: 'ignore' });
  const stop = () => worker.kill();
  process.once('exit', stop);
  try {
    await Bun.sleep(500);
    if (worker.exitCode !== null) throw new Error('CPU conditioning worker exited early');
    console.log(`CPU conditioning: one yes worker (pid ${worker.pid}) during ${label}`);
    return await run();
  } finally {
    process.off('exit', stop);
    stop();
    await worker.exited;
  }
}
