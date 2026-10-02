export type {
  Annotation,
  AnnotationChange,
  AnnotationHandle,
  AnnotationHandleId,
  AnnotationKind,
  AnnotationSet,
} from './core/contracts';
export { annotationsFor, createAnnotationSet, isValidAnnotation } from './core/set';
export { findAnnotationsFor, watchAnnotationSet } from './core/registry';
export {
  annotationHistoryState,
  beginAnnotationEdit,
  createAnnotationId,
  deleteAnnotation,
  duplicateAnnotation,
  resizeAnnotatedDocument,
  translateAnnotation,
} from './core/commands';
export type { AnnotationEdit } from './core/commands';
export { compositeAnnotationLayer } from './core/composite';
export { hitAnnotationSet } from './core/hit';
export {
  arrowGeom,
  handlesOf,
  hitShape,
  rectOf,
  resizeRect,
  snap45,
  square,
  targetsOf,
} from './core/geometry';
