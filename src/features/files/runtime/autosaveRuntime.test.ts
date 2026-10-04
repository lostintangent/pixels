import { afterEach, describe, expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import type {
  AutosaveClock,
  DocumentSnapshot,
  DocumentStore,
  DocumentSummary,
} from '../core/contracts';
import { attachAutosave, saveDocument } from './autosaveRuntime';
import { terminatePngWorkerClient } from './pngWorkerClient';

// A fresh Worker per test, not one shared across the whole file: every save routes a real
// thumbnail encode through the one shared `pngWorkerClient` singleton, and a request left
// in flight when a test ends would otherwise settle during a *later* test, racing whatever
// state (e.g. a `withFakeWindow` fake global) that test owns.
afterEach(() => {
  terminatePngWorkerClient();
});

interface PendingTimer {
  id: number;
  dueAt: number;
  callback: () => void;
}

function createManualClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, PendingTimer>();
  const clock: AutosaveClock = {
    now: () => now,
    setTimeout(callback, ms) {
      const id = nextId++;
      pending.set(id, { id, dueAt: now + ms, callback });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id as number);
    },
  };
  // `store` is whichever fake store the test attached to this clock's autosave; a fired timer's
  // flush does real async work (a PNG worker round trip), so this waits for that store to report
  // itself idle again instead of guessing at a sleep duration a busy machine can outrun.
  async function advance(ms: number, store: { waitForIdle(): Promise<void> }): Promise<void> {
    const target = now + ms;
    for (;;) {
      const due = [...pending.values()]
        .filter((t) => t.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt);
      if (due.length === 0) break;
      const next = due[0]!;
      pending.delete(next.id);
      now = next.dueAt;
      next.callback();
      await store.waitForIdle();
    }
    now = target;
  }
  return { clock, advance };
}

function createFakeStore(): DocumentStore & {
  saves: DocumentSnapshot[];
  stashes: DocumentSnapshot[];
  failNext: boolean;
  /** Makes the next `save()` call wait until the returned function is called, so a test can
   *  land a second edit while that save is still in flight. */
  blockNextSave(): () => void;
  /** Like `blockNextSave`, but the returned function rejects that call's `save()` instead of
   *  letting it through, so a test can control exactly when a specific in-flight save fails. */
  blockNextSaveAndFail(): (error: Error) => void;
  /** Resolves once every `save()` call not currently paused on a `blockNextSave`/
   *  `blockNextSaveAndFail` gate has fully settled, including `flush()`'s own synchronous
   *  follow-up (its `inFlightFlushes--` bookkeeping and `onStatus` call) — not just this fake
   *  store's own promise. A test driving the manual clock awaits this instead of a fixed sleep,
   *  so a timer-triggered flush is waited for exactly as long as its real async work (the PNG
   *  worker round trip) actually takes, however long that is under load. */
  waitForIdle(): Promise<void>;
} {
  const saved = new Map<string, DocumentSnapshot & { thumbnail: Uint8Array }>();
  // A FIFO queue of gates, one per still-unconsumed `blockNextSave`/`blockNextSaveAndFail` call.
  // Each `save()` call consumes at most one gate, in call order, so overlapping saves can each be
  // controlled independently rather than all waiting on the same one.
  const gateQueue: Promise<void>[] = [];
  // Counts saves that have cleared their gate (if any) and are doing real, ungated async work —
  // the thing `waitForIdle` actually waits out. A save still paused on a gate doesn't count: it's
  // waiting on the test itself, not on independent async work `advance()` should sit through.
  let liveSaves = 0;
  let idleWaiters: Array<() => void> = [];
  function notifyIfIdle(): void {
    if (liveSaves > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
  async function performSave(
    snapshot: DocumentSnapshot,
    thumbnail: Uint8Array | Promise<Uint8Array>,
  ): Promise<void> {
    const myGate = gateQueue.shift();
    if (myGate) await myGate; // may reject, surfacing as this call's own failure
    // Attached unconditionally, before the `failNext` branch below can throw past it: a
    // shapes-bearing thumbnail here routes through the real PNG Worker, which rejects under
    // `bun test`'s Worker (no OffscreenCanvas). Left uncaught on a simulated-failure path, that
    // real request would still be in flight when this call throws, and later settle as a genuine
    // unhandled rejection between tests instead of as part of this one.
    const thumbnailSettled = Promise.resolve(thumbnail).catch(() => undefined);
    liveSaves++;
    try {
      if (store.failNext) {
        store.failNext = false;
        throw new Error('simulated write failure');
      }
      // Mirrors the real store: the snapshot (shapes, tiles) is the save of record and commits
      // independent of the thumbnail encode, which patches in best-effort and never fails the
      // save itself. Still awaited here (its rejection already caught above, not ignored)
      // rather than left dangling: `waitForIdle()` below needs this round trip to actually
      // settle before it resolves, or a still-in-flight request to the one Worker this file
      // shares across every test could settle mid a *later* test instead.
      store.saves.push(snapshot);
      const resolvedThumbnail = await thumbnailSettled;
      if (resolvedThumbnail) saved.set(snapshot.id, { ...snapshot, thumbnail: resolvedThumbnail });
    } finally {
      liveSaves--;
    }
  }
  const store = {
    saves: [] as DocumentSnapshot[],
    stashes: [] as DocumentSnapshot[],
    failNext: false,
    save(snapshot: DocumentSnapshot, thumbnail: Uint8Array | Promise<Uint8Array>): Promise<void> {
      const result = performSave(snapshot, thumbnail);
      // Queued, rather than attached directly: `flush()` itself evaluates `await store.save(...)`
      // synchronously right after this call returns `result`, which subscribes its own
      // continuation (the `inFlightFlushes--`/`onStatus` bookkeeping) to `result` first. Queuing
      // our subscription instead of attaching it here guarantees it runs after that — in the same
      // synchronous turn, `result` already has `flush()`'s reaction attached by the time our
      // queued callback runs and attaches this one — so a `waitForIdle()` waiter only resumes
      // once `flush()`'s own follow-up has actually happened, not merely once this fake store's
      // own work settled a tick earlier.
      queueMicrotask(() => {
        result.then(notifyIfIdle, notifyIfIdle);
      });
      return result;
    },
    stashForRecovery(snapshot: DocumentSnapshot) {
      store.stashes.push(snapshot);
    },
    async rename() {},
    async load() {
      return null;
    },
    async remove() {},
    async listRecents(): Promise<DocumentSummary[]> {
      return [];
    },
    blockNextSave(): () => void {
      let release!: () => void;
      gateQueue.push(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return release;
    },
    blockNextSaveAndFail(): (error: Error) => void {
      let fail!: (error: Error) => void;
      gateQueue.push(
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
      );
      return fail;
    },
    waitForIdle(): Promise<void> {
      if (liveSaves === 0) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
  return store;
}

describe('attachAutosave', () => {
  test('does not save a blank, never-edited document', async () => {
    const document = createBitmapDocument('blank', 32, 32);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 100, maxWaitMs: 500 });
    await advance(1000, store);
    expect(store.saves).toHaveLength(0);
    autosave.dispose();
  });

  test('saves the whole document immediately when initialResave is requested (import, resize)', async () => {
    const document = createBitmapDocument('imported', 32, 32);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const autosave = attachAutosave(document, store, {
      clock,
      debounceMs: 100,
      maxWaitMs: 500,
      initialResave: true,
    });
    await advance(100, store);
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.fullResave).toBe(true);
    autosave.dispose();
  });

  test('an edit schedules a debounced incremental save', async () => {
    const document = createBitmapDocument('doc', 128, 128);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 200, maxWaitMs: 1000 });

    document.pixels[0] = packRgba(1, 2, 3, 255);
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    await advance(199, store);
    expect(store.saves).toHaveLength(0);
    await advance(1, store);
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.fullResave).toBe(false);
    expect(store.saves[0]!.tiles).toHaveLength(1);
    autosave.dispose();
  });

  test('reports saving then saved via onStatus', async () => {
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const statuses: string[] = [];
    const autosave = attachAutosave(document, store, {
      clock,
      debounceMs: 50,
      maxWaitMs: 200,
      onStatus: (status) => statuses.push(status),
    });
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    await advance(50, store);
    expect(statuses).toEqual(['saving', 'saved']);
    autosave.dispose();
  });

  test('a failed flush keeps its dirty tiles pending so a retry saves them', async () => {
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const statuses: string[] = [];
    const autosave = attachAutosave(document, store, {
      clock,
      debounceMs: 50,
      maxWaitMs: 200,
      onStatus: (status) => statuses.push(status),
    });
    store.failNext = true;
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    await advance(50, store);
    expect(statuses).toEqual(['saving', 'error']);
    expect(store.saves).toHaveLength(0);

    await autosave.flush(); // manual retry, same as a save-status "Retry" button would call
    expect(statuses).toEqual(['saving', 'error', 'saving', 'saved']);
    expect(store.saves).toHaveLength(1);
    autosave.dispose();
  });

  test('an edit that lands while a save is in flight is not dropped when that save completes', async () => {
    const document = createBitmapDocument('doc', 256, 256);
    const store = createFakeStore();
    const { clock } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 5000, maxWaitMs: 20000 });

    const release = store.blockNextSave();
    document.pixels[0] = packRgba(1, 1, 1, 255); // tile 0:0
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    const firstFlush = autosave.flush(); // starts; blocks inside store.save on the gate

    await new Promise((resolve) => setTimeout(resolve, 10)); // let it actually reach the gate

    // A second edit, in a different tile, lands while the first save is still in flight.
    document.pixels[200 * 256 + 200] = packRgba(2, 2, 2, 255); // tile 3:3
    document.events.invalidate({ x: 200, y: 200, width: 1, height: 1 });

    release();
    await firstFlush;

    await autosave.flush(); // must still see tile 3:3 as dirty, not have lost it to the first save
    autosave.dispose();

    expect(store.saves).toHaveLength(2);
    expect(store.saves[0]!.tiles.map((t) => `${t.tx}:${t.ty}`)).toEqual(['0:0']);
    expect(store.saves[1]!.tiles.map((t) => `${t.tx}:${t.ty}`)).toEqual(['3:3']);
  });

  test('an older flush finishing after a newer one has started never reports "saved" itself', async () => {
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock } = createManualClock();
    const statuses: string[] = [];
    const autosave = attachAutosave(document, store, {
      clock,
      debounceMs: 5000,
      maxWaitMs: 20000,
      onStatus: (status) => statuses.push(status),
    });

    const releaseFirst = store.blockNextSave();
    document.pixels[0] = packRgba(1, 1, 1, 255); // tile 0:0
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    const firstFlush = autosave.flush(); // A: blocks inside store.save

    await new Promise((resolve) => setTimeout(resolve, 10)); // let A actually reach the gate

    // B starts and completes entirely while A is still blocked.
    document.pixels[1] = packRgba(2, 2, 2, 255); // tile 0:0 again, a later edit
    document.events.invalidate({ x: 1, y: 0, width: 1, height: 1 });
    await autosave.flush();
    expect(statuses).toEqual(['saving', 'saving', 'saved']); // only B's completion reported

    // Now let A finish. Its write did commit, but it must not tell the UI "saved" again: B
    // already reported the true, fully-persisted state, and A finishing after doesn't change
    // that here (nothing dirtied since B).
    releaseFirst();
    await firstFlush;
    expect(statuses).toEqual(['saving', 'saving', 'saved']);

    autosave.dispose();
  });

  test("a failure that lands while a newer flush is already saving is not masked by that flush's success", async () => {
    const document = createBitmapDocument('doc', 256, 256);
    const store = createFakeStore();
    const { clock } = createManualClock();
    const statuses: string[] = [];
    const autosave = attachAutosave(document, store, {
      clock,
      debounceMs: 5000,
      maxWaitMs: 20000,
      onStatus: (status) => statuses.push(status),
    });

    const failA = store.blockNextSaveAndFail();
    document.pixels[0] = packRgba(1, 1, 1, 255); // tile 0:0
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    const flushA = autosave.flush().catch(() => {}); // A: blocks inside store.save, will fail

    await new Promise((resolve) => setTimeout(resolve, 10)); // let A actually reach its gate

    const releaseB = store.blockNextSave();
    document.pixels[70 * 256 + 70] = packRgba(2, 2, 2, 255); // tile 1:1, a second edit while A is in flight
    document.events.invalidate({ x: 70, y: 70, width: 1, height: 1 });
    const flushB = autosave.flush(); // B: starts (and captures only tile 1:1), also blocks

    await new Promise((resolve) => setTimeout(resolve, 10)); // let B actually reach its own gate

    // A fails while B is still saving: A's tiles merge back, but B already captured its own
    // separately and won't include them.
    failA(new Error('simulated write failure'));
    await flushA;
    expect(statuses).toEqual(['saving', 'saving']); // A's error suppressed: B is the newer flush

    releaseB();
    await flushB;
    // B's write did commit, but tile 0:0 is still unsaved (merged back by A's failure) and
    // nothing has captured it yet: reporting "saved" here would hide that from the UI, so this
    // must read as an error instead, keeping Retry available.
    expect(statuses).toEqual(['saving', 'saving', 'error']);

    await autosave.flush(); // retry: must still pick up tile 0:0
    expect(statuses).toEqual(['saving', 'saving', 'error', 'saving', 'saved']);
    expect(store.saves.at(-1)!.tiles.map((t) => `${t.tx}:${t.ty}`)).toEqual(['0:0']);

    autosave.dispose();
  });

  test('dispose stops future saves', async () => {
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 50, maxWaitMs: 200 });
    autosave.dispose();
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    await advance(1000, store);
    expect(store.saves).toHaveLength(0);
  });

  test('dispose flushes any dirty tiles instead of dropping them', async () => {
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 5000, maxWaitMs: 20000 });
    document.pixels[0] = packRgba(4, 5, 6, 255);
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    autosave.dispose(); // long before the 5s debounce would ever fire on its own
    await store.waitForIdle(); // let the real encode + store.save settle
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.fullResave).toBe(false);
  });

  test('a second dispose is a no-op', async () => {
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 5000, maxWaitMs: 20000 });
    document.pixels[0] = packRgba(4, 5, 6, 255);
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    autosave.dispose();
    autosave.dispose();
    await store.waitForIdle();
    expect(store.saves).toHaveLength(1);
  });

  test('committing a shape schedules a save, with zero dirty tiles since no pixel changed', async () => {
    const { annotationsFor } = await import('../../annotations/model');
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 100, maxWaitMs: 500 });

    annotationsFor(document).commit({
      id: 'r1',
      kind: 'rectangle',
      start: { x: 0, y: 0 },
      end: { x: 5, y: 5 },
      width: 1,
      color: packRgba(1, 2, 3),
    });
    await advance(100, store);

    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.tiles).toHaveLength(0);
    expect(store.saves[0]!.shapes).toHaveLength(1);
    autosave.dispose();
  });

  test('a shape still in preview (mid-drag) never schedules a save on its own', async () => {
    const { annotationsFor } = await import('../../annotations/model');
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 100, maxWaitMs: 500 });

    annotationsFor(document).showPreview({
      id: 'preview',
      kind: 'rectangle',
      start: { x: 0, y: 0 },
      end: { x: 5, y: 5 },
      width: 1,
      color: packRgba(1, 2, 3),
    });
    await advance(1000, store);

    expect(store.saves).toHaveLength(0);
    autosave.dispose();
  });

  test('a failed shapes-only save keeps the shape list dirty, so a retry saves it', async () => {
    const { annotationsFor } = await import('../../annotations/model');
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 50, maxWaitMs: 200 });

    store.failNext = true;
    annotationsFor(document).commit({
      id: 'r1',
      kind: 'rectangle',
      start: { x: 0, y: 0 },
      end: { x: 5, y: 5 },
      width: 1,
      color: packRgba(1, 2, 3),
    });
    await advance(50, store);
    expect(store.saves).toHaveLength(0); // the one attempt failed

    await autosave.flush(); // retry
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.shapes).toHaveLength(1);
    autosave.dispose();
  });

  test('restoring a prior shape list (as undo/redo does, via replace) schedules a save', async () => {
    const { annotationsFor } = await import('../../annotations/model');
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 100, maxWaitMs: 500 });
    const shape = {
      id: 'r1',
      kind: 'rectangle' as const,
      start: { x: 0, y: 0 },
      end: { x: 5, y: 5 },
      width: 1,
      color: packRgba(1, 2, 3),
    };

    // Undo/redo restores a prior snapshot via `AnnotationSet.replace`, the same call this
    // simulates directly — see `annotationHistoryState` in `annotations/core/commands.ts`.
    annotationsFor(document).replace([shape]);
    await advance(100, store);
    expect(store.saves).toHaveLength(1);

    annotationsFor(document).replace([]); // an "undo" back to no shapes
    await advance(100, store);
    expect(store.saves).toHaveLength(2);
    expect(store.saves[1]!.shapes).toEqual([]);
    autosave.dispose();
  });
});

/** A minimal `EventTarget`-alike: `attachAutosave` only ever calls `addEventListener`,
 *  `removeEventListener`, and (via `globalThis.document`) reads `visibilityState`. */
class FakeEventTarget {
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, callback: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(callback);
  }
  removeEventListener(type: string, callback: () => void): void {
    this.listeners.get(type)?.delete(callback);
  }
  dispatch(type: string): void {
    for (const callback of this.listeners.get(type) ?? []) callback();
  }
}

/** Installs a fake `window`/`document` for the duration of `run`, so a test can dispatch
 *  `pagehide`/`visibilitychange` the same way a real page teardown would, then restores whatever
 *  was there before (nothing, under `bun test`). */
async function withFakeWindow(run: (window: FakeEventTarget) => Promise<void>): Promise<void> {
  const fakeWindow = new FakeEventTarget();
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { window?: unknown }).window = fakeWindow;
  (globalThis as { document?: unknown }).document = { visibilityState: 'visible' };
  try {
    await run(fakeWindow);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
    (globalThis as { document?: unknown }).document = previousDocument;
  }
}

function setVisibility(state: 'visible' | 'hidden'): void {
  (globalThis as { document: { visibilityState: string } }).document.visibilityState = state;
}

describe('crash-recovery journal: stashed only at page exit', () => {
  test('a pagehide stash covers an earlier stroke still saving, not just what is currently dirty', async () => {
    await withFakeWindow(async (fakeWindow) => {
      const document = createBitmapDocument('doc', 256, 256);
      const store = createFakeStore();
      const { clock } = createManualClock();
      const autosave = attachAutosave(document, store, {
        clock,
        debounceMs: 5000,
        maxWaitMs: 20000,
      });

      const release = store.blockNextSave();
      document.pixels[0] = packRgba(1, 1, 1, 255); // tile 0:0
      document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
      const firstFlush = autosave.flush(); // starts, blocks inside store.save on the gate

      await new Promise((resolve) => setTimeout(resolve, 10)); // let it actually reach the gate

      // A second stroke lands in a different tile while the first save is still in flight and
      // has never itself been captured by any flush — mirrors the durability harness's "reload
      // while a save from an earlier stroke is in flight" case.
      document.pixels[70 * 256 + 70] = packRgba(2, 2, 2, 255); // tile 1:1
      document.events.invalidate({ x: 70, y: 70, width: 1, height: 1 });

      fakeWindow.dispatch('pagehide');
      expect(store.stashes).toHaveLength(1);
      expect(new Set(store.stashes[0]!.tiles.map((t) => `${t.tx}:${t.ty}`))).toEqual(
        new Set(['0:0', '1:1']),
      );

      release();
      await firstFlush;
      autosave.dispose();
    });
  });

  test('a committed shape with no dirty pixel tile is still stashed on pagehide', async () => {
    await withFakeWindow(async (fakeWindow) => {
      const { annotationsFor } = await import('../../annotations/model');
      const document = createBitmapDocument('doc', 32, 32);
      const store = createFakeStore();
      const { clock } = createManualClock();
      const autosave = attachAutosave(document, store, {
        clock,
        debounceMs: 5000,
        maxWaitMs: 20000,
      });

      annotationsFor(document).commit({
        id: 'r1',
        kind: 'rectangle',
        start: { x: 0, y: 0 },
        end: { x: 5, y: 5 },
        width: 1,
        color: packRgba(1, 2, 3),
      });

      fakeWindow.dispatch('pagehide');
      expect(store.stashes).toHaveLength(1);
      expect(store.stashes[0]!.tiles).toHaveLength(0);
      expect(store.stashes[0]!.shapes).toHaveLength(1);

      await store.waitForIdle(); // let the triggered flush settle
      autosave.dispose();
    });
  });

  test('flushPendingEdits runs before a pagehide stash reads what is dirty', async () => {
    // Stands in for `ShapeController.flush()`: a shape nudge or restyle still inside its own
    // debounce window is only a preview, invisible to `pendingShapesDirty` until something
    // commits it. Synchronously committing an annotation inside the callback, the same way a
    // real `flush()` does, must be reflected in this same pagehide's stash — not merely
    // scheduled for whatever save runs next.
    await withFakeWindow(async (fakeWindow) => {
      const { annotationsFor } = await import('../../annotations/model');
      const document = createBitmapDocument('doc', 32, 32);
      const store = createFakeStore();
      const { clock } = createManualClock();
      const autosave = attachAutosave(document, store, {
        clock,
        debounceMs: 5000,
        maxWaitMs: 20000,
        flushPendingEdits() {
          annotationsFor(document).commit({
            id: 'r1',
            kind: 'rectangle',
            start: { x: 0, y: 0 },
            end: { x: 5, y: 5 },
            width: 1,
            color: packRgba(1, 2, 3),
          });
        },
      });

      fakeWindow.dispatch('pagehide');
      expect(store.stashes).toHaveLength(1);
      expect(store.stashes[0]!.shapes).toHaveLength(1);

      await store.waitForIdle();
      autosave.dispose();
    });
  });

  test('flushPendingEdits never runs on an ordinary dispose', async () => {
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock } = createManualClock();
    let called = false;
    const autosave = attachAutosave(document, store, {
      clock,
      debounceMs: 5000,
      maxWaitMs: 20000,
      flushPendingEdits() {
        called = true;
      },
    });
    autosave.dispose();
    await store.waitForIdle();
    expect(called).toBe(false);
  });

  test('visibilitychange stashes only when the page is becoming hidden, not becoming visible', async () => {
    await withFakeWindow(async (fakeWindow) => {
      const document = createBitmapDocument('doc', 32, 32);
      const store = createFakeStore();
      const { clock } = createManualClock();
      const autosave = attachAutosave(document, store, {
        clock,
        debounceMs: 5000,
        maxWaitMs: 20000,
      });
      document.pixels[0] = packRgba(1, 1, 1, 255);
      document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });

      setVisibility('visible');
      fakeWindow.dispatch('visibilitychange');
      expect(store.stashes).toHaveLength(0);

      setVisibility('hidden');
      fakeWindow.dispatch('visibilitychange');
      expect(store.stashes).toHaveLength(1);

      await store.waitForIdle(); // let the triggered flush settle
      autosave.dispose();
    });
  });

  test('an edit made while a save is in flight is still stashed after that save commits', async () => {
    // Regression for a gap the lead found: resetting `pendingTiles` to empty whenever
    // `inFlightFlushes` reaches zero on success wrongly assumed every accumulated tile was part
    // of the flush that just committed. An edit that lands mid-flush sits in `dirtyTiles` for the
    // *next* flush and was never captured by this one — clearing it out from under `pendingTiles`
    // would let it vanish from the journal even though it is still only in memory.
    await withFakeWindow(async (fakeWindow) => {
      const document = createBitmapDocument('doc', 256, 256);
      const store = createFakeStore();
      const { clock } = createManualClock();
      const autosave = attachAutosave(document, store, {
        clock,
        debounceMs: 5000,
        maxWaitMs: 20000,
      });

      const release = store.blockNextSave();
      document.pixels[0] = packRgba(1, 1, 1, 255); // tile 0:0
      document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
      const firstFlush = autosave.flush(); // starts, blocks inside store.save on the gate

      await new Promise((resolve) => setTimeout(resolve, 10)); // let it actually reach the gate

      // Lands while the first save is still in flight — captured by neither that flush (already
      // took its snapshot) nor any flush yet (nothing else has run).
      document.pixels[70 * 256 + 70] = packRgba(2, 2, 2, 255); // tile 1:1
      document.events.invalidate({ x: 70, y: 70, width: 1, height: 1 });

      release();
      await firstFlush; // the first save commits; tile 1:1 was never part of it

      fakeWindow.dispatch('pagehide');
      expect(store.stashes).toHaveLength(1);
      expect(store.stashes[0]!.tiles.map((t) => `${t.tx}:${t.ty}`)).toEqual(['1:1']);

      autosave.dispose();
    });
  });

  test('once a save commits, a later exit signal has nothing left to stash', async () => {
    await withFakeWindow(async (fakeWindow) => {
      const document = createBitmapDocument('doc', 32, 32);
      const store = createFakeStore();
      const { clock } = createManualClock();
      const autosave = attachAutosave(document, store, {
        clock,
        debounceMs: 5000,
        maxWaitMs: 20000,
      });
      document.pixels[0] = packRgba(1, 1, 1, 255);
      document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
      await autosave.flush(); // commits normally, off the exit path

      fakeWindow.dispatch('pagehide');
      expect(store.stashes).toHaveLength(0);

      autosave.dispose();
    });
  });

  test('an ordinary dispose (in-app navigation) never writes to the crash journal', async () => {
    const document = createBitmapDocument('doc', 32, 32);
    const store = createFakeStore();
    const { clock } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 5000, maxWaitMs: 20000 });
    document.pixels[0] = packRgba(4, 5, 6, 255);
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    autosave.dispose();
    await store.waitForIdle();
    expect(store.saves).toHaveLength(1); // still flushed normally
    expect(store.stashes).toHaveLength(0); // but never through the journal
  });
});

describe('saveDocument', () => {
  test('performs one immediate full save, independent of any autosave subscription', async () => {
    const document = createBitmapDocument('doc', 16, 16, 'Fresh');
    document.pixels[0] = packRgba(1, 2, 3, 255);
    const store = createFakeStore();
    await saveDocument(document, store);
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.fullResave).toBe(true);
    expect(store.saves[0]!.name).toBe('Fresh');
  });
});
