import type { Annotation } from './contracts';

export function isValidAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== 'object') return false;
  const shape = value as Partial<Annotation>;
  return (
    typeof shape.id === 'string' &&
    shape.id.length > 0 &&
    (shape.kind === 'rectangle' || shape.kind === 'arrow') &&
    Number.isFinite(shape.start?.x) &&
    Number.isFinite(shape.start?.y) &&
    Number.isFinite(shape.end?.x) &&
    Number.isFinite(shape.end?.y) &&
    Number.isFinite(shape.width) &&
    shape.width! > 0 &&
    Number.isInteger(shape.color) &&
    shape.color! >= 0 &&
    shape.color! <= 0xffffffff
  );
}
