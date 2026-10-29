import type { ShowToastFn, ToastDismissFn, ToastOptions } from '@astryxdesign/core/Toast';

/**
 * A toast front door that works before the toast runtime has loaded. Toasts raised early wait
 * in order and show once a viewport attaches. Each one asks for the runtime, so a load that failed
 * is retried by the next toast. Dismissing one that never showed simply drops it.
 */
interface Toaster {
  show: ShowToastFn;
  /** Connects a live viewport, flushes the queue, and returns a detach function. */
  attach: (show: ShowToastFn) => () => void;
}

interface Waiting {
  options: ToastOptions;
  dismissed: boolean;
  dismiss?: ToastDismissFn;
}

export function createToaster(request: () => void): Toaster {
  let live: ShowToastFn | null = null;
  let queue: Waiting[] = [];

  return {
    show(options) {
      if (live) return live(options);
      const waiting: Waiting = { options, dismissed: false };
      queue.push(waiting);
      request();
      return () => {
        waiting.dismissed = true;
        waiting.dismiss?.();
      };
    },
    attach(show) {
      live = show;
      const flushed = queue;
      queue = [];
      for (const waiting of flushed)
        if (!waiting.dismissed) waiting.dismiss = show(waiting.options);
      return () => {
        if (live === show) live = null;
      };
    },
  };
}
