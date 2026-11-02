/**
 * Writing the edit out.
 *
 * The preview works from a reduced decode; an export must not. This path
 * decodes the file the user chose at its own size (up to a sane ceiling),
 * runs the same sixteen-knob pipeline over it, and encodes the result. So the
 * exported picture is the current recipe applied to the original, not a
 * screenshot of the stage scaled back up.
 */

import type { Photo } from '../photoStore';
import { toPipelineParams, type Adjustments } from './adjustments';
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

/** What the export will be, stated before any work starts. */
export function exportSize(photo: Photo): ExportSize {
  return fit(photo.width, photo.height, MAX_EDGE, MAX_PIXELS);
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

async function decode(photo: Photo, size: ExportSize): Promise<ImageBitmap> {
  const options: ImageBitmapOptions = { premultiplyAlpha: 'none' };
  if (size.reduced) {
    options.resizeWidth = size.width;
    options.resizeHeight = size.height;
    options.resizeQuality = 'high';
  }
  try {
    return await createImageBitmap(photo.file, options);
  } catch {
    throw new ExportError(
      `${photo.name} could not be decoded again for export. The file on your device is unchanged.`,
    );
  }
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
 */
export async function renderExport(
  photo: Photo,
  values: Adjustments,
  request: ExportRequest,
  onPhase?: (phase: ExportPhase) => void,
): Promise<ExportResult> {
  onPhase?.('preparing');

  const canvas = document.createElement('canvas');
  let renderer: PreviewRenderer;
  try {
    renderer = createRenderer(canvas);
  } catch {
    renderer = createCpuPreview(canvas);
  }

  const size =
    renderer.mode === 'webgl'
      ? exportSize(photo)
      : fit(photo.width, photo.height, CPU_MAX_EDGE, CPU_MAX_PIXELS);

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await decode(photo, size);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    renderer.setSource(bitmap);
    renderer.resize(bitmap.width, bitmap.height);

    onPhase?.('rendering');
    await breathe();
    renderer.draw(toPipelineParams(values), NO_SPLIT);

    onPhase?.('encoding');
    const blob = await encode(canvas, request.format, request.quality);

    return {
      blob,
      name: exportName(photo, request.format),
      width: bitmap.width,
      height: bitmap.height,
      sourceWidth: photo.width,
      sourceHeight: photo.height,
      reduced: size.reduced,
      mode: renderer.mode,
    };
  } catch (error) {
    if (error instanceof ExportError) throw error;
    const message = error instanceof Error ? error.message : '';
    throw new ExportError(
      message || 'The export stopped before any bytes were written. The photograph on your device is unchanged.',
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
