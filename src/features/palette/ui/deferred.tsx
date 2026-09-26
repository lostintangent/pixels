import { deferred } from '../../../shared/react/deferred';
import type { ColorPickerPopoverProps } from './ColorPickerPopover';
import type { ColorSheetProps } from './ColorSheet';

// The full picker is only for custom colors, so it loads on first open instead of with the editor.
// One chunk for both, so the shared ColorPicker isn't hoisted into the first load.
const picker = () => import('./picker');
const LazyPopover = deferred(() => picker().then((m) => m.ColorPickerPopover));
const LazySheet = deferred(() => picker().then((m) => m.ColorSheet));

export function ColorPickerPopover(props: ColorPickerPopoverProps) {
  return <LazyPopover when={props.isOpen} {...props} />;
}

export function ColorSheet(props: ColorSheetProps) {
  return <LazySheet when={props.isOpen} {...props} />;
}

/** Warms the picker when the user heads toward it. */
export function preloadColorPicker(): void {
  LazyPopover.preload();
}
