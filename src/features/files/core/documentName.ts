/** Long enough for a descriptive title, short enough to stay readable in the title pill and Recent. */
export const DOCUMENT_NAME_MAX_LENGTH = 80;

/** Splits on user-perceived characters, not code points: a flag (a pair of regional-indicator
 *  code points) or a ZWJ sequence like a family emoji is one grapheme cluster, so capping by
 *  grapheme never leaves a lone flag letter or a dangling ZWJ behind. */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The name a rename should store, or null when it should keep the old one. Line breaks and other
 * control characters from a paste become spaces, runs of space collapse, the ends are trimmed,
 * and the length is capped in whole grapheme clusters so an emoji is never split.
 */
export function normalizeDocumentName(input: string): string | null {
  const collapsed = input
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const clusters = Array.from(graphemes.segment(collapsed), (s) => s.segment);
  const name = clusters.slice(0, DOCUMENT_NAME_MAX_LENGTH).join('').trimEnd();
  return name || null;
}
