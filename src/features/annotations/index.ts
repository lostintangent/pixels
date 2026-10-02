export type {
  Annotation,
  AnnotationChange,
  AnnotationHandle,
  AnnotationHandleId,
  AnnotationKind,
  AnnotationSet,
} from './core/contracts';
export { annotationsFor, createAnnotationSet, isValidAnnotation } from './core/set';
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
export {
  flattenAnnotations,
  paintAnnotation,
  paintAnnotationSelection,
  paintVisibleAnnotations,
} from './browser/paint';
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
