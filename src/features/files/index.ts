/** File IO is intentionally outside the pixel hot path: PNG import/export, IndexedDB persistence,
 *  autosave, and the recent documents list. Everything here can run in `bun test` without a DOM. */
export type {
  AutosaveClock,
  AutosaveOptions,
  AutosaveStatus,
  DocumentId,
  DocumentSnapshot,
  DocumentStore,
  DocumentSummary,
  ImportErrorReason,
  LoadedDocument,
  TileCoord,
  TileSnapshot,
} from './core/contracts';
export { ImportError, TILE_SIZE } from './core/contracts';
export { createDocumentId } from './core/documentId';
export { DOCUMENT_NAME_MAX_LENGTH, normalizeDocumentName } from './core/documentName';

export { importPng } from './import';
export { exportPng } from './export';

export { createDocumentStore } from './storage/documentStore';

export type { AttachAutosaveOptions, Autosave } from './runtime/autosaveRuntime';
export { attachAutosave, saveDocument } from './runtime/autosaveRuntime';
export { renameDocument } from './runtime/rename';

export { loadDocument, pickInitialDocumentId } from './loaders';
export { clearHandedOffDocument, handOffDocument, takeHandedOffDocument } from './handoff';
