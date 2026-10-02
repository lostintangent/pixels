import { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

export type DeferredProps<P> = P & {
  /** Whether the surface is showing. It mounts on the first `true` and then stays mounted. */
  when: boolean;
};

export interface Deferred<P> {
  (props: DeferredProps<P>): ReactNode;
  /** Starts loading the chunk early, for example when the user shows intent. */
  preload: () => void;
}

/**
 * Keeps an on-demand surface out of the first load. Its chunk is fetched the first time
 * it opens (or on `preload`), and it stays mounted afterward so exit animations still play.
 * A loaded surface renders in the same commit that opens it. This avoids `lazy` and Suspense,
 * which hold a first reveal back by up to 300 ms even when the chunk is cached.
 */
export function deferred<P extends object>(load: () => Promise<ComponentType<P>>): Deferred<P> {
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

  function DeferredSurface({ when, ...props }: DeferredProps<P>) {
    const [Surface, setSurface] = useState<ComponentType<P>>();
    if (when && !Surface) {
      if (ready) setSurface(() => ready);
      else void fetch().then((component) => setSurface(() => component));
    }
    return Surface ? <Surface {...(props as P)} /> : null;
  }
  return Object.assign(DeferredSurface, { preload: () => void fetch() });
}
