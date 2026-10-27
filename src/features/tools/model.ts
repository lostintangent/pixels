/** Pixel tools needed for the first pencil stroke and the always-available selection model. */
export type {
  Brush,
  FillInput,
  FloatingSelection,
  LinePreview,
  MutationResult,
  SelectionSession,
  StrokeSample,
  StrokeSession,
  ToolKind,
} from './core/contracts';
export { beginStroke } from './core/stroke';
export { beginSelection, copySelection } from './core/selection';
