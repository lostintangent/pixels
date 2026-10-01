import { describe, expect, test } from 'bun:test';
import type { Viewport, ViewportInsets } from '../../canvas/model';
import { fitAroundIslands, frameCenter } from './fit';
import type { IslandRect } from './fit';

const FRAME: ViewportInsets = { top: 72, right: 76, bottom: 56, left: 76 };

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

  test('keeps a smaller zoom centered when that clears an island above the document', () => {
    // 6× would clear the panel by only 9 px, short of the 12 px gap the beside fit keeps.
    const fit = fitAroundIslands(view(820, 1180), 64, 64, FRAME, [panel(820, 370, 397)]);
    expect(fit).toMatchObject({ zoom: 5, panX: 250, panY: 438 });
    expect(fit.panY - 397).toBeGreaterThanOrEqual(12);
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
