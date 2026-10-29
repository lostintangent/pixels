import type { ShowToastFn, ToastViewportProps } from '@astryxdesign/core/Toast';
import { createContext, use, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { onInterruption } from '../../../../shared/chunkErrors';
import type { Interruption } from '../../../../shared/chunkErrors';
import { deferred } from '../../../../shared/react/deferred';
import { createToaster } from './toaster';

const ToastLayer = deferred(() => import('./viewport').then((module) => module.ToastLayer));

const ToasterContext = createContext<ShowToastFn | null>(null);

/**
 * Provides `useToast` to the editor, mounting the toast runtime only once there is a toast. It
 * also explains a part of Pixels that didn't load, or a new version, with copy that lives in the
 * runtime so the first load doesn't carry it.
 */
export function ToastHost({
  inset,
  children,
}: {
  inset: ToastViewportProps['inset'];
  children: ReactNode;
}) {
  const [requested, setRequested] = useState(false);
  const [toaster] = useState(() => createToaster(() => setRequested(true)));
  const [interruption, setInterruption] = useState<Interruption>();
  useEffect(
    () =>
      onInterruption((next) => {
        setRequested(true);
        setInterruption(next);
      }),
    [],
  );
  // Toasts explain when any other part of Pixels fails to load, so they load first, at the first
  // idle moment after the editor paints rather than with the other surfaces. Never offline:
  // Chromium remembers a failed module fetch for the life of the page.
  useEffect(() => {
    const idle = () =>
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback(ToastLayer.preload, { timeout: 1000 })
        : ToastLayer.preload();
    if (navigator.onLine) return void idle();
    window.addEventListener('online', idle, { once: true });
    return () => window.removeEventListener('online', idle);
  }, []);
  return (
    <ToasterContext value={toaster.show}>
      {children}
      <ToastLayer
        when={requested}
        inset={inset}
        attach={toaster.attach}
        interruption={interruption}
        onLoadFail={() => setRequested(false)}
      />
    </ToasterContext>
  );
}

export function useToast(): ShowToastFn {
  const show = use(ToasterContext);
  if (!show) throw new Error('useToast needs a ToastHost');
  return show;
}
