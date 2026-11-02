/**
 * The original image, kept as a separate representation from the preview.
 *
 * A photograph is decoded once per file, into raw pixels the renderers read
 * from on every frame. Nothing writes back into it, so an edit is always a
 * function of (original, parameters) rather than of whatever was last drawn.
 */

import { PhotoError, type Photo } from '../photoStore';

export type Original = {
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  /** True when these are a reduction of the file rather than all of it. */
  readonly reduced: boolean;
};

/* A preview never needs more pixels than it can put on screen, and decoding a
   100-megapixel file into RAM to draw it at 1200 pixels wide is its own kind
   of bug. The full file stays on disk for the export renderer. */
const MAX_SOURCE_PIXELS = 4_000_000;

export async function decodeOriginal(photo: Photo): Promise<Original> {
  const declared = photo.width * photo.height;
  const reduced = declared > MAX_SOURCE_PIXELS;
  const scale = reduced ? Math.sqrt(MAX_SOURCE_PIXELS / declared) : 1;

  const options: ImageBitmapOptions = { premultiplyAlpha: 'none' };
  if (reduced) {
    options.resizeWidth = Math.max(1, Math.round(photo.width * scale));
    options.resizeHeight = Math.max(1, Math.round(photo.height * scale));
    options.resizeQuality = 'high';
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(photo.file, options);
  } catch {
    /* Not every engine honours the resize options. A large photograph is worth
       a second attempt at full size rather than a dead preview; the renderer
       still only draws it at screen resolution. */
    if (reduced) {
      try {
        bitmap = await createImageBitmap(photo.file);
      } catch {
        throw new PhotoError(
          'undecodable',
          `${photo.name} could not be prepared for editing. The file on your device is unchanged.`,
        );
      }
    } else {
      throw new PhotoError(
        'undecodable',
        `${photo.name} could not be prepared for editing. The file on your device is unchanged.`,
      );
    }
  }

  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    reduced,
  };
}
