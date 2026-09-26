import { deferred } from '../../../../shared/react/deferred';

// Dialogs are rare, so they load on first open (or when the menu that opens them does).
const dialogs = () => import('./all');

export const NewCanvasDialog = deferred(() => dialogs().then((m) => m.NewCanvasDialog));
export const ResizeDialog = deferred(() => dialogs().then((m) => m.ResizeDialog));
export const ExportDialog = deferred(() => dialogs().then((m) => m.ExportDialog));

export function preloadDialogs(): void {
  NewCanvasDialog.preload();
}
