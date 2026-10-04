import { useRef } from 'react';
import type { MouseEvent } from 'react';

/*
 * A press on editor chrome leaves keyboard focus where it was, as native macOS controls do, so
 * arrow keys keep nudging the canvas selection instead of roving the palette, the tool group, or a
 * slider that was just clicked. Tab still reaches every control for keyboard use.
 */

/** For buttons: the mouse press doesn't take focus at all. The click still fires. */
export function keepFocusOnPress(event: MouseEvent): void {
  event.preventDefault();
}

/**
 * For a control that focuses itself from script when pressed, such as a slider thumb: spread on a
 * wrapper, and focus returns to what had it once the press ends.
 */
export function useReturnFocusAfterPress() {
  const previous = useRef<Element | null>(null);
  const restore = (event: { currentTarget: Element }) => {
    const before = previous.current;
    previous.current = null;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !event.currentTarget.contains(active)) return;
    if (before instanceof HTMLElement && before !== document.body && before.isConnected) {
      before.focus({ preventScroll: true });
    } else active.blur();
  };
  return {
    onPointerDownCapture: () => {
      previous.current = document.activeElement;
    },
    onPointerUp: restore,
    onPointerCancel: restore,
  };
}
