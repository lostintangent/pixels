import { describe, expect, test } from 'bun:test';
import { exportFileName, exportSizeLabel } from './exportName';

describe('exportFileName', () => {
  test('keeps the document name as shown', () => {
    expect(exportFileName('Untitled')).toBe('Untitled.png');
    expect(exportFileName('Screenshot 2026-10-17 at 8.00.00 AM')).toBe(
      'Screenshot 2026-10-17 at 8.00.00 AM.png',
    );
  });

  test('a typed extension is not doubled', () => {
    expect(exportFileName('hero.png')).toBe('hero.png');
    expect(exportFileName('hero.PNG')).toBe('hero.png');
    expect(exportFileName('  hero .png  ')).toBe('hero.png');
    expect(exportFileName('hero.png.png')).toBe('hero.png.png');
  });

  test('other dots stay part of the name', () => {
    expect(exportFileName('sprite.v2')).toBe('sprite.v2.png');
    expect(exportFileName('hero.jpg')).toBe('hero.jpg.png');
  });

  test('nothing left to name is no name', () => {
    expect(exportFileName('')).toBeNull();
    expect(exportFileName('   ')).toBeNull();
    expect(exportFileName('.png')).toBeNull();
    expect(exportFileName(' .PNG ')).toBeNull();
  });
});

describe('exportSizeLabel', () => {
  test('names the output size', () => {
    expect(exportSizeLabel(1024, 1024, 16)).toBe('16384 × 16384 px');
    expect(exportSizeLabel(64, 32, 1)).toBe('64 × 32 px');
  });
});
