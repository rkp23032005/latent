/**
 * Thumbnails that are the preset, not a picture of a preset.
 *
 * Each card is painted by the same CPU renderer the editor falls back to, from
 * the same stage list the preview uses, so what a card shows is what applying
 * the look does. Nothing is borrowed from a stock image: when the user has a
 * photograph on the stage, the cards are that photograph with the look pressed
 * onto it; when they do not, they are the sample photograph the library was
 * built against, and the interface says so.
 */

import { IDENTITY, toPipelineParams, type PipelineParams } from '../image/adjustments.ts';
import { createCpuPreview, type PreviewRenderer } from '../image/renderer.ts';
import type { Preset } from './schema.ts';

export const THUMB_ASPECT = 4 / 3;
/** Cards are small and numerous, so this is detail enough — and it keeps memory honest. */
const MAX_EDGE = 200;

/* Finished cards are kept so returning to a tab, or scrolling back to a row,
   costs one copy instead of sixteen milliseconds of grading per card. The cap
   is a memory ceiling, not a count of what is on screen: a 200 × 150 card is
   about 120 KB, so a full cache is under 9 MB. */
const PAINTED_LIMIT = 72;

const bitmaps = new Map<string, Promise<ImageBitmap>>();
const crops = new Map<string, ImageBitmap>();
const paramsById = new Map<string, PipelineParams>();
const painted = new Map<string, HTMLCanvasElement>();

type Sheet = {
  canvas: HTMLCanvasElement;
  engine: PreviewRenderer;
  source: ImageBitmap;
  url: string;
};
let sheet: Sheet | null = null;

function createSheet(source: ImageBitmap, url: string): Sheet {
  const canvas = document.createElement('canvas');
  const engine = createCpuPreview(canvas);
  engine.setSource(source);
  return { canvas, engine, source, url };
}

export function sourceBitmap(url: string): Promise<ImageBitmap> {
  const known = bitmaps.get(url);
  if (known) return known;
  const next = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`Could not read ${url}.`);
      return response.blob();
    })
    .then((blob) => createImageBitmap(blob));
  next.catch(() => bitmaps.delete(url));
  bitmaps.set(url, next);
  return next;
}

/** Centre-cropped to the card aspect, so nothing is stretched to fit. */
export async function coverSource(url: string, aspect = THUMB_ASPECT): Promise<ImageBitmap> {
  const key = `${url}|${aspect.toFixed(3)}`;
  const known = crops.get(key);
  if (known) return known;

  const source = await sourceBitmap(url);
  const wide = source.width / source.height > aspect;
  const sw = wide ? Math.round(source.height * aspect) : source.width;
  const sh = wide ? source.height : Math.round(source.width / aspect);
  const sx = Math.max(0, Math.round((source.width - sw) / 2));
  const sy = Math.max(0, Math.round((source.height - sh) / 2));
  const resizeWidth = Math.min(MAX_EDGE * 2, sw);
  const resizeHeight = Math.round((resizeWidth * sh) / sw);
  const bitmap = await createImageBitmap(source, sx, sy, sw, sh, {
    resizeWidth,
    resizeHeight,
    resizeQuality: 'high',
  });
  crops.set(key, bitmap);
  return bitmap;
}

function paramsFor(preset: Preset): PipelineParams {
  const known = paramsById.get(preset.id);
  if (known) return known;
  const next = toPipelineParams({ ...IDENTITY, ...preset.adjust });
  paramsById.set(preset.id, next);
  return next;
}

/** The pixels a card asks for, and the size-independent cache key for them. */
function thumbSize(canvas: HTMLCanvasElement): { key: string; width: number; height: number } | null {
  const box = canvas.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;

  /* The cap is on the pixels actually rendered, not the CSS box: a doubled
     screen would otherwise ask for four times the arithmetic per card, and a
     grade preview never needs that much detail. */
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(2, Math.round(Math.min(box.width * scale, MAX_EDGE)));
  const height = Math.max(2, Math.round(width / THUMB_ASPECT));
  return { key: `${width}x${height}`, width, height };
}

function copyInto(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  width: number,
  height: number,
): boolean {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0);
  return true;
}

function remember(key: string, width: number, height: number): void {
  if (painted.has(key)) return;
  const copy = document.createElement('canvas');
  if (!copyInto(copy, sheet!.canvas, width, height)) return;
  painted.set(key, copy);
  if (painted.size > PAINTED_LIMIT) {
    const oldest = painted.keys().next().value;
    if (oldest !== undefined) painted.delete(oldest);
  }
}

/**
 * Paints one card, or copies a card already painted for this photograph, look
 * and pixel size. `unmeasurable` means the card has no box yet, which tells the
 * caller to try again when it scrolls into view.
 *
 * One renderer serves the whole grid. The dear part of a thumbnail is not the
 * grade — it is resampling the photograph into the card box, and every card in a
 * row is the same box with the same photograph. So the grade is computed into a
 * shared sheet and the card copies the finished pixels.
 */
function paintThumb(
  canvas: HTMLCanvasElement,
  source: ImageBitmap,
  preset: Preset,
  sourceUrl: string,
): 'graded' | 'cached' | 'unmeasurable' {
  const size = thumbSize(canvas);
  if (!size) return 'unmeasurable';
  const key = `${sourceUrl}\u0000${preset.id}\u0000${size.key}`;

  const known = painted.get(key);
  if (known) {
    /* Refresh insertion order: the least recently seen card is the one to lose
       its pixels when the cap is reached. */
    painted.delete(key);
    painted.set(key, known);
    return copyInto(canvas, known, size.width, size.height) ? 'cached' : 'unmeasurable';
  }

  if (!sheet || sheet.source !== source) sheet = createSheet(source, sourceUrl);
  sheet.engine.resize(size.width, size.height);
  sheet.engine.draw(paramsFor(preset));
  if (!copyInto(canvas, sheet.canvas, size.width, size.height)) return 'unmeasurable';
  remember(key, size.width, size.height);
  return 'graded';
}

/**
 * A card is roughly sixteen milliseconds of pixel work, so a whole grid of them
 * asked for in the same breath is a third of a second with the page frozen.
 * Graded cards are taken one per frame instead. Cached cards are copies and are
 * taken in a batch, so a tab the user has already seen fills in at once.
 */
type Job = {
  canvas: HTMLCanvasElement;
  source: ImageBitmap;
  preset: Preset;
  sourceUrl: string;
  done: (painted: boolean) => void;
};

const BATCH = 8;
const queue: Job[] = [];
let ticking = false;

function step() {
  ticking = false;
  let handled = 0;
  while (queue.length > 0 && handled < BATCH) {
    const job = queue.shift()!;
    /* A card unmounted between here and now keeps its canvas out of the page, so
       its look was already cancelled and nobody is waiting on the pixels. */
    if (!job.canvas.isConnected) {
      handled += 1;
      continue;
    }
    const result = paintThumb(job.canvas, job.source, job.preset, job.sourceUrl);
    job.done(result !== 'unmeasurable');
    handled += 1;
    if (result === 'graded') break;
  }
  if (queue.length && !ticking) {
    ticking = true;
    requestAnimationFrame(step);
  }
}

export function queueThumb(
  canvas: HTMLCanvasElement,
  source: ImageBitmap,
  preset: Preset,
  sourceUrl: string,
  done: (painted: boolean) => void,
): void {
  queue.push({ canvas, source, preset, sourceUrl, done });
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(step);
  }
}

/**
 * A blob url stops working the moment another photograph arrives, and the
 * decoded pixels behind it should go with it rather than sit in the cache.
 */
export function releaseSource(url: string): void {
  const crop = crops.get(`${url}|${THUMB_ASPECT.toFixed(3)}`);
  if (crop) {
    crop.close();
    crops.delete(`${url}|${THUMB_ASPECT.toFixed(3)}`);
  }
  const source = bitmaps.get(url);
  if (source) {
    bitmaps.delete(url);
    source.then((bitmap) => bitmap.close()).catch(() => undefined);
  }
  for (const key of painted.keys()) {
    if (key.startsWith(`${url}\u0000`)) painted.delete(key);
  }
  /* The shared sheet belongs to one photograph; once that photograph is gone,
     so is the reason to keep its renderer and its copy of the pixels. */
  if (sheet && sheet.url === url) {
    sheet.engine.destroy();
    sheet = null;
  }
}
