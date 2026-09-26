import { describe, expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import type {
  AutosaveClock,
  DocumentSnapshot,
  DocumentStore,
  DocumentSummary,
} from '../core/contracts';
import { attachAutosave, saveDocument } from './autosaveRuntime';

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
  async function advance(ms: number): Promise<void> {
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
      // The triggered flush does real async work (PNG encode via CompressionStream, IndexedDB).
      // Wait on the real event loop, not the fake clock, so it settles before we check timers again.
      await new Promise((resolve) => setTimeout(resolve, 5));
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
} {
  const saved = new Map<string, DocumentSnapshot & { thumbnail: Uint8Array }>();
  // A FIFO queue of gates, one per still-unconsumed `blockNextSave`/`blockNextSaveAndFail` call.
  // Each `save()` call consumes at most one gate, in call order, so overlapping saves can each be
  // controlled independently rather than all waiting on the same one.
  const gateQueue: Promise<void>[] = [];
  const store = {
    saves: [] as DocumentSnapshot[],
    stashes: [] as DocumentSnapshot[],
    failNext: false,
    async save(snapshot: DocumentSnapshot, thumbnail: Uint8Array | Promise<Uint8Array>) {
      const myGate = gateQueue.shift();
      if (myGate) await myGate; // may reject, surfacing as this call's own failure
      if (store.failNext) {
        store.failNext = false;
        throw new Error('simulated write failure');
      }
      const resolvedThumbnail = await thumbnail;
      store.saves.push(snapshot);
      saved.set(snapshot.id, { ...snapshot, thumbnail: resolvedThumbnail });
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
  };
  return store;
}

describe('attachAutosave', () => {
  test('does not save a blank, never-edited document', async () => {
    const document = createBitmapDocument('blank', 32, 32);
    const store = createFakeStore();
    const { clock, advance } = createManualClock();
    const autosave = attachAutosave(document, store, { clock, debounceMs: 100, maxWaitMs: 500 });
    await advance(1000);
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
    await advance(100);
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
    await advance(199);
    expect(store.saves).toHaveLength(0);
    await advance(1);
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
    await advance(50);
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
    await advance(50);
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
    await advance(1000);
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
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the real encode + store.save settle
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.saves).toHaveLength(1);
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

      await new Promise((resolve) => setTimeout(resolve, 20)); // let the triggered flush settle
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
