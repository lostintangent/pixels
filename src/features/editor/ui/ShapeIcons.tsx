import { createLucideIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ShapeKind } from '../core/tools';

// Each icon draws its shape the way the canvas does: a square-cornered outline, and a straight
// shaft ending in a filled head. Built on lucide's base so they match the other rail icons.
export const SHAPE_ICONS: Record<ShapeKind, LucideIcon> = {
  rectangle: createLucideIcon('shape-rectangle', [
    ['rect', { x: '4', y: '5', width: '16', height: '14', strokeLinejoin: 'miter', key: 'r' }],
  ]),
  arrow: createLucideIcon('shape-arrow', [
    ['path', { d: 'M5 19 15.5 8.5', key: 's' }],
    ['path', { d: 'M19 5 18.2 13.1 10.9 5.8Z', fill: 'currentColor', strokeWidth: 1.2, key: 'h' }],
  ]),
};
