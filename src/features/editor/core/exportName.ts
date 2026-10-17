/**
 * The PNG file name for what the artist typed, or null when nothing is left to name it.
 * A typed extension is kept as one, so `hero.png` stays `hero.png` rather than `hero.png.png`.
 */
export function exportFileName(typed: string): string | null {
  const stem = typed
    .trim()
    .replace(/\.png$/i, '')
    .trim();
  return stem ? `${stem}.png` : null;
}
