import { describe, expect, test } from 'bun:test';

import { MAX_DOCUMENT_SIDE } from '../../document';
import { canStepSide, isUsableSize, linkedSide, sideProblem, textNamesSide } from './dimensions';

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

describe('linked sides', () => {
  test('a square link copies the side, as it always has', () => {
    expect(linkedSide(48, 64, 64, 64)).toBe(48);
  });

  test('a widescreen link keeps 16:9 from either side', () => {
    expect(linkedSide(640, 320, 180, 180)).toBe(360);
    expect(linkedSide(90, 180, 320, 320)).toBe(160);
  });

  test('edits apply the linked ratio, so they never drift', () => {
    expect(linkedSide(100, 320, 180, 180)).toBe(56);
    expect(linkedSide(320, 320, 180, 56)).toBe(180);
  });

  test('a tiny side keeps at least one pixel on the other', () => {
    expect(linkedSide(1, 320, 180, 180)).toBe(1);
    expect(linkedSide(1, 180, 320, 320)).toBe(2);
  });

  test('an unusable side leaves the other alone', () => {
    expect(linkedSide(0, 320, 180, 180)).toBe(180);
    expect(linkedSide(12.5, 320, 180, 180)).toBe(180);
    expect(linkedSide(MAX_DOCUMENT_SIDE + 1, 320, 180, 180)).toBe(180);
  });

  test('a size is usable only when both sides are', () => {
    expect(isUsableSize({ width: 320, height: 180 })).toBe(true);
    expect(isUsableSize({ width: 0, height: 180 })).toBe(false);
  });
});

describe('Return in a size field', () => {
  test('submits when the text names the committed side', () => {
    expect(textNamesSide('640', 640)).toBe(true);
    expect(textNamesSide(' 640 px ', 640)).toBe(true);
    expect(textNamesSide('1,024', 1024)).toBe(true);
  });

  test('does not submit a draft the field rejected', () => {
    expect(textNamesSide('abc', 64)).toBe(false);
    expect(textNamesSide('', 64)).toBe(false);
    expect(textNamesSide('65', 64)).toBe(false);
  });
});
