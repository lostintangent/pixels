import { describe, expect, test } from 'bun:test';
import type { Viewport, ViewportInsets } from '../../canvas/model';
import { boundsFor, fitAroundIslands, frameCenter } from './fit';
import type { IslandRect } from './fit';

const FRAME: ViewportInsets = { top: 72, right: 76, bottom: 56, left: 76 };
const TABLET_FRAME: ViewportInsets = { ...FRAME, bottom: 76 };

function view(cssWidth: number, cssHeight: number): Viewport {
  return { zoom: 1, panX: 0, panY: 0, cssWidth, cssHeight, devicePixelRatio: 2 };
}

/** The desktop color panel, pinned 16 px from the top right. */
function panel(cssWidth: number, width: number, bottom: number): IslandRect {
  return { left: cssWidth - 16 - width, top: 16, right: cssWidth - 16, bottom };
}

describe('fitAroundIslands', () => {
  test('centers in the frame when no island is in the way', () => {
    const fit = fitAroundIslands(view(1440, 900), 64, 64, FRAME, [panel(1440, 244, 360)]);
    expect(fit).toMatchObject({ zoom: 12, panX: 336, panY: 74 });
  });

  test.each([
    [820, 1180, 10, 90, 436.5],
    [768, 1024, 8, 128, 422.5],
    [1024, 1366, 13, 96, 433.5],
  ])('fits a 64px tablet document beneath the panel at %i × %i', (width, height, zoom, x, y) => {
    const fit = fitAroundIslands(view(width, height), 64, 64, TABLET_FRAME, [
      panel(width, 370, 397),
    ]);
    expect(fit).toMatchObject({ zoom, panX: x, panY: y });
    expect(fit.panY - 397).toBeGreaterThanOrEqual(12);
    expect(height - 76 - (fit.panY + 64 * zoom)).toBeGreaterThanOrEqual(0);
  });

  test('moves beside an island only when centering would still overlap it', () => {
    const fit = fitAroundIslands(view(1180, 820), 64, 64, FRAME, [panel(1180, 370, 397)]);
    expect(fit).toMatchObject({ zoom: 10, panX: 109, panY: 98 });
  });

  test('drops one whole zoom when that clears an island', () => {
    // 38× would end 6 px short of the island, inside the 12 px gap.
    const grazing = { left: 694, top: 100, right: 760, bottom: 500 };
    const fit = fitAroundIslands(view(768, 900), 16, 16, FRAME, [grazing]);
    expect(fit).toMatchObject({ zoom: 37, fittedZoom: 37, panX: 88, panY: 162 });
    expect(grazing.left - (fit.panX + 16 * fit.zoom)).toBeGreaterThanOrEqual(12);
  });

  test('shrinks a large image to the whole percentage that clears an island', () => {
    // A wide island along the top grazes a centered 4000 × 3000 fit. Moving beside it would halve it.
    const island = { left: 600, top: 16, right: 1424, bottom: 120 };
    const fit = fitAroundIslands(view(1440, 900), 4000, 3000, FRAME, [island]);
    expect(fit.zoom).toBe(0.21);
    expect(fit.fittedZoom).toBe(0.21);
    const center = frameCenter(fit, FRAME);
    expect(fit.panX + (4000 * fit.zoom) / 2).toBeCloseTo(center.x, 6);
    expect(fit.panY).toBeGreaterThanOrEqual(island.bottom + 12);
  });

  test('reserves the island column for a wide document that would run under it', () => {
    const fit = fitAroundIslands(view(1440, 900), 128, 64, FRAME, [panel(1440, 244, 360)]);
    expect(fit).toMatchObject({ zoom: 8, panX: 110, panY: 202 });
  });

  test('reserves the left column for an island on the left', () => {
    const island = { left: 16, top: 16, right: 260, bottom: 800 };
    const fit = fitAroundIslands(view(1440, 900), 128, 64, FRAME, [island]);
    expect(fit.panX).toBeGreaterThanOrEqual(island.right + 12);
  });

  test('ignores islands entirely when there are none', () => {
    const fit = fitAroundIslands(view(390, 844), 32, 32, FRAME, []);
    const center = frameCenter(fit, FRAME);
    expect(fit.panX + (32 * fit.zoom) / 2).toBe(center.x);
    expect(fit.panY + (32 * fit.zoom) / 2).toBe(center.y);
  });
});

describe('boundsFor', () => {
  test('fractional DPR floor follows snapped 1×, and Fit stays on whole device pixels', () => {
    for (const dpr of [1.25, 1.5, 1.75, 2.2, 2.625]) {
      const scaled = { ...view(390, 844), devicePixelRatio: dpr };
      const fit = fitAroundIslands(scaled, 100, 100, FRAME, []);
      expect(fit.zoom * dpr).toBeCloseTo(Math.round(fit.zoom * dpr), 12);
      expect(boundsFor(scaled, 100, 100, FRAME, []).minZoom).toBeCloseTo(
        Math.min(Math.round(dpr) / dpr, fit.zoom),
        12,
      );
      const constrained = fitAroundIslands(scaled, 100, 100, FRAME, [
        { left: 300, top: 100, right: 390, bottom: 600 },
      ]);
      expect(constrained.zoom * dpr).toBeCloseTo(Math.round(constrained.zoom * dpr), 12);
    }
  });
  test('a sprite can always zoom out to true size', () => {
    const bounds = boundsFor(view(1440, 900), 32, 32, FRAME, [panel(1440, 244, 360)]);
    expect(bounds).toEqual({ minZoom: 1, frame: FRAME, documentWidth: 32, documentHeight: 32 });
  });

  test('a large image stops at the fit an island forces, not the plain centered one', () => {
    // Centered, 64% would run under the panel, so the fit and the floor are both 44%.
    const islands = [panel(1180, 370, 397)];
    const bounds = boundsFor(view(1180, 820), 1600, 1000, FRAME, islands);
    expect(bounds.minZoom).toBe(0.44);
    expect(bounds.minZoom).toBe(fitAroundIslands(view(1180, 820), 1600, 1000, FRAME, islands).zoom);
  });

  test('a huge document stops at its fit', () => {
    // 238 / 4096 is 5.8%, and a fit below 1× keeps the largest whole percentage.
    expect(boundsFor(view(390, 844), 4096, 4096, FRAME, []).minZoom).toBe(0.05);
  });
});
