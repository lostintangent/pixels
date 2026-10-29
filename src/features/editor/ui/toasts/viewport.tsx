import { Button } from '@astryxdesign/core/Button';
import { ToastViewport, useToast } from '@astryxdesign/core/Toast';
import type { ShowToastFn, ToastViewportProps } from '@astryxdesign/core/Toast';
import { useEffect, useEffectEvent } from 'react';
import { reloadPixels } from '../../../../shared/chunkErrors';
import type { Interruption } from '../../../../shared/chunkErrors';

interface ToastLayerProps {
  inset: ToastViewportProps['inset'];
  attach: (show: ShowToastFn) => () => void;
  interruption?: Interruption;
}

/** The toast runtime. It loads on the first toast or at idle, never in the first paint. */
export function ToastLayer({ inset, attach, interruption }: ToastLayerProps) {
  return (
    <ToastViewport position="bottomEnd" inset={inset} maxVisible={3}>
      <Attach attach={attach} />
      <Explain interruption={interruption} />
    </ToastViewport>
  );
}

function Attach({ attach }: Pick<ToastLayerProps, 'attach'>) {
  const show = useToast();
  useEffect(() => attach(show), [attach, show]);
  return null;
}

/**
 * One toast, whatever went wrong. Offline, nothing fixes a missing part until the connection
 * returns, so the toast says so and leaves when it does. Online, the tab is older than a deploy, or
 * Chromium remembers the failed fetch, and only a reload helps. An update waits for the same
 * Reload, which stores every edit first.
 */
function Explain({ interruption }: Pick<ToastLayerProps, 'interruption'>) {
  const show = useToast();
  // Each toast change hands out a new `show`. Rerunning for it would replace the offline toast
  // as it leaves on reconnect, so only a new interruption runs this again.
  const explain = useEffectEvent((interruption: Interruption) => {
    let dismiss: (() => void) | undefined;
    const offline = () => {
      dismiss = show({
        body: 'You’re offline, so that didn’t load. Try again once you’re back online.',
        isAutoHide: false,
        uniqueID: 'interruption',
      });
    };
    const reload = () =>
      void reloadPixels(interruption.kind === 'updated' ? interruption.activate : undefined)
        .then((reloaded) => reloaded || offline())
        .catch(() => {}); // Autosave's own toast explains, and offers Retry.

    if (interruption.kind === 'failed' && !navigator.onLine) offline();
    else
      show({
        body: `${interruption.kind === 'updated' ? 'Pixels was updated.' : 'Part of Pixels didn’t load.'} Reloading keeps your work.`,
        isAutoHide: false,
        uniqueID: 'interruption',
        endContent: <Button variant="secondary" size="sm" label="Reload" onClick={reload} />,
      });

    const online = () => dismiss?.();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  });

  useEffect(() => (interruption ? explain(interruption) : undefined), [interruption]);
  return null;
}
