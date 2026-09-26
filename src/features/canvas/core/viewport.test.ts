import { expect, test } from 'bun:test';
import {
  clampZoom,
  documentToScreen,
  fitViewport,
  screenToDocument,
  settleZoom,
  stepZoom,
  zoomAt,
  zoomToStep,
} from './viewport';
import type { Viewport } from './contracts';

const viewport: Viewport = {
  zoom: 8,
  panX: 20,
  panY: -12,
  cssWidth: 800,
  cssHeight: 600,
  devicePixelRatio: 2,
};

test('screen and document transforms are exact inverses', () => {
  const point = { x: 17.5, y: 21.25 };
  expect(screenToDocument(viewport, documentToScreen(viewport, point))).toEqual(point);
});

test('zoom keeps the screen anchor fixed and clamps to supported range', () => {
  const anchor = { x: 214, y: 132 };
  const before = screenToDocument(viewport, anchor);
  const changed = zoomAt(viewport, 16, anchor);
  expect(changed.zoom).toBe(16);
  expect(screenToDocument(changed, anchor)).toEqual(before);
  expect(clampZoom(1000)).toBe(128);
  expect(clampZoom(0)).toBe(1 / 32);
});

test('fit centers a document within the padded viewport', () => {
  const fitted = fitViewport(viewport, 100, 50, 20);
  expect(fitted.zoom).toBe(6);
  expect(fitted.panX).toBe(100);
  expect(fitted.panY).toBe(150);
});

test('fit picks the largest power-of-two downscale that fits a large document', () => {
  const phone = { ...viewport, cssWidth: 390, cssHeight: 844 };
  const fitted = fitViewport(phone, 4096, 4096);
  expect(fitted.zoom).toBe(1 / 16);
  expect(fitted.panX).toBe(67);
});

test('asymmetric insets center the art in the actual free region', () => {
  const fitted = fitViewport(viewport, 100, 50, { top: 72, right: 76, bottom: 272, left: 56 });
  expect(fitted.zoom).toBe(4);
  expect(fitted.panX).toBe(190);
  expect(fitted.panY).toBe(100);
});

test('step zoom shares the same integer and power-of-two ladder', () => {
  const anchor = { x: 100, y: 120 };
  const one = zoomToStep(viewport, 1, anchor);
  expect(stepZoom(one, -1, anchor).zoom).toBe(1 / 2);
  expect(stepZoom(stepZoom(one, -1, anchor), -1, anchor).zoom).toBe(1 / 4);
  expect(stepZoom(one, 1, anchor).zoom).toBe(2);
  const pinched = zoomAt(one, 7.2, anchor);
  expect(pinched.zoom).toBe(7.2);
  expect(settleZoom(pinched, anchor).zoom).toBe(8);
});
