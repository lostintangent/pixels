import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManifest, renderServiceWorker } from './serviceWorker';

test('the manifest excludes sw.js, sorts for a stable hash, and prefixes every URL with base', () => {
  const files = [
    { fileName: 'assets/index-abc.js', content: 'console.log(1)' },
    { fileName: 'sw.js', content: 'ignored' },
    { fileName: 'index.html', content: '<html></html>' },
  ];
  const manifest = createManifest('/pixels/', files);
  expect(manifest.urls).toEqual(['/pixels/assets/index-abc.js', '/pixels/index.html']);
  expect(manifest.shellUrl).toBe('/pixels/index.html');
  expect(manifest.version).toMatch(/^[0-9a-f]{16}$/);

  // Input order doesn't change the hash: the bundle object's key order isn't meaningful.
  const reordered = createManifest('/pixels/', [...files].reverse());
  expect(reordered.version).toBe(manifest.version);

  // A changed byte in an otherwise unhashed file (index.html carries no content hash in its
  // name) still rotates the version, which is the whole point of hashing content, not names.
  const changed = createManifest('/pixels/', [
    files[0]!,
    { fileName: 'index.html', content: '<html>different</html>' },
  ]);
  expect(changed.version).not.toBe(manifest.version);
});

test('the rendered worker precaches with cache: reload, versions its own cache, and lets reachability checks through', () => {
  const manifest = createManifest('/pixels/', [
    { fileName: 'assets/index-abc.js', content: 'a' },
    { fileName: 'index.html', content: '<html></html>' },
  ]);
  const source = renderServiceWorker(manifest);

  expect(source).toContain(`const CACHE = PREFIX + ${JSON.stringify(manifest.version)};`);
  expect(source).toContain(`const PREFIX = 'pixels-app-';`);
  expect(source).toContain(`cache: 'reload'`);
  expect(source).toContain(JSON.stringify(manifest.urls));
  expect(source).toContain(JSON.stringify(manifest.shellUrl));
  // Only this build's own prefixed caches are ever touched, never another Pages project's, and
  // the single newest stale one survives so an unreloaded tab's old chunks keep resolving.
  expect(source).toContain(`key.startsWith(PREFIX) && key !== CACHE`);
  expect(source).toContain('stale.at(-1)');
  expect(source).toContain('self.skipWaiting()');
  expect(source).toContain(`request.cache === 'no-store'`);
  expect(source).toContain("request.mode === 'navigate'");
  // The shell must come from this worker's own current cache, not the global multi-cache lookup,
  // so an unreloaded tab's leftover old cache can never answer a fresh navigation.
  expect(source).toContain('.open(CACHE)');
  expect(source).toContain('cache.match(SHELL_URL, { ignoreVary: true })');
  // A host that varies its response by Origin (any CORS-aware static server) made cache.match
  // reject every <script crossorigin>/<link crossorigin> request, since that tag always sends an
  // Origin header while this same-origin install-time fetch never does. Stripping Vary before
  // storing, plus ignoreVary as a second layer, keeps every precached match purely URL-based.
  expect(source).toContain("headers.delete('vary')");
  expect(source).toContain('caches.match(request, { ignoreVary: true })');
});

const outDirs: string[] = [];
afterAll(async () => {
  await Promise.all(outDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function build(base: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'pixels-sw-build-'));
  outDirs.push(outDir);
  const proc = Bun.spawn(
    ['bunx', 'vite', 'build', '--base', base, '--outDir', outDir, '--emptyOutDir'],
    {
      cwd: new URL('../../..', import.meta.url).pathname,
      // Vite's build log is large enough to fill the pipe buffer; an unread stdout would block
      // the child process mid-write, which is why this hung for 30s before this fix.
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw new Error(`vite build failed: ${stderr}`);
  return outDir;
}

test('a real build only emits sw.js when the base is not root, and it lists every other emitted file', async () => {
  const [rootBuild, playgroundBuild] = await Promise.all([build('/'), build('/pixels/')]);
  expect(await readdir(rootBuild)).not.toContain('sw.js');

  const emitted = await readdir(playgroundBuild, { recursive: true });
  const files = emitted.filter((name) => name !== 'sw.js' && !name.includes('/'));
  const assetFiles = emitted.filter((name) => name.startsWith('assets/'));
  const source = await readFile(join(playgroundBuild, 'sw.js'), 'utf8');

  for (const file of [...files, ...assetFiles]) {
    expect(source).toContain(`/pixels/${file}`);
  }
  expect(source).toContain('/pixels/index.html');
}, 30_000);
