import type { FloatingSelection } from '../../tools';

/**
 * The in-app pixel clipboard. It outlives any one document, so copying on one canvas and
 * pasting on another works, and it stays pixel-exact because it never round-trips through the
 * system clipboard. The token changes on every write, so a marker on the system clipboard can
 * say which copy it stands for.
 */
export interface PixelClipboard {
  readonly token: string;
  read(): FloatingSelection | null;
  write(selection: FloatingSelection): void;
}

export function createPixelClipboard(): PixelClipboard {
  const tab = Math.random().toString(36).slice(2, 10);
  let version = 0;
  let current: FloatingSelection | null = null;
  return {
    get token() {
      return `${tab}:${version}`;
    },
    read: () => current,
    write(selection) {
      current = selection;
      version += 1;
    },
  };
}

export const appClipboard = createPixelClipboard();
