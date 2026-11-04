/**
 * Where the detail in this particular photograph is.
 *
 * The geometry lives in `crop.ts` and is pure; this is the one step that needs
 * the browser: decode the file small, keep its aspect, read the pixels back and
 * hand them to `detailMapFromRgba`. The result is a grid of local-contrast
 * values the framing fits are slid over.
 *
 * ## Why the sample is 128 on the long edge
 *
 * The measurement is a *where*, not a *what*: it only has to say which part of
 * the frame carries the edges. A sliding search over 128 × 128 positions costs a
 * few milliseconds with a prefix-sum table, and a smaller grid (64) puts the
 * window in a 1.5 %-of-the-frame steps, which is visible as a jump when a fit
 * is applied. Larger samples cost decode time and change the answer only in the
 * noise: downsampling itself removes edges, which is the one thing this measure
 * is sensitive to.
 *
 * ## What is measured, and on which pixels
 *
 * The untouched file. Not the preview, not the current recipe: a vignette the
 * user has dialled in would lower the measured detail in the corners and pull
 * the suggested frame away from them, which is the edit talking to the framing
 * rather than the framing reading the photograph. So a frame suggested for a
 * file is suggested for the file.
 *
 * The limits are the ones the method has. This is edge energy, so it follows
 * texture and noise as gladly as subjects: a shingle roof, a picket fence, a
 * band of grain in a dusk sky or a dense foreground will out-pull a face lit
 * softly against a wall. A photograph whose interest is tonal — fog, a plain
 * backdrop, one lit plane of skin — has almost no energy to follow and lands
 * near the centre, which is the honest default rather than a failure. Nothing
 * here knows what a person is; see `lib/ai/segmentation.ts` for why that half of
 * the idea is not available in this editor.
 */

import { useEffect, useState } from 'react';
import type { Photo } from '../photoStore';
import { detailMapFromRgba, type DetailMap } from './crop';

/** Long edge of the grid the fits are slid over. */
export const MAX_SAMPLE_EDGE = 128;

/**
 * The measurement for one file: an aspect-keeping decode, then the local
 * contrast of what came back. Rejects if the browser will not decode or will not
 * hand back pixels; the caller treats that as "no fit to follow".
 */
export async function measureDetail(photo: Photo): Promise<DetailMap> {
  const scale = Math.min(1, MAX_SAMPLE_EDGE / Math.max(photo.width, photo.height));
  const width = Math.max(1, Math.round(photo.width * scale));
  const height = Math.max(1, Math.round(photo.height * scale));

  const bitmap = await createImageBitmap(photo.file, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'low',
    premultiplyAlpha: 'none',
  });

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error('This browser will not hand back the pixels a framing fit is measured from.');
  }

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return detailMapFromRgba(data, canvas.width, canvas.height);
}

const KEEP = 8;
const cache = new Map<string, Promise<DetailMap>>();

/** Shared by every panel that wants the same answer for the same file. */
export function measureDetailOnce(photo: Photo): Promise<DetailMap> {
  const known = cache.get(photo.url);
  if (known) return known;
  const attempt = measureDetail(photo).catch((error: unknown) => {
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

/**
 * The grid, or null while it is being measured and null if it could not be.
 * A null map is not an error state in the interface: the shapes are still
 * offered, they are just centred instead of measured, and the copy says so.
 */
export function useDetailMap(photo: Photo | null): DetailMap | null {
  const [map, setMap] = useState<DetailMap | null>(null);
  const url = photo?.url ?? null;

  useEffect(() => {
    if (!photo) {
      setMap(null);
      return;
    }
    let alive = true;
    measureDetailOnce(photo).then(
      (next) => {
        if (alive) setMap(next);
      },
      () => {
        if (alive) setMap(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [photo, url]);

  return map;
}
