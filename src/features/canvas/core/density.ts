interface ResolutionQuery {
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

interface PixelDensitySource {
  readonly devicePixelRatio: number;
  matchMedia(query: string): ResolutionQuery;
}

/** A resolution query stops matching when a window moves to a display with another DPR. */
export function watchPixelDensity(source: PixelDensitySource, changed: () => void): () => void {
  let query: ResolutionQuery;
  const onChange = () => {
    query.removeEventListener('change', onChange);
    // Re-arm at the new density so a move back to the original display is seen too.
    query = source.matchMedia(`(resolution: ${source.devicePixelRatio || 1}dppx)`);
    query.addEventListener('change', onChange);
    changed();
  };
  query = source.matchMedia(`(resolution: ${source.devicePixelRatio || 1}dppx)`);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
