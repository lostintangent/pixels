import { describe, expect, test } from 'bun:test';
import type { Viewport } from './contracts';
import { MIN_OVERLAP, boundView, rubberBand, settleView, snapZoomWithin, startFit } from './bounds';
import type { ViewBounds } from './bounds';
import { fitViewport, screenToDocument } from './viewport';

const FRAME = { top: 72, right: 76, bottom: 56, left: 76 };
/** A 1288 × 772 frame inside a 1440 × 900 canvas. */
const VIEW: Viewport = {
  zoom: 1,
  panX: 0,
  panY: 0,
  cssWidth: 1440,
  cssHeight: 900,
  devicePixelRatio: 2,
};

function bounds(documentWidth: number, documentHeight: number, minZoom = 1): ViewBounds {
  return { minZoom, frame: FRAME, documentWidth, documentHeight };
}

describe('boundView', () => {
  test('returns the same view when it is already inside, so a move allocates nothing', () => {
    const view = { ...VIEW, zoom: 8, panX: 200, panY: 100 };
    expect(boundView(view, bounds(64, 64))).toBe(view);
    expect(boundView(view, bounds(64, 64), undefined, true)).toBe(view);
  });

  test('a tiny document stays wholly inside the frame', () => {
    const sprite = bounds(16, 16);
    expect(boundView({ ...VIEW, panX: -500, panY: -500 }, sprite)).toMatchObject({
      panX: 76,
      panY: 72,
    });
    expect(boundView({ ...VIEW, panX: 5000, panY: 5000 }, sprite)).toMatchObject({
      panX: 1440 - 76 - 16,
      panY: 900 - 56 - 16,
    });
  });

  test('a huge document keeps a quarter of the frame covered on each axis', () => {
    const huge = bounds(4096, 4096, 0.18);
    const view = { ...VIEW, zoom: 2 };
    const left = boundView({ ...view, panX: 99_999, panY: 99_999 }, huge);
    expect(left.panX).toBe(1440 - 76 - 1288 * MIN_OVERLAP);
    expect(left.panY).toBe(900 - 56 - 772 * MIN_OVERLAP);
    const right = boundView({ ...view, panX: -99_999, panY: -99_999 }, huge);
    // The document's far edge sits a quarter of the frame past the frame's near edge.
    expect(right.panX + 4096 * 2).toBe(76 + 1288 * MIN_OVERLAP);
    expect(right.panY + 4096 * 2).toBe(72 + 772 * MIN_OVERLAP);
  });

  test('limits round inward to whole pixels', () => {
    // A quarter of the 1288 px frame is a whole 322, so widen it to a fractional quarter.
    const odd = { ...VIEW, cssWidth: 1443 };
    const limit = boundView({ ...odd, panX: 99_999 }, bounds(4096, 4096, 0.1)).panX;
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit).toBe(Math.floor(1443 - 76 - (1443 - 152) / 4));
  });

  test('lifts a zoom below the floor around the anchor, then the pan bound wins', () => {
    const shot = bounds(1262, 1242, 0.55);
    const at = { x: 700, y: 400 };
    const view = { ...VIEW, zoom: 0.55, panX: 373, panY: 108 };
    const lifted = boundView({ ...view, zoom: 0.3 }, shot, at);
    expect(lifted.zoom).toBe(0.55);
    const near = boundView({ ...view, zoom: 0.4, panX: 1300 }, shot, { x: 1300, y: 400 });
    expect(near.zoom).toBe(0.55);
    // Lifting around the document's corner would push it past the frame, so the bound pulls it in.
    expect(near.panX).toBe(1440 - 76 - 1288 * MIN_OVERLAP);
  });

  test('the floor lift keeps the anchored document point under the anchor', () => {
    const shot = bounds(1262, 1242, 0.55);
    const at = { x: 720, y: 450 };
    const view = { ...VIEW, zoom: 0.4, panX: 400, panY: 200 };
    const before = screenToDocument(view, at);
    const after = screenToDocument(boundView(view, shot, at), at);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  test('elastic views stretch past a limit with resistance, and never reach a frame away', () => {
    const sprite = bounds(16, 16);
    const at = (panX: number) => boundView({ ...VIEW, panX }, sprite, undefined, true).panX;
    const limit = 1440 - 76 - 16;
    expect(at(limit + 100)).toBeGreaterThan(limit);
    expect(at(limit + 100)).toBeLessThan(limit + 100);
    expect(at(limit + 200) - limit).toBeGreaterThan(at(limit + 100) - limit);
    expect(at(limit + 100_000) - limit).toBeLessThan(1288);
    expect(at(76 - 100)).toBeLessThan(76);
    expect(at(76 - 100)).toBeGreaterThan(-24);
  });

  test('an elastic pinch below the floor gives way, but less than half again', () => {
    const shot = bounds(1262, 1242, 0.5);
    const view = { ...VIEW, panX: 400, panY: 200 };
    const zoom = (raw: number) =>
      boundView({ ...view, zoom: raw }, shot, { x: 700, y: 400 }, true).zoom;
    expect(zoom(0.45)).toBeLessThan(0.5);
    expect(zoom(0.45)).toBeGreaterThan(0.45);
    expect(zoom(0.3)).toBeLessThan(zoom(0.45));
    expect(zoom(1 / 32)).toBeGreaterThan(0.25);
  });
});

describe('rubberBand', () => {
  test('starts near half speed and approaches its dimension', () => {
    expect(rubberBand(0, 100)).toBe(0);
    expect(rubberBand(-5, 100)).toBe(0);
    expect(rubberBand(1, 1000)).toBeCloseTo(0.55, 2);
    expect(rubberBand(1000, 1000)).toBeCloseTo(1000 * (1 - 1 / 1.55), 6);
    expect(rubberBand(1e9, 1000)).toBeLessThan(1000);
  });
});

describe('snapZoomWithin', () => {
  test('snaps to the nearest step at or above the floor, or the floor itself', () => {
    expect(snapZoomWithin(7, 1)).toBe(8);
    expect(snapZoomWithin(0.75, 0.62)).toBe(0.62);
    expect(snapZoomWithin(0.9, 0.62)).toBe(1);
    expect(snapZoomWithin(0.3, 0.62)).toBe(0.62);
    expect(snapZoomWithin(0.4, 0.25)).toBe(0.5);
    expect(snapZoomWithin(128, 1)).toBe(128);
  });

  test('keeps a start zoom at or above the floor when it is nearest', () => {
    expect(snapZoomWithin(11, 1, 11)).toBe(11);
    expect(snapZoomWithin(11.4, 1, 11)).toBe(11);
    expect(snapZoomWithin(11.6, 1, 11)).toBe(12);
    expect(snapZoomWithin(0.5, 0.62, 0.5)).toBe(0.62);
  });
});

describe('settleView', () => {
  const PHONE: Viewport = {
    zoom: 1,
    panX: 0,
    panY: 0,
    cssWidth: 390,
    cssHeight: 844,
    devicePixelRatio: 3,
  };
  const PHONE_FRAME = { top: 72, right: 16, bottom: 148, left: 16 };
  const fit = fitViewport(PHONE, 32, 32, PHONE_FRAME);

  test('a pan at an off-ladder fit comes back to that fit, label and all', () => {
    expect(fit.zoom).toBe(11);
    const panned = { ...fit, panX: fit.panX + 40.4, panY: fit.panY - 12.6 };
    const end = settleView(panned, 1, { x: 195, y: 400 }, fit);
    expect(end).toMatchObject({ zoom: 11, fittedZoom: 11 });
    expect(end.panX).toBe(Math.round(panned.panX));
    expect(end.panY).toBe(Math.round(panned.panY));
  });

  test('a near-zero pinch returns to the start, and a real one moves on to the ladder', () => {
    const at = { x: 195, y: 400 };
    expect(settleView({ ...fit, zoom: 11.3 }, 1, at, fit)).toMatchObject({
      zoom: 11,
      fittedZoom: 11,
    });
    const onward = settleView({ ...fit, zoom: 15 }, 1, at, fit);
    expect(onward.zoom).toBe(16);
    expect(onward.fittedZoom).toBeUndefined();
  });

  test('a start that was not a fit returns without a fitted label', () => {
    const manual = { ...fit, fittedZoom: undefined };
    const end = settleView({ ...manual, zoom: 10.8 }, 1, { x: 195, y: 400 }, manual);
    expect(end.zoom).toBe(11);
    expect(end.fittedZoom).toBeUndefined();
  });

  test('without a start, or with one under the floor, it snaps to the ladder or the floor', () => {
    const at = { x: 195, y: 400 };
    expect(settleView({ ...fit, zoom: 11.2 }, 1, at).zoom).toBe(12);
    expect(settleView({ ...fit, zoom: 0.6 }, 0.62, at, { ...fit, zoom: 0.55 }).zoom).toBe(0.62);
  });

  test('a moving view that carries its start fit snaps to wherever that pinch will settle', () => {
    expect(startFit(fit)).toBe(11);
    expect(startFit({ ...fit, fittedZoom: undefined })).toBeUndefined();
    expect(startFit({ ...fit, zoom: 12 })).toBeUndefined();
    const at = { x: 195, y: 400 };
    for (let zoom = 6; zoom <= 20; zoom += 0.05) {
      const moving = { ...fit, zoom, fittedZoom: startFit(fit) };
      const label = snapZoomWithin(moving.zoom, 1, moving.fittedZoom);
      expect(settleView(moving, 1, at, fit).zoom).toBe(label);
    }
  });

  test('a fractional-DPR moving label matches the pinch settle through every nearby candidate', () => {
    const at = { x: 195, y: 400 };
    const start = { ...fit, devicePixelRatio: 1.75, zoom: 5 / 1.75, fittedZoom: 5 / 1.75 };
    const floor = 2 / 1.75;
    for (let zoom = 0.8; zoom <= 7.9; zoom += 0.03) {
      const moving = { ...start, zoom };
      const label = snapZoomWithin(zoom, floor, start.fittedZoom, start.devicePixelRatio);
      expect(settleView(moving, floor, at, start).zoom).toBe(label);
    }
  });
});
