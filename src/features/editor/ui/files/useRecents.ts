import { useCallback, useEffect, useState } from 'react';
import type { DocumentId, DocumentStore, DocumentSummary } from '../../../files';

/** Enough to jump back to recent work without turning the menu into a gallery. */
const RECENT_DOCUMENTS = 5;

export interface RecentDocument extends Omit<DocumentSummary, 'thumbnail'> {
  /** Object URL for the stored thumbnail, owned by the hook. */
  thumbnail: string;
}

/**
 * Other recently edited documents, newest first. The list loads on mount so the first menu
 * open doesn't grow in place, and `refresh` picks up the save made by the document you left.
 */
export function useRecents(
  store: DocumentStore,
  current: DocumentId,
): { recents: readonly RecentDocument[]; refresh: () => void } {
  const [recents, setRecents] = useState<readonly RecentDocument[]>([]);

  const refresh = useCallback(() => {
    store
      .listRecents()
      .then((summaries) => {
        const others = summaries
          .filter((summary) => summary.id !== current)
          .slice(0, RECENT_DOCUMENTS);
        setRecents(
          others.map(({ thumbnail, ...summary }) => ({
            ...summary,
            thumbnail: URL.createObjectURL(thumbnail),
          })),
        );
      })
      .catch(() => {});
  }, [store, current]);

  useEffect(refresh, [refresh]);
  // Revoke a list's URLs only once the next list has rendered in its place.
  useEffect(
    () => () => recents.forEach((recent) => URL.revokeObjectURL(recent.thumbnail)),
    [recents],
  );

  return { recents, refresh };
}

/** "Just now", "5 min ago", "Yesterday", or a short date. */
export function formatEdited(updatedAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - updatedAt) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  if (hours < 48) return 'Yesterday';
  return new Date(updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
