import { createContext } from 'react';
import type { DocumentColorSpace } from '../../document';

/** The open document's color space, so every swatch renders the same bytes the canvas paints. */
export const PaletteColorSpace = createContext<DocumentColorSpace>('srgb');
