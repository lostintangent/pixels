import { ToastViewport, useToast } from '@astryxdesign/core/Toast';
import type { ShowToastFn, ToastViewportProps } from '@astryxdesign/core/Toast';
import { useEffect } from 'react';

export interface ToastLayerProps {
  inset: ToastViewportProps['inset'];
  attach: (show: ShowToastFn) => () => void;
}

/** The toast runtime. It loads on the first toast or at idle, never in the first paint. */
export function ToastLayer({ inset, attach }: ToastLayerProps) {
  return (
    <ToastViewport position="bottomEnd" inset={inset} maxVisible={3}>
      <Attach attach={attach} />
    </ToastViewport>
  );
}

function Attach({ attach }: Pick<ToastLayerProps, 'attach'>) {
  const show = useToast();
  useEffect(() => attach(show), [attach, show]);
  return null;
}
