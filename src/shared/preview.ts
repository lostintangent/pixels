import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export interface ProductionPreview {
  baseUrl: string;
  output: string;
  port: number;
}

async function buildApp(output: string, manifest: boolean, base?: string): Promise<void> {
  const build = Bun.spawn(
    [
      'bunx',
      'vite',
      'build',
      ...(manifest ? ['--manifest'] : []),
      ...(base ? ['--base', base] : []),
      '--outDir',
      output,
      '--emptyOutDir',
    ],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await build.exited) !== 0) throw new Error('Production app build failed');
}

async function availablePort(): Promise<number> {
  const temporary = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = temporary.port;
  await temporary.stop(true);
  if (port === undefined) throw new Error('Could not allocate a preview port');
  return port;
}

async function waitForPreview(port: number, base: string): Promise<void> {
  const url = `http://127.0.0.1:${port}${base}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview process has not bound its port yet.
    }
    await Bun.sleep(50);
  }
  throw new Error('vite preview did not start within 5 seconds');
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // macOS can return EPERM for a group after every process owned by this
    // harness has exited. No remaining process in it can be signaled by us.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

/** Stop the preview process group on every exit. */
async function stopPreview(preview: Bun.Subprocess): Promise<void> {
  const pid = preview.pid;
  signalGroup(pid, 'SIGTERM');
  if (!(await waitForGroupExit(pid, 1_000))) {
    signalGroup(pid, 'SIGKILL');
    if (!(await waitForGroupExit(pid, 1_000)))
      throw new Error(`Preview process group ${pid} survived SIGKILL`);
  }
  await preview.exited;
}

/** Builds the app into a private directory and guarantees preview tree and files are removed. */
export async function withProductionPreview<T>(
  options: { manifest?: boolean; base?: string },
  run: (preview: ProductionPreview) => Promise<T>,
): Promise<T> {
  const base = options.base ?? '/';
  const output = await mkdtemp(join(tmpdir(), 'pixels-preview-'));
  try {
    await buildApp(output, options.manifest ?? false, options.base);
    const port = await availablePort();
    const server = Bun.spawn(
      [
        'bunx',
        'vite',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
        ...(options.base ? ['--base', options.base] : []),
        '--outDir',
        output,
      ],
      { cwd: root, stdout: 'ignore', stderr: 'inherit', detached: true },
    );
    let stopping: Promise<void> | undefined;
    const stop = () => (stopping ??= stopPreview(server));
    const interrupt = (code: 130 | 143) => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      void (async () => {
        try {
          await stop();
        } catch (error) {
          console.error('Preview shutdown failed:', error);
        } finally {
          try {
            await rm(output, { recursive: true, force: true });
          } finally {
            process.exit(code);
          }
        }
      })();
    };
    const onSigint = () => interrupt(130);
    const onSigterm = () => interrupt(143);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    try {
      await waitForPreview(port, base);
      const baseUrl = `http://127.0.0.1:${port}${base === '/' ? '' : base.replace(/\/$/, '')}`;
      return await run({ baseUrl, output, port });
    } finally {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      await stop();
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}
