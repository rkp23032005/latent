/**
 * One measurement per photograph, shared by the panels that need it.
 *
 * The measurement itself lives in `imageAnalysis.ts` and is deterministic: the
 * same file gives the same numbers. Decoding a full-size photograph into a 64×64
 * sample is the expensive part, so the promise is cached by the url the stage is
 * already holding, and a second panel asking for the same photograph waits on
 * the same work rather than starting it again.
 *
 * The explicit "measure this photograph again" actions in the AI panel do not
 * use this cache — the user pressed the button to get a fresh reading, and that
 * is what they get.
 */

import { useEffect, useState } from 'react';
import type { Photo } from '../photoStore';
import { analysePhoto, type ImageAnalysis } from './imageAnalysis';

const KEEP = 8;
const cache = new Map<string, Promise<ImageAnalysis>>();

/** The measurement for this photograph, or the in-flight attempt to get it. */
export function analysePhotoOnce(photo: Photo): Promise<ImageAnalysis> {
  const known = cache.get(photo.url);
  if (known) return known;
  const attempt = analysePhoto(photo).catch((error: unknown) => {
    // A failure is not a fact about the photograph; forget it and let it be retried.
    cache.delete(photo.url);
    throw error;
  });
  cache.set(photo.url, attempt);
  if (cache.size > KEEP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined && oldest !== photo.url) cache.delete(oldest);
  }
  return attempt;
}

/** The measurement as a value, updating when a different photograph arrives. */
export function useImageAnalysis(photo: Photo | null): ImageAnalysis | null {
  const [analysis, setAnalysis] = useState<ImageAnalysis | null>(null);
  const url = photo?.url ?? null;

  useEffect(() => {
    if (!photo) {
      setAnalysis(null);
      return;
    }
    let alive = true;
    analysePhotoOnce(photo).then(
      (next) => {
        if (alive) setAnalysis(next);
      },
      () => {
        if (alive) setAnalysis(null);
      },
    );
    return () => {
      alive = false;
    };
    // A new file is a new measurement; the url is the whole identity of the input.
  }, [photo, url]);

  return analysis;
}
