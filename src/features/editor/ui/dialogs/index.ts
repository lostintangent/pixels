import { deferred } from '../../../../shared/react/deferred';

// Dialogs, the Shapes popover, the file drop card, and selection actions are rare, so they load on first open (or when the trigger that
// opens them is pressed). They share one lazy module: Rolldown hoists code shared by two lazy chunks
// into a chunk the entry loads.
const dialogs = () => import('./all');

export const NewCanvasDialog = deferred(() => dialogs().then((m) => m.NewCanvasDialog));
export const ResizeDialog = deferred(() => dialogs().then((m) => m.ResizeDialog));
export const ExportDialog = deferred(() => dialogs().then((m) => m.ExportDialog));
export const ShapesPopover = deferred(() => dialogs().then((m) => m.ShapesPopover));
export const DropCard = deferred(() => dialogs().then((m) => m.DropCard));
export const ToolActions = deferred(() => dialogs().then((m) => m.ToolActions));

export function preloadDialogs(): void {
  NewCanvasDialog.preload();
}
