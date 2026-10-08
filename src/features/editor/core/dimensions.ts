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

export interface Size {
  readonly width: number;
  readonly height: number;
}

export function isUsableSize(size: Size): boolean {
  return sideProblem(size.width) === null && sideProblem(size.height) === null;
}

/**
 * The other side of a linked pair, from the ratio the link was set with (`from`:`to`) rather
 * than the current pair, so repeated edits never drift. An unusable side leaves the other alone.
 */
export function linkedSide(value: number, from: number, to: number, unchanged: number): number {
  if (sideProblem(value) !== null || sideProblem(from) !== null) return unchanged;
  return Math.max(1, Math.round((value * to) / from));
}

/**
 * Whether a size field's text names the side it committed. A draft the field rejected stays on
 * screen while the old side stays committed, and Return must not submit that old side.
 */
export function textNamesSide(text: string, side: number): boolean {
  const cleaned = text.trim().replace(/px$/i, '').replace(/[\s,]/g, '');
  return cleaned !== '' && Number(cleaned) === side;
}
