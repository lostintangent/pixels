import { expect, mock, test } from 'bun:test';
import { onInterruption } from './chunkErrors';
import type { Interruption } from './chunkErrors';
import { registerServiceWorker } from './serviceWorker';

class FakeServiceWorker extends EventTarget {
  state: string;
  postMessage = mock(() => {});
  constructor(state: string) {
    super();
    this.state = state;
  }
  setState(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeServiceWorker | null = null;
  waiting: FakeServiceWorker | null = null;
  update = mock(async () => {});
}

class FakeDocument extends EventTarget {
  visibilityState = 'visible';
}

class FakeContainer extends EventTarget {
  controller: FakeServiceWorker | null = null;
  register = mock(async (_url: string, _options: unknown) => this.registration);
  constructor(public registration: FakeRegistration) {
    super();
  }
}

function install(container: FakeContainer): void {
  (navigator as unknown as { serviceWorker: unknown }).serviceWorker = container;
}

function uninstall(): void {
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
}

test('does nothing without navigator.serviceWorker or outside the playground build', async () => {
  uninstall();
  registerServiceWorker('/pixels/');
  await Promise.resolve();

  const registration = new FakeRegistration();
  const container = new FakeContainer(registration);
  install(container);
  registerServiceWorker('/');
  await Promise.resolve();
  expect(container.register).not.toHaveBeenCalled();
  uninstall();
});

test('registers with the given scope and updateViaCache: none', async () => {
  const registration = new FakeRegistration();
  const container = new FakeContainer(registration);
  install(container);

  registerServiceWorker('/pixels/');
  await new Promise((r) => setTimeout(r, 10));

  expect(container.register).toHaveBeenCalledWith('/pixels/sw.js', {
    scope: '/pixels/',
    updateViaCache: 'none',
  });
  uninstall();
});

// `onInterruption` replays chunkErrors.ts's module-level pending update to every new subscriber,
// including one from an earlier test in this file, so these track growth from a baseline rather
// than asserting the array from empty.

test('reports an update only when a worker that finished installing replaces an existing controller', async () => {
  const registration = new FakeRegistration();
  const container = new FakeContainer(registration);
  container.controller = new FakeServiceWorker('activated');
  install(container);

  const seen: Interruption[] = [];
  const stop = onInterruption((interruption) => seen.push(interruption));
  const baseline = seen.length;

  registerServiceWorker('/pixels/');
  await new Promise((r) => setTimeout(r, 10));

  const installing = new FakeServiceWorker('installing');
  registration.installing = installing;
  registration.dispatchEvent(new Event('updatefound'));
  installing.setState('installing'); // no-op state change, no report yet
  expect(seen).toHaveLength(baseline);

  installing.setState('installed');
  expect(seen).toHaveLength(baseline + 1);
  expect(seen.at(-1)!.kind).toBe('updated');

  stop();
  uninstall();
});

test('a first install never reports an update, since there is no older version to replace', async () => {
  const registration = new FakeRegistration();
  const container = new FakeContainer(registration);
  // No controller yet: this is the tab's first visit, not a later deploy.
  install(container);

  const seen: Interruption[] = [];
  const stop = onInterruption((interruption) => seen.push(interruption));
  const baseline = seen.length;

  registerServiceWorker('/pixels/');
  await new Promise((r) => setTimeout(r, 10));

  const installing = new FakeServiceWorker('installing');
  registration.installing = installing;
  registration.dispatchEvent(new Event('updatefound'));
  installing.setState('installed');

  expect(seen).toHaveLength(baseline);
  stop();
  uninstall();
});

test('a version already waiting when the tab opens is reported immediately', async () => {
  const registration = new FakeRegistration();
  registration.waiting = new FakeServiceWorker('installed');
  const container = new FakeContainer(registration);
  container.controller = new FakeServiceWorker('activated');
  install(container);

  const seen: Interruption[] = [];
  const stop = onInterruption((interruption) => seen.push(interruption));
  const baseline = seen.length;

  registerServiceWorker('/pixels/');
  await new Promise((r) => setTimeout(r, 10));

  expect(seen).toHaveLength(baseline + 1);
  expect(seen.at(-1)!.kind).toBe('updated');
  stop();
  uninstall();
});

test('activating an update messages the waiting worker to skip waiting and reloads once it takes control', async () => {
  const registration = new FakeRegistration();
  const container = new FakeContainer(registration);
  container.controller = new FakeServiceWorker('activated');
  install(container);
  const reload = mock(() => {});
  (globalThis as unknown as { location: { reload: () => void } }).location = { reload };

  const seen: Interruption[] = [];
  const stop = onInterruption((interruption) => seen.push(interruption));

  registerServiceWorker('/pixels/');
  await new Promise((r) => setTimeout(r, 10));

  const installing = new FakeServiceWorker('installing');
  registration.installing = installing;
  registration.dispatchEvent(new Event('updatefound'));
  installing.setState('installed');

  const latest = seen.at(-1)!;
  const activate = latest.kind === 'updated' ? latest.activate : undefined;
  expect(activate).toBeDefined();
  activate!();

  expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  expect(reload).not.toHaveBeenCalled();

  container.controller = installing;
  container.dispatchEvent(new Event('controllerchange'));
  expect(reload).toHaveBeenCalledTimes(1);

  stop();
  uninstall();
  delete (globalThis as unknown as { location?: unknown }).location;
});

test('activating reloads right away when another tab already made this worker the active one', async () => {
  // Every open tab shares one registration, so one tab's skip-waiting can hand a second tab's
  // installing worker control before that second tab ever calls activate(): the controllerchange
  // event this tab would otherwise wait for already fired before its listener existed.
  const registration = new FakeRegistration();
  const container = new FakeContainer(registration);
  container.controller = new FakeServiceWorker('activated');
  install(container);
  const reload = mock(() => {});
  (globalThis as unknown as { location: { reload: () => void } }).location = { reload };

  const seen: Interruption[] = [];
  const stop = onInterruption((interruption) => seen.push(interruption));

  registerServiceWorker('/pixels/');
  await new Promise((r) => setTimeout(r, 10));

  const installing = new FakeServiceWorker('installing');
  registration.installing = installing;
  registration.dispatchEvent(new Event('updatefound'));
  installing.setState('installed');

  // The other tab's claim() already switched this container's controller, silently, before any
  // controllerchange listener from this tab was ever attached.
  container.controller = installing;

  const latest = seen.at(-1)!;
  const activate = latest.kind === 'updated' ? latest.activate : undefined;
  expect(activate).toBeDefined();
  activate!();

  expect(reload).toHaveBeenCalledTimes(1);
  expect(installing.postMessage).not.toHaveBeenCalled();

  stop();
  uninstall();
  delete (globalThis as unknown as { location?: unknown }).location;
});

test('a visible tab rechecks for an update, throttled to about once an hour', async () => {
  const registration = new FakeRegistration();
  const container = new FakeContainer(registration);
  install(container);
  const fakeDocument = new FakeDocument();
  (globalThis as unknown as { document: unknown }).document = fakeDocument;

  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    registerServiceWorker('/pixels/');
    await new Promise((r) => setTimeout(r, 10));

    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(registration.update).not.toHaveBeenCalled(); // nothing stale yet, registration just ran

    now += 30 * 60 * 1000; // 30 minutes: still inside the hour
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(registration.update).not.toHaveBeenCalled();

    now += 31 * 60 * 1000; // 61 minutes since registration
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(registration.update).toHaveBeenCalledTimes(1);

    fakeDocument.visibilityState = 'hidden';
    now += 2 * 60 * 60 * 1000;
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(registration.update).toHaveBeenCalledTimes(1); // hidden doesn't count as a recheck
  } finally {
    Date.now = originalNow;
    delete (globalThis as unknown as { document?: unknown }).document;
    uninstall();
  }
});
