import { MAX_DOCUMENT_SIDE } from '../../document';

/** Why a canvas side can't be used, or null when it can. Out-of-range entries are reported, never clamped. */
export function sideProblem(value: number): string | null {
  if (!Number.isFinite(value) || value < 1) return 'At least 1 px';
  if (!Number.isInteger(value)) return 'Whole pixels only';
  if (value > MAX_DOCUMENT_SIDE) return `Up to ${MAX_DOCUMENT_SIDE} px`;
  return null;
}

/** Whether an arrow-key step from this side stays in range or moves back toward it. */
export function canStepSide(value: number, direction: 1 | -1): boolean {
  if (!Number.isFinite(value)) return true;
  return direction > 0 ? value < MAX_DOCUMENT_SIDE : value > 1;
}
