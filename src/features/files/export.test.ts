import { describe, expect, test } from 'bun:test';
import { annotationsFor } from '../annotations/model';
import { createBitmapDocument, packRgba } from '../document';
import { exportPng } from './export';
import { encodePngOffMainThread } from './runtime/pngWorkerClient';

describe('exportPng', () => {
  test('matches the plain off-main-thread encode for a document with no shapes', async () => {
    const document = createBitmapDocument('no-shapes', 2, 1);
    document.pixels.set([packRgba(10, 20, 30, 255), packRgba(40, 50, 60, 255)]);
    const exported = await exportPng(document);
    const direct = await encodePngOffMainThread(
      document.width,
      document.height,
      document.pixels,
      1,
      document.colorSpace,
    );
    expect([...exported]).toEqual([...direct]);
  });

  test('passes committed shapes through to the flatten step, not just the raw pixels', async () => {
    const document = createBitmapDocument('with-shape', 2, 1);
    const set = annotationsFor(document);
    set.commit({
      id: 'r1',
      kind: 'rectangle',
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      width: 1,
      color: packRgba(255, 0, 0, 255),
    });
    // bun test has no OffscreenCanvas/DOM canvas: a reaching, non-empty shapes list surfaces as
    // this specific rejection rather than a silently un-flattened export (real browsers always
    // have OffscreenCanvas in the worker, so production never takes this branch).
    let error: unknown;
    try {
      await exportPng(document);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/OffscreenCanvas/);
  });

  test('a shape still only in preview (never committed) is excluded, same as autosave', async () => {
    const document = createBitmapDocument('preview-only', 2, 1);
    document.pixels.set([packRgba(1, 1, 1, 255), packRgba(2, 2, 2, 255)]);
    const set = annotationsFor(document);
    set.showPreview({
      id: 'p1',
      kind: 'rectangle',
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      width: 1,
      color: packRgba(0, 255, 0, 255),
    });
    const exported = await exportPng(document);
    const direct = await encodePngOffMainThread(
      document.width,
      document.height,
      document.pixels,
      1,
      document.colorSpace,
    );
    expect([...exported]).toEqual([...direct]);
  });
});
