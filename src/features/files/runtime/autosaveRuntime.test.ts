import { describe, expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import type {
  AutosaveClock,
  DocumentSnapshot,
  DocumentStore,
  DocumentSummary,
} from '../core/contracts';
import { attachAutosave } from './autosaveRuntime';

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

function createFakeStore(): DocumentStore & { saves: DocumentSnapshot[]; failNext: boolean } {
  const saved = new Map<string, DocumentSnapshot & { thumbnail: Uint8Array }>();
  const store = {
    saves: [] as DocumentSnapshot[],
    failNext: false,
    async save(snapshot: DocumentSnapshot, thumbnail: Uint8Array) {
      if (store.failNext) {
        store.failNext = false;
        throw new Error('simulated write failure');
      }
      store.saves.push(snapshot);
      saved.set(snapshot.id, { ...snapshot, thumbnail });
    },
    async rename() {},
    async load() {
      return null;
    },
    async remove() {},
    async listRecents(): Promise<DocumentSummary[]> {
      return [];
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
});
