import { useState } from 'react';
import type { ComponentType } from 'react';

/**
 * Keeps an on-demand surface out of the first load. Its chunk is fetched the first time `when` is
 * true, or on `preload` when the user shows intent, and it stays mounted afterward so exit
 * animations still play. A loaded surface renders in the same commit that opens it. This avoids
 * `lazy` and Suspense, which hold a first reveal back by up to 300 ms even when the chunk is cached.
 */
export function deferred<P extends object>(load: () => Promise<ComponentType<P>>) {
  let chunk: Promise<ComponentType<P>> | undefined;
  let ready: ComponentType<P> | undefined;
  const fetch = () =>
    (chunk ??= load().then(
      (component) => (ready = component),
      (error: unknown) => {
        // A missing chunk shouldn't take the editor down. The surface stays closed.
        console.error(error);
        return (ready = () => null);
      },
    ));

  function DeferredSurface({ when, ...props }: P & { when: boolean }) {
    const [Surface, setSurface] = useState<ComponentType<P>>();
    if (when && !Surface) {
      if (ready) setSurface(() => ready);
      else void fetch().then((component) => setSurface(() => component));
    }
    return Surface ? <Surface {...(props as P)} /> : null;
  }
  return Object.assign(DeferredSurface, { preload: () => void fetch() });
}
