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

/** The exported image's size, as Export's footer and its progress toast both show it. */
export function exportSizeLabel(width: number, height: number, scale: number): string {
  return `${width * scale} × ${height * scale} px`;
}
