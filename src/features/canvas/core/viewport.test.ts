import { expect, test } from 'bun:test';
import {
  clampZoom,
  documentToScreen,
  fitViewport,
  fitZoom,
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
  expect(fitted.zoom).toBe(7);
  expect(fitted.panX).toBe(50);
  expect(fitted.panY).toBe(125);
});

test('fit uses the largest whole-pixel zoom for small sprites', () => {
  const phone = { ...viewport, cssWidth: 390, cssHeight: 844 };
  const phoneFrame = { top: 72, right: 16, bottom: 148, left: 16 };
  const fitted = fitViewport(phone, 16, 16, phoneFrame);
  expect(fitted.zoom).toBe(22);
  expect(fitted.fittedZoom).toBe(22);
  expect(zoomAt(fitted, 21.8, { x: 100, y: 100 }).fittedZoom).toBeUndefined();
  expect(fitViewport(phone, 32, 32, phoneFrame).zoom).toBe(11);
  const desktopFrame = { top: 72, right: 76, bottom: 56, left: 76 };
  expect(
    fitViewport({ ...viewport, cssWidth: 1440, cssHeight: 900 }, 16, 16, desktopFrame).zoom,
  ).toBe(48);
});

test('fit keeps the largest whole percentage that fits a large document', () => {
  const phone = { ...viewport, cssWidth: 390, cssHeight: 844 };
  const fitted = fitViewport(phone, 4096, 4096);
  expect(fitted.zoom).toBe(0.09);
  expect(fitted.fittedZoom).toBe(0.09);
  expect(fitted.panX).toBeCloseTo(10.68, 6);
  // A 1990 px Retina screenshot: 55% on desktop and 17% on phone, not 50% and 12.5%.
  const desktop = { ...viewport, cssWidth: 1440, cssHeight: 900 };
  const desktopFrame = { top: 72, right: 272, bottom: 56, left: 76 };
  expect(fitViewport(desktop, 1990, 1192, desktopFrame).zoom).toBe(0.54);
  const phoneFrame = { top: 72, right: 16, bottom: 148, left: 16 };
  expect(fitViewport(phone, 1990, 1192, phoneFrame).zoom).toBe(0.17);
  expect(fitViewport(phone, 1 << 20, 1 << 20).zoom).toBe(1 / 32);
});

test('fit zoom is whole above 1× and a whole percentage below', () => {
  expect(fitZoom(7.99)).toBe(7);
  expect(fitZoom(1)).toBe(1);
  expect(fitZoom(0.999)).toBe(0.99);
  expect(fitZoom(0.55)).toBe(0.55);
  expect(fitZoom(0.01)).toBe(1 / 32);
});

test('asymmetric insets center the art in the actual free region', () => {
  const fitted = fitViewport(viewport, 100, 50, { top: 72, right: 76, bottom: 272, left: 56 });
  expect(fitted.zoom).toBe(5);
  expect(fitted.panX).toBe(140);
  expect(fitted.panY).toBe(75);
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

test('off-ladder zoom steps to the next step in either direction', () => {
  const anchor = { x: 100, y: 120 };
  const fitted = { ...viewport, zoom: 22 };
  const before = screenToDocument(fitted, anchor);
  expect(stepZoom(fitted, 1, anchor).zoom).toBe(24);
  expect(stepZoom(fitted, -1, anchor).zoom).toBe(16);
  expect(screenToDocument(stepZoom(fitted, 1, anchor), anchor)).toEqual(before);
  expect(stepZoom({ ...viewport, zoom: 7.2 }, 1, anchor).zoom).toBe(8);
  expect(stepZoom({ ...viewport, zoom: 7.2 }, -1, anchor).zoom).toBe(6);
});
