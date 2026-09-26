import type { ShowToastFn, ToastViewportProps } from '@astryxdesign/core/Toast';
import { createContext, use, useState } from 'react';
import type { ReactNode } from 'react';
import { deferred } from '../../../../shared/react/deferred';
import { createToaster } from './toaster';

const ToastLayer = deferred(() => import('./viewport').then((module) => module.ToastLayer));
export const preloadToasts = ToastLayer.preload;

const ToasterContext = createContext<ShowToastFn | null>(null);

/** Provides `useToast` to the editor, mounting the toast runtime only once there is a toast. */
export function ToastHost({
  inset,
  children,
}: {
  inset: ToastViewportProps['inset'];
  children: ReactNode;
}) {
  const [requested, setRequested] = useState(false);
  const [toaster] = useState(() => createToaster(() => setRequested(true)));
  return (
    <ToasterContext value={toaster.show}>
      {children}
      <ToastLayer when={requested} inset={inset} attach={toaster.attach} />
    </ToasterContext>
  );
}

export function useToast(): ShowToastFn {
  const show = use(ToasterContext);
  if (!show) throw new Error('useToast needs a ToastHost');
  return show;
}
