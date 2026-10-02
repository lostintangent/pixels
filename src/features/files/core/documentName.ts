/** Long enough for a descriptive title, short enough to stay readable in the title pill and Recent. */
export const DOCUMENT_NAME_MAX_LENGTH = 80;

/**
 * The name a rename should store, or null when it should keep the old one. Line breaks and other
 * control characters from a paste become spaces, runs of space collapse, the ends are trimmed,
 * and the length is capped in characters so an emoji is never split.
 */
export function normalizeDocumentName(input: string): string | null {
  const collapsed = input
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = Array.from(collapsed).slice(0, DOCUMENT_NAME_MAX_LENGTH).join('').trimEnd();
  return name || null;
}
