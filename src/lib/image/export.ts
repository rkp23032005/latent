/**
 * Writing the edit out.
 *
 * The preview works from a reduced decode; an export must not. This path
 * decodes the file the user chose at its own size (up to a sane ceiling),
 * runs the same sixteen-knob pipeline over it, and encodes the result. So the
 * exported picture is the current recipe applied to the original, not a
 * screenshot of the stage scaled back up.
 *
 * A frame the user chose is part of the same statement: it is resolved against
 * the file, not against the preview, so the export contains exactly the window
 * the stage showed. It is read out of the decode rather than cut out of a
 * finished picture, which is why cropping costs no resolution — the ceilings
 * apply to what is kept, not to what was thrown away.
 */

import type { Photo } from '../photoStore';
import { toPipelineParams, type Adjustments } from './adjustments';
import { clampCrop, cropPixelRect, type CropRect } from './crop';
import {
  NO_SPLIT,
  createCpuPreview,
  createRenderer,
  type PreviewRenderer,
  type RenderMode,
} from './renderer';

export type ExportFormat = 'jpeg' | 'png';

export type ExportRequest = {
  format: ExportFormat;
  /** Encoder quality, 0–1. Ignored for PNG, which is lossless. */
  quality: number;
};

export type ExportPhase = 'preparing' | 'rendering' | 'encoding';

export type ExportSize = {
  width: number;
  height: number;
  /** True when the file is larger than the renderer will attempt in one pass. */
  reduced: boolean;
};

export type ExportResult = {
  blob: Blob;
  name: string;
  width: number;
  height: number;
  /** What the file on disk actually holds, before any ceiling was applied. */
  sourceWidth: number;
  sourceHeight: number;
  reduced: boolean;
  /** The frame that was written, or null when the whole photograph was. */
  crop: CropRect | null;
  mode: RenderMode;
};

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/* A single pass has to hold the decoded file, the resized source and the
   framebuffer at once. These ceilings keep that under control while still
   covering an ordinary camera file at its own size. */
const MAX_EDGE = 8192;
const MAX_PIXELS = 24_000_000;

/* The software pipeline keeps several copies of the pixels in JavaScript
   memory, so it is asked for less. Only reached when WebGL is unavailable. */
const CPU_MAX_EDGE = 4096;
const CPU_MAX_PIXELS = 8_000_000;

function fit(
  width: number,
  height: number,
  maxEdge: number,
  maxPixels: number,
): ExportSize {
  const scale = Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  if (scale >= 1) return { width, height, reduced: false };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    reduced: true,
  };
}

/**
 * What the export will be, stated before any work starts.
 *
 * The ceilings are measured over the window that is being kept, not over the
 * whole file: a photograph framed down to a quarter of its area has four times
 * as much room under the limit, and exports at the file's own resolution.
 */
export function exportSize(photo: Photo, crop: CropRect | null = null): ExportSize {
  const kept = cropPixelRect(crop, photo.width, photo.height);
  return fit(kept.width, kept.height, MAX_EDGE, MAX_PIXELS);
}

export function exportName(photo: Photo, format: ExportFormat): string {
  const base = photo.name.replace(/\.[^.]+$/, '').trim() || 'latent';
  return `${base}-latent.${format === 'jpeg' ? 'jpg' : 'png'}`;
}

function mimeFor(format: ExportFormat): string {
  return format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 0.9;
  return Math.min(1, Math.max(0.1, quality));
}

/**
 * The window that will be written, decoded at the size it will be written at.
 *
 * Cropping at decode rather than at draw is what keeps the pixels honest: the
 * file is sampled once, inside the frame the user chose, at the resolution the
 * ceilings allow. Two engines get in the way of that — one will not resize a
 * sub-rectangle, the other will not take a sub-rectangle at all — so there are
 * three attempts, and the last hands the frame to the renderer instead, which is
 * the same picture from a source that was resampled once more.
 *
 * @returns the pixels, and the frame still to be cut out of them (null when the
 * bitmap already is the window).
 */
async function decode(
  photo: Photo,
  crop: CropRect | null,
  windowSize: ExportSize,
  fullSize: ExportSize,
): Promise<{ bitmap: ImageBitmap; crop: CropRect | null }> {
  const rect = cropPixelRect(crop, photo.width, photo.height);
  const framed = rect.width !== photo.width || rect.height !== photo.height;
  const resize = (size: ExportSize): ImageBitmapOptions => ({
    premultiplyAlpha: 'none',
    ...(size.reduced
      ? { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' as const }
      : null),
  });

  const attempts: (() => Promise<ImageBitmap>)[] = framed
    ? [
        () => createImageBitmap(photo.file, rect.x, rect.y, rect.width, rect.height, resize(windowSize)),
        () =>
          createImageBitmap(photo.file, rect.x, rect.y, rect.width, rect.height, {
            premultiplyAlpha: 'none',
          }),
        () => createImageBitmap(photo.file, resize(fullSize)),
      ]
    : [() => createImageBitmap(photo.file, resize(windowSize))];

  let lastError: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const bitmap = await attempts[i]();
      /* Only the third attempt returns the whole file, so only it needs the
         frame cut out downstream. */
      return { bitmap, crop: i === 2 ? crop : null };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof ExportError) throw lastError;
  throw new ExportError(
    `${photo.name} could not be decoded again for export. The file on your device is unchanged.`,
  );
}

function encode(canvas: HTMLCanvasElement, format: ExportFormat, quality: number): Promise<Blob> {
  const type = mimeFor(format);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(
            new ExportError(
              'The browser could not encode the finished image. Nothing was written. Try the other format, or export a smaller file.',
            ),
          );
          return;
        }
        if (blob.type !== type) {
          reject(
            new ExportError(
              `The browser encoded ${blob.type || 'an unknown type'} instead of ${type}. Nothing was written.`,
            ),
          );
          return;
        }
        resolve(blob);
      },
      type,
      format === 'jpeg' ? clampQuality(quality) : undefined,
    );
  });
}

/** Let React paint the phase line before a long synchronous draw takes the thread. */
function breathe(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 40));
}

/**
 * Render and encode. Resolves only when bytes exist; every other outcome is a
 * rejection whose message can be shown to the user as it stands.
 *
 * `options.skinGuard` is the session's protection level, in the same 0–100 units
 * the panel shows. The exported file is drawn by the same renderer as the stage,
 * so a guard that is on here is on there — and a guard that is off is off.
 * `options.crop` is the session's frame, in fractions of the file; what is
 * written is that window and nothing outside it.
 */
export async function renderExport(
  photo: Photo,
  values: Adjustments,
  request: ExportRequest,
  onPhase?: (phase: ExportPhase) => void,
  options: { skinGuard?: number; crop?: CropRect | null } = {},
): Promise<ExportResult> {
  const skinGuard = options.skinGuard ?? 0;
  const crop = clampCrop(options.crop ?? null);
  onPhase?.('preparing');

  const canvas = document.createElement('canvas');
  let renderer: PreviewRenderer;
  try {
    renderer = createRenderer(canvas);
  } catch {
    renderer = createCpuPreview(canvas);
  }

  const limits =
    renderer.mode === 'webgl'
      ? { edge: MAX_EDGE, pixels: MAX_PIXELS }
      : { edge: CPU_MAX_EDGE, pixels: CPU_MAX_PIXELS };
  const kept = cropPixelRect(crop, photo.width, photo.height);
  const windowSize = fit(kept.width, kept.height, limits.edge, limits.pixels);
  const fullSize = fit(photo.width, photo.height, limits.edge, limits.pixels);

  let bitmap: ImageBitmap | null = null;
  try {
    const decoded = await decode(photo, crop, windowSize, fullSize);
    bitmap = decoded.bitmap;
    /* The frame inside the pixels we were given, then the ceilings over it. A
       decode that could not take a sub-rectangle returns the whole file and the
       frame travels with it, to the renderer. */
    const inside = cropPixelRect(decoded.crop, bitmap.width, bitmap.height);
    const out = fit(inside.width, inside.height, limits.edge, limits.pixels);

    renderer.setSource(bitmap);
    renderer.setCrop(decoded.crop);
    /* `resize` owns the backing store and the sized source together. Setting the
       canvas to the output size first would make its size check pass and leave
       the source at the element's default 300×150 — an export of a blur. */
    renderer.resize(out.width, out.height);

    onPhase?.('rendering');
    await breathe();
    renderer.draw(toPipelineParams(values, skinGuard), NO_SPLIT);

    onPhase?.('encoding');
    const blob = await encode(canvas, request.format, request.quality);

    return {
      blob,
      name: exportName(photo, request.format),
      width: out.width,
      height: out.height,
      sourceWidth: photo.width,
      sourceHeight: photo.height,
      reduced: out.reduced,
      crop,
      mode: renderer.mode,
    };
  } catch (error) {
    if (error instanceof ExportError) throw error;
    const message = error instanceof Error ? error.message : '';
    throw new ExportError(
      message ||
        'The export stopped before any bytes were written. The photograph on your device is unchanged.',
    );
  } finally {
    bitmap?.close();
    renderer.destroy();
    /* Drop the backing stores promptly: a full-size canvas is the largest
       thing this tab holds. */
    canvas.width = 1;
    canvas.height = 1;
  }
}

/** The one place a file leaves the tab: a download the user asked for. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
