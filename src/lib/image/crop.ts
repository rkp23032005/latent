/**
 * Where the picture is cut, in units of the photograph itself.
 *
 * ## What a crop is here
 *
 * A `CropRect` is four numbers between 0 and 1 — the window's left, top, width
 * and height as fractions of the file. It is not an edit to the pixels: the
 * renderer is handed the original and this window, and draws only what falls
 * inside it. So the frame composes with everything else the way the sixteen
 * knobs do, as a function of (original, parameters), and Undo steps back from it
 * the same way. The file on the user's device is never touched, and a frame can
 * always be widened back to the whole photograph.
 *
 * ## Why it lives outside the pipeline
 *
 * `pipeline.ts` decides what a pixel becomes. A crop decides which pixels are
 * shown at all, before any stage runs, so it never enters the shader, the LUT
 * fold or `PARAM_UNIFORMS`. Both renderers apply it at the one place the sized
 * source is drawn (`createSizedSource`), which is why the stage and an export
 * cut exactly the same rectangle. The one asymmetry worth knowing: the export
 * decodes the whole file first and then draws the window, so on a file large
 * enough to be reduced for export, a crop resamples pixels that were already
 * resampled once. Under the ceilings — which covers an ordinary camera file —
 * there is no reduction and the crop costs no detail at all.
 *
 * ## What the suggested fits are, and what they are not
 *
 * `framingsFor` measures local contrast: for every sample pixel, how much its
 * luminance differs from its neighbours. The window of a chosen shape is then
 * slid to the position holding the most of that energy, ties broken toward the
 * centre, and the numbers it reports are the share of the area kept and the
 * share of the measured detail kept. That is the whole algorithm, and it is the
 * whole claim. There is no subject detection, no faces, no horizon line and no
 * learned rule about composition — the segmentation work is assessed in
 * `lib/ai/segmentation.ts` and is not available here. A busy texture, a band of
 * noise in a dark sky or a picket fence can out-pull a face, and a photograph
 * whose interest is tonal rather than edged (a fog, a plain wall, skin lit from
 * one side) has little energy to follow, so the fit lands near the centre. It is
 * a starting place the user overrules, which is why a fit is only applied when a
 * chip is pressed and the untouched frame is one press away.
 */

export type CropRect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/** The whole photograph: nothing removed. */
export const FULL_FRAME: CropRect = { x: 0, y: 0, w: 1, h: 1 };

/** A window this thin on either axis is damage, not a frame. */
const MIN_WINDOW = 0.05;

/** How far the size control will shrink a frame: 30 % of its largest side. */
const MIN_SCALE = 0.3;

const EPS = 1e-9;

export type PixelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SourceSize = { readonly width: number; readonly height: number };

export type FrameRatio = {
  readonly id: string;
  /** What the chip says. */
  readonly label: string;
  /** Width over height. */
  readonly ratio: number;
  readonly kind: 'square' | 'portrait' | 'landscape';
  readonly note: string;
};

/**
 * The shapes worth offering: the two a camera makes, the three a phone screen
 * asks for, and the square. Deliberately few — each one is a decision the user
 * has to read, not a gallery to browse.
 */
export const FRAME_RATIOS: readonly FrameRatio[] = [
  {
    id: 'square',
    label: '1:1',
    ratio: 1,
    kind: 'square',
    note: 'Square — the shape most feeds, thumbnails and prints take.',
  },
  {
    id: 'portrait45',
    label: '4:5',
    ratio: 4 / 5,
    kind: 'portrait',
    note: '4:5 upright — the tallest frame a square-cropped feed will show.',
  },
  {
    id: 'landscape32',
    label: '3:2',
    ratio: 3 / 2,
    kind: 'landscape',
    note: '3:2 — the shape a 35mm frame is cut at.',
  },
  {
    id: 'wide169',
    label: '16:9',
    ratio: 16 / 9,
    kind: 'landscape',
    note: '16:9 — the shape of a screen.',
  },
  {
    id: 'portrait23',
    label: '2:3',
    ratio: 2 / 3,
    kind: 'portrait',
    note: '2:3 upright — the same frame, turned.',
  },
  {
    id: 'story',
    label: '9:16',
    ratio: 9 / 16,
    kind: 'portrait',
    note: '9:16 — full height, for stories and reels.',
  },
];

export function isFullFrame(crop: CropRect | null): boolean {
  return crop === null || (crop.w > 1 - EPS && crop.h > 1 - EPS);
}

/** Full frame and `null` are the same instruction, so they compare equal. */
export function sameCrop(a: CropRect | null, b: CropRect | null): boolean {
  if (isFullFrame(a) && isFullFrame(b)) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function unit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Six decimal places: a fraction of a pixel on any file worth editing. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Untrusted input (a database row, a hand-built object) becomes either a sane
 * window or `null`. A frame thinner than a twentieth of the picture on either
 * axis is treated as damage rather than intent.
 */
export function clampCrop(value: unknown): CropRect | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
  const w = clamp(unit(raw.w, 1), MIN_WINDOW, 1);
  const h = clamp(unit(raw.h, 1), MIN_WINDOW, 1);
  if (w > 1 - EPS && h > 1 - EPS) return null;
  return {
    x: round6(clamp(unit(raw.x, 0), 0, 1 - w)),
    y: round6(clamp(unit(raw.y, 0), 0, 1 - h)),
    w: round6(w),
    h: round6(h),
  };
}

/**
 * The window in whole pixels of a bitmap of `width` × `height`, always inside
 * the file and never empty. Rounding is where a normalized frame and a decoder
 * meet, so the clamp is done last rather than assumed.
 */
export function cropPixelRect(crop: CropRect | null, width: number, height: number): PixelRect {
  if (isFullFrame(crop) || width < 1 || height < 1) {
    return { x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) };
  }
  const x = clamp(Math.round(crop!.x * width), 0, Math.max(0, width - 1));
  const y = clamp(Math.round(crop!.y * height), 0, Math.max(0, height - 1));
  return {
    x,
    y,
    width: clamp(Math.round(crop!.w * width), 1, width - x),
    height: clamp(Math.round(crop!.h * height), 1, height - y),
  };
}

export function cropRatio(crop: CropRect, source: SourceSize): number {
  return (crop.w * source.width) / (crop.h * source.height);
}

export function retainedArea(crop: CropRect | null): number {
  return isFullFrame(crop) ? 1 : crop!.w * crop!.h;
}

/** The largest window of `ratio` that fits, centred. */
export function largestWindow(ratio: number, source: SourceSize): CropRect {
  const sourceRatio = source.width / source.height;
  if (!(ratio > 0) || !(sourceRatio > 0)) return { ...FULL_FRAME };
  let w = 1;
  let h = 1;
  if (sourceRatio > ratio) w = ratio / sourceRatio;
  else h = sourceRatio / ratio;
  return { x: round6((1 - w) / 2), y: round6((1 - h) / 2), w: round6(w), h: round6(h) };
}

/** The frame put back where it was pointing, at `factor` of its own largest size. */
export function scaleCrop(crop: CropRect, factor: number, source: SourceSize): CropRect | null {
  const largest = largestWindow(cropRatio(crop, source), source);
  const k = clamp(factor, MIN_SCALE, 1);
  const w = round6(clamp(largest.w * k, largest.w * MIN_SCALE, largest.w));
  const h = round6(clamp(largest.h * k, largest.h * MIN_SCALE, largest.h));
  if (w > 1 - EPS && h > 1 - EPS) return null;
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  return {
    x: round6(clamp(cx - w / 2, 0, 1 - w)),
    y: round6(clamp(cy - h / 2, 0, 1 - h)),
    w,
    h,
  };
}

export function centreCrop(crop: CropRect): CropRect {
  return { x: round6((1 - crop.w) / 2), y: round6((1 - crop.h) / 2), w: crop.w, h: crop.h };
}

/**
 * Put the window at a fraction of the travel available to it: 0 is flush with
 * the top-left, 1 flush with the bottom-right. A shape that spans an axis has no
 * travel on it and stays where it is. `cropTravel` is its inverse.
 */
export function placeCrop(crop: CropRect, fx: number, fy: number): CropRect {
  const x = round6(clamp(unit(fx, 0), 0, 1) * (1 - crop.w));
  const y = round6(clamp(unit(fy, 0), 0, 1) * (1 - crop.h));
  return { x, y, w: crop.w, h: crop.h };
}

/** Where the window sits along its own travel, for the sliders to start from. */
export function cropTravel(crop: CropRect): { fx: number; fy: number } {
  return {
    fx: crop.w < 1 - EPS ? clamp(crop.x / (1 - crop.w), 0, 1) : 0.5,
    fy: crop.h < 1 - EPS ? clamp(crop.y / (1 - crop.h), 0, 1) : 0.5,
  };
}

/* ------------------------------------------------------------------ *
 * Measuring where the detail is
 * ------------------------------------------------------------------ */

/**
 * Local contrast on a coarse grid: one value per sample pixel, row-major.
 * Produced from an aspect-keeping decode, because a sample stretched to a square
 * would report the detail as being wherever the stretch put it.
 */
export type DetailMap = {
  readonly width: number;
  readonly height: number;
  readonly energy: Float32Array;
};

/**
 * Luminance differences with the four neighbours, summed per pixel. BT.601
 * weights, the same ones the skin guard uses, so "bright" means one thing in
 * this module and the next. Edges of the grid clamp to their own row, which
 * keeps a border from counting as a hard edge twice over.
 */
export function detailMapFromRgba(rgba: ArrayLike<number>, width: number, height: number): DetailMap {
  const count = Math.max(0, width * height);
  const luma = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    luma[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  const energy = new Float32Array(count);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const up = (y > 0 ? y - 1 : y) * width;
    const down = (y < height - 1 ? y + 1 : y) * width;
    for (let x = 0; x < width; x++) {
      const left = x > 0 ? x - 1 : x;
      const right = x < width - 1 ? x + 1 : x;
      const at = row + x;
      energy[at] =
        Math.abs(luma[at] - luma[row + left]) +
        Math.abs(luma[at] - luma[row + right]) +
        Math.abs(luma[at] - luma[up + x]) +
        Math.abs(luma[at] - luma[down + x]);
    }
  }
  return { width, height, energy };
}

export function isMeasurable(map: DetailMap | null): map is DetailMap {
  if (!map || map.width < 3 || map.height < 3) return false;
  for (let i = 0; i < map.energy.length; i++) {
    if (map.energy[i] > 0) return true;
  }
  return false;
}

/** Prefix sums, so any window costs four lookups instead of a loop. */
function summedArea(map: DetailMap): Float64Array {
  const { width, height, energy } = map;
  const table = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let running = 0;
    const rowFrom = (y + 1) * (width + 1);
    const rowAbove = y * (width + 1);
    const rowEnergy = y * width;
    for (let x = 0; x < width; x++) {
      running += energy[rowEnergy + x];
      table[rowFrom + x + 1] = table[rowAbove + x + 1] + running;
    }
  }
  return table;
}

function windowSum(table: Float64Array, stride: number, x0: number, y0: number, w: number, h: number): number {
  const x1 = x0 + w;
  const y1 = y0 + h;
  return (
    table[y1 * stride + x1] -
    table[y0 * stride + x1] -
    table[y1 * stride + x0] +
    table[y0 * stride + x0]
  );
}

export type Placement = {
  readonly crop: CropRect;
  /** The share of the picture's measured detail that lands inside the frame. */
  readonly detailShare: number | null;
  /** False when the fit is simply centred because there was nothing to follow. */
  readonly measured: boolean;
};

/**
 * The share of the picture's measured detail that falls inside this exact
 * window. A number about the frame the user is looking at, as opposed to the
 * best a frame of that size could do, which is what `bestPlacement` reports.
 */
export function detailShareOf(map: DetailMap | null, crop: CropRect): number | null {
  if (!isMeasurable(map)) return null;
  const table = summedArea(map);
  const stride = map.width + 1;
  const total = table[map.height * stride + map.width];
  if (!(total > 0)) return null;
  const x0 = clamp(Math.floor(crop.x * map.width), 0, map.width - 1);
  const y0 = clamp(Math.floor(crop.y * map.height), 0, map.height - 1);
  const w = clamp(Math.round(crop.w * map.width), 1, map.width - x0);
  const h = clamp(Math.round(crop.h * map.height), 1, map.height - y0);
  return clamp(windowSum(table, stride, x0, y0, w, h) / total, 0, 1);
}

/**
 * Slide a window of `w` × `h` (as fractions) to where it holds the most detail.
 * Ties, and near-ties, go to the position closest to the centre, so a flat
 * photograph is framed flatly rather than pushed into a corner by float noise.
 */
export function bestPlacement(map: DetailMap | null, w: number, h: number): Placement {
  const centred: CropRect = { x: round6((1 - w) / 2), y: round6((1 - h) / 2), w: round6(w), h: round6(h) };
  if (!isMeasurable(map)) return { crop: centred, detailShare: null, measured: false };

  const cw = clamp(Math.round(w * map.width), 1, map.width);
  const ch = clamp(Math.round(h * map.height), 1, map.height);
  const table = summedArea(map);
  const stride = map.width + 1;
  const total = table[map.height * stride + map.width];
  if (!(total > 0)) return { crop: centred, detailShare: null, measured: false };

  const centreX = (map.width - cw) / 2;
  const centreY = (map.height - ch) / 2;

  let bestX = Math.round(centred.x * map.width);
  let bestY = Math.round(centred.y * map.height);
  let bestSum = -1;
  let bestDistance = Infinity;

  for (let py = 0; py <= map.height - ch; py++) {
    for (let px = 0; px <= map.width - cw; px++) {
      const sum = windowSum(table, stride, px, py, cw, ch);
      const distance = (px - centreX) ** 2 + (py - centreY) ** 2;
      /* A tenth of a percent of the running best is well inside the noise of a
         downsampled edge, so treat it as a tie and let the centre win. */
      const tie = Math.abs(bestSum) * 0.001;
      if (sum > bestSum + tie || (Math.abs(sum - bestSum) <= tie && distance < bestDistance)) {
        bestSum = sum;
        bestX = px;
        bestY = py;
        bestDistance = distance;
      }
    }
  }

  const crop: CropRect = {
    x: round6(clamp(bestX / map.width, 0, Math.max(0, 1 - w))),
    y: round6(clamp(bestY / map.height, 0, Math.max(0, 1 - h))),
    w: round6(w),
    h: round6(h),
  };
  return { crop, detailShare: clamp(bestSum / total, 0, 1), measured: true };
}

export type Framing = {
  readonly ratio: FrameRatio;
  /** The fit as measured, or the full frame when the shape already matches. */
  readonly crop: CropRect;
  /** Share of the picture's area inside the frame, 0–1. */
  readonly retained: number;
  /** Share of its measured detail; null when there was nothing to measure. */
  readonly detailShare: number | null;
  readonly measured: boolean;
  /** False when the photograph is already this shape — there is nothing to suggest. */
  readonly cuts: boolean;
  /** One of the three fits the measurement prefers; the chip carries a mark. */
  readonly suggested: boolean;
};

/**
 * Every offered shape, with the fit measured for this photograph.
 *
 * The three `suggested` marks go to the frames that keep the most detail per
 * pixel of picture retained — a shape that keeps a third of the area but
 * four-fifths of the detail is doing something, and one that barely cuts is not.
 * Ordering stays the table's own (square, then upright, then wide), because a
 * reshuffled row of chips every time a file loads is harder to press than a
 * fixed one.
 */
export function framingsFor(source: SourceSize, map: DetailMap | null): Framing[] {
  const sourceRatio = source.width / source.height;
  const rows: Framing[] = [];

  for (const ratio of FRAME_RATIOS) {
    const matches = Math.abs(sourceRatio - ratio.ratio) / ratio.ratio < 0.01;
    const largest = largestWindow(ratio.ratio, source);
    const cuts = !matches && retainedArea(largest) < 0.995;
    if (!cuts) {
      rows.push({
        ratio,
        crop: { ...FULL_FRAME },
        retained: 1,
        detailShare: null,
        measured: false,
        cuts: false,
        suggested: false,
      });
      continue;
    }
    const fit = bestPlacement(map, largest.w, largest.h);
    rows.push({
      ratio,
      crop: fit.crop,
      retained: retainedArea(fit.crop),
      detailShare: fit.detailShare,
      measured: fit.measured,
      cuts: true,
      suggested: false,
    });
  }

  const cutting = rows.filter((row) => row.cuts && row.detailShare !== null);
  if (cutting.length > 0) {
    const ranked = [...cutting].sort((a, b) => {
      const advantage = (row: Framing) => (row.detailShare ?? 0) - row.retained;
      const gap = advantage(b) - advantage(a);
      return Math.abs(gap) < 1e-4 ? a.retained - b.retained : gap;
    });
    for (const row of ranked.slice(0, 3)) {
      const index = rows.findIndex((candidate) => candidate.ratio.id === row.ratio.id);
      rows[index] = { ...rows[index], suggested: true };
    }
  }

  return rows;
}

export function percent(share: number): string {
  return `${Math.round(clamp(share, 0, 1) * 100)}%`;
}

/** `4080 × 4080 px` — what a frame actually leaves, in the file's own pixels. */
export function cropPixels(crop: CropRect | null, source: SourceSize): PixelRect {
  return cropPixelRect(clampCrop(crop), source.width, source.height);
}

/**
 * One honest sentence about a frame: the shape, how much of the picture is left,
 * and what that is in pixels. Detail share is added by the caller, which knows
 * whether there was a measurement to talk about.
 */
export function framingLabel(crop: CropRect | null, source: SourceSize): string {
  const rect = cropPixelRect(crop, source.width, source.height);
  return `${percent(retainedArea(crop))} of the picture · ${rect.width} × ${rect.height} px`;
}
