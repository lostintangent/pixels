import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { reportLoadFailure } from '../chunkErrors';

/**
 * Keeps an on-demand surface out of the first load. Its chunk is fetched the first time `when` is
 * true, or on `preload` when the user shows intent, and it stays mounted afterward so exit
 * animations still play. A loaded surface renders in the same commit that opens it. This avoids
 * `lazy` and Suspense, which hold a first reveal back by up to 300 ms even when the chunk is cached.
 *
 * A chunk that fails to arrive (offline, or a deploy replaced it) isn't remembered, so the next
 * intent fetches it again. When an open fails, the failure is reported and `onLoadFail` lets the
 * owner close the surface, so opening it again is a fresh intent.
 */
export function deferred<P extends object>(load: () => Promise<ComponentType<P>>) {
  let chunk: Promise<ComponentType<P>> | undefined;
  let ready: ComponentType<P> | undefined;
  const fetch = () =>
    (chunk ??= load().then(
      (component) => (ready = component),
      (error: unknown) => {
        chunk = undefined;
        throw error;
      },
    ));

  function DeferredSurface({
    when,
    onLoadFail,
    ...props
  }: P & { when: boolean; onLoadFail?: () => void }) {
    const [Surface, setSurface] = useState<ComponentType<P>>();
    if (when && !Surface && ready) setSurface(() => ready);
    const isWaiting = when && !Surface && !ready;

    useEffect(() => {
      if (!isWaiting) return;
      let isCurrent = true;
      fetch().then(
        (component) => isCurrent && setSurface(() => component),
        (error: unknown) => {
          if (!isCurrent) return;
          reportLoadFailure(error);
          onLoadFail?.();
        },
      );
      return () => {
        isCurrent = false;
      };
      // An owner's fresh callback each render isn't a new intent.
    }, [isWaiting]);

    return Surface ? <Surface {...(props as P)} /> : null;
  }
  return Object.assign(DeferredSurface, {
    preload: () => void fetch().catch(() => {}),
  });
}
