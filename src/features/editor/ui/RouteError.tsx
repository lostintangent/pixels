import * as stylex from '@stylexjs/stylex';
import { Button } from '@astryxdesign/core/Button';
import { colorVars, sizeVars } from '@astryxdesign/core/theme/tokens.stylex';
import { useNavigate, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { isLoadFailure, reloadPixels } from '../../../shared/chunkErrors';
import { createDocumentId } from '../../files';
import { pixelVars } from './tokens.stylex';

const COPY = {
  offline: ['You’re offline', 'Part of Pixels hasn’t loaded yet. This opens once you reconnect.'],
  reload: ['Pixels needs a reload', 'Part of Pixels didn’t load. Reloading keeps your work.'],
  broken: ['This document didn’t open', 'Something went wrong while opening it.'],
} as const;

/**
 * The page a route shows when its loader or editor throws. Code that never arrived needs the
 * network: offline, it waits and retries on reconnect, and online only a reload helps, since
 * Chromium remembers the failed fetch. Anything else can be tried again, or left for a new canvas.
 */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const navigate = useNavigate();
  // Set when Reload found Pixels unreachable, though the browser claimed to be online.
  const [unreachable, setUnreachable] = useState(false);
  const state: keyof typeof COPY = !isLoadFailure(error)
    ? 'broken'
    : navigator.onLine && !unreachable
      ? 'reload'
      : 'offline';
  const retry = () => {
    setUnreachable(false);
    void router.invalidate();
  };

  useEffect(() => {
    if (state !== 'offline') return;
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  });

  const [title, body] = COPY[state];
  return (
    <main {...stylex.props(styles.page)}>
      <section {...stylex.props(styles.card)}>
        <h1 {...stylex.props(styles.title)}>{title}</h1>
        <p {...stylex.props(styles.body)}>{body}</p>
        <div {...stylex.props(styles.actions)}>
          {state === 'broken' && (
            <Button
              variant="secondary"
              label="New canvas"
              onClick={() =>
                void navigate({ to: '/d/$docId', params: { docId: createDocumentId() } })
              }
            />
          )}
          <Button
            variant="primary"
            label={state === 'reload' ? 'Reload' : 'Try again'}
            onClick={
              state === 'reload'
                ? () => void reloadPixels().then((reloaded) => reloaded || setUnreachable(true))
                : retry
            }
          />
        </div>
      </section>
    </main>
  );
}

const styles = stylex.create({
  page: {
    display: 'grid',
    placeItems: 'center',
    minHeight: '100%',
    boxSizing: 'border-box',
    paddingTop: pixelVars.safeTop,
    paddingBottom: pixelVars.safeBottom,
    paddingLeft: pixelVars.safeLeft,
    paddingRight: pixelVars.safeRight,
    backgroundColor: pixelVars.canvasBg,
    [sizeVars['--size-element-md']]: { default: null, '@media (pointer: coarse)': '44px' },
  },
  card: {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: 360,
    padding: 24,
    backgroundColor: colorVars['--color-background-surface'],
    borderRadius: pixelVars.islandRadius,
    boxShadow: pixelVars.islandShadow,
    outline: { default: null, '@media (forced-colors: active)': '1px solid CanvasText' },
  },
  title: { margin: 0, fontSize: 17, fontWeight: 600, lineHeight: '22px' },
  body: {
    marginBlock: '6px 20px',
    fontSize: 14,
    lineHeight: '20px',
    color: colorVars['--color-text-secondary'],
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
});
