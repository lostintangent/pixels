import { describe, expect, test } from 'bun:test';

import { MAX_DOCUMENT_SIDE } from '../../document';
import { canStepSide, sideProblem } from './dimensions';

describe('canvas sides', () => {
  test('every whole size from 1 to the maximum is usable', () => {
    expect(sideProblem(1)).toBeNull();
    expect(sideProblem(64)).toBeNull();
    expect(sideProblem(MAX_DOCUMENT_SIDE)).toBeNull();
  });

  test('a size past the maximum is reported instead of becoming the maximum', () => {
    expect(sideProblem(6420)).toBe(`Up to ${MAX_DOCUMENT_SIDE} px`);
    expect(sideProblem(MAX_DOCUMENT_SIDE + 1)).toBe(`Up to ${MAX_DOCUMENT_SIDE} px`);
  });

  test('zero, negative, and non-numeric sizes ask for at least one pixel', () => {
    expect(sideProblem(0)).toBe('At least 1 px');
    expect(sideProblem(-8)).toBe('At least 1 px');
    expect(sideProblem(Number.NaN)).toBe('At least 1 px');
  });

  test('a fractional size asks for whole pixels', () => {
    expect(sideProblem(12.5)).toBe('Whole pixels only');
  });

  test('arrow steps stop at the range edges', () => {
    expect(canStepSide(MAX_DOCUMENT_SIDE, 1)).toBe(false);
    expect(canStepSide(1, -1)).toBe(false);
    expect(canStepSide(64, 1)).toBe(true);
    expect(canStepSide(64, -1)).toBe(true);
  });

  test('arrow steps from outside the range may only move back toward it', () => {
    expect(canStepSide(6420, -1)).toBe(true);
    expect(canStepSide(6420, 1)).toBe(false);
    expect(canStepSide(0, 1)).toBe(true);
    expect(canStepSide(0, -1)).toBe(false);
  });
});
