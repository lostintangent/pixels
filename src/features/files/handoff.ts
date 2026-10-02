import type { BitmapDocument } from '../document';

interface Pending {
  readonly id: string;
  readonly document: BitmapDocument;
}

/**
 * An explicit New or Open already has the finished `BitmapDocument` in memory and has just
 * durably saved it, right before navigating to its route. Stashing it here lets that route's
 * loader skip reading the same data back out of IndexedDB — tile-by-tile reassembly of a large
 * image is real work this feature already decoded once this tick. Any other way of reaching the
 * same id (a reload, back/forward, or a direct URL) finds nothing here, since this is in-memory
 * only, and loads from IndexedDB exactly as before.
 *
 * Only one hand-off is ever kept, not a map of every id ever opened: a second New or Open before
 * the first one's own navigation ever lands (its loader never ran, or it raced a slower save)
 * supersedes it, so the slot is overwritten rather than growing an entry nothing will ever
 * consume. A large decoded image waiting here is exactly the memory a superseded open must not
 * pin forever.
 */
let pending: Pending | null = null;

export function handOffDocument(document: BitmapDocument): void {
  pending = { id: document.id, document };
}

/** One-shot: consumes and clears the handed-off document for `id`, if it's still the pending one.
 *  Returns null otherwise, including when a newer hand-off has already replaced it. */
export function takeHandedOffDocument(id: string): BitmapDocument | null {
  if (pending?.id !== id) return null;
  const { document } = pending;
  pending = null;
  return document;
}

/** Clears `id`'s hand-off if its own navigation never lands (a rejected `navigate()` call) — a
 *  no-op if a newer hand-off already replaced it or the route already consumed it. */
export function clearHandedOffDocument(id: string): void {
  if (pending?.id === id) pending = null;
}
