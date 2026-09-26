import { lazy, Suspense, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

export type DeferredProps<P> = P & {
  /** Whether the surface is showing. It mounts on the first `true` and then stays mounted. */
  when: boolean;
};

export interface Deferred<P> {
  (props: DeferredProps<P>): ReactNode;
  /** Starts loading the chunk early, for example when the user shows intent. */
  preload(): void;
}

/**
 * Keeps an on-demand surface out of the first load. Its chunk is fetched the first time
 * it opens (or on `preload`), and it stays mounted afterward so exit animations still play.
 */
export function deferred<P extends object>(load: () => Promise<ComponentType<P>>): Deferred<P> {
  let chunk: Promise<{ default: ComponentType<P> }> | undefined;
  const fetch = () =>
    (chunk ??= load().then(
      (component) => ({ default: component }),
      (error: unknown) => {
        // A missing chunk shouldn't take the editor down. The surface stays closed.
        console.error(error);
        const Missing: ComponentType<P> = () => null;
        return { default: Missing };
      },
    ));
  const Lazy = lazy(fetch) as unknown as ComponentType<P>;

  function DeferredSurface({ when, ...props }: DeferredProps<P>) {
    const [mounted, setMounted] = useState(when);
    if (when && !mounted) setMounted(true);
    if (!mounted && !when) return null;
    return (
      <Suspense fallback={null}>
        <Lazy {...(props as P)} />
      </Suspense>
    );
  }
  return Object.assign(DeferredSurface, { preload: () => void fetch() });
}
