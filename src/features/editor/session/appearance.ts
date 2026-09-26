import { createStore } from '@tanstack/store';
import { useSelector } from '@tanstack/react-store';
import { useSyncExternalStore } from 'react';

/** An app preference, not document state: it follows the person, not the canvas. */
export type Appearance = 'system' | 'light' | 'dark';
export type ColorScheme = 'light' | 'dark';

const STORAGE_KEY = 'pixels.appearance';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readAppearance(): Appearance {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

const appearance = createStore<Appearance>(readAppearance());

export function setAppearance(next: Appearance): void {
  appearance.setState(() => next);
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private browsing can refuse storage. The choice still applies for this visit.
  }
}

export function useAppearance(): Appearance {
  return useSelector(appearance, (mode) => mode);
}

function subscribeToSystemScheme(onChange: () => void): () => void {
  const query = matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** The scheme actually on screen, resolving `system` against the OS. */
export function useColorScheme(): ColorScheme {
  const mode = useAppearance();
  const systemDark = useSyncExternalStore(
    subscribeToSystemScheme,
    () => matchMedia(DARK_QUERY).matches,
    () => false,
  );
  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}
