/**
 * The look of a photograph, as eleven numbers.
 *
 * `imageAnalysis.ts` answers "what is in front of the camera" — brightness,
 * contrast, cast, saturation — for one picture at a time. This answers the same
 * questions on a finer grain, because matching a reference photograph to a look
 * needs the tone scale's two ends and the palette's breadth, not only its
 * middle. Every field is a mean over pixels of the sample it is given, and every
 * field is something the engine is known to move: the stages in `pipeline.ts`
 * change the tone scale, the colour balance and the chroma, so a look graded onto
 * a photograph shifts exactly these quantities.
 *
 * ## What is read
 * - `brightness` / `contrast` — the level and the spread of the tone scale.
 * - `warmth` / `green` — the two colour-balance axes this engine has knobs for.
 * - `saturation` — mean HSL chroma; `spread` — how far the pixels are from the
 *   average colour, which is what "broad palette" means when it is measured
 *   rather than admired.
 * - `highlights` / `shadows` — the mean of the brightest and darkest quarter.
 * - `highlightWarmth` / `shadowWarmth` — the cast at each end, which is how a
 *   split-toned print gives itself away.
 * - `blackFloor` — the mean of the darkest two per cent: a faded print starts
 *   its blacks high, a printed one starts them near zero.
 *
 * ## What is deliberately not read
 * Faces, objects, edges, region boundaries, grain, or any of the sixty-odd
 * things this engine cannot do. A field that no knob can move would only let a
 * match look precise without becoming attainable.
 *
 * ## Honesty about the units
 * Each field is divided by a `unit` — the difference in that quantity that reads
 * as a clear step rather than a subtle one — so that a distance between two
 * reads is "how many clear steps apart, on average", in comparable numbers
 * instead of a sum of unlike quantities. Those units are stated below as what
 * they are: a fixed scale chosen so the six or seven visible characteristics
 * count about as much as each other. Nothing here was fitted to a perceptual
 * study, and no claim of perceptual accuracy is made anywhere in this file.
 */

/** The quantities a look is compared on, in the order the distance uses them. */
export type StyleFieldId =
  | 'brightness'
  | 'contrast'
  | 'warmth'
  | 'green'
  | 'saturation'
  | 'spread'
  | 'highlights'
  | 'shadows'
  | 'highlightWarmth'
  | 'shadowWarmth'
  | 'blackFloor';

/** One reading. Also used, per field, to hold the difference between two readings. */
export type StyleRead = { readonly [K in StyleFieldId]: number };

export type StyleField = {
  readonly id: StyleFieldId;
  /** A clear step in this quantity, in the same units the read is stored in. */
  readonly unit: number;
  /** How much this characteristic counts in the distance. */
  readonly weight: number;
  readonly label: string;
  /** What a larger value means, for the sentence that reports a gap. */
  readonly more: string;
  readonly less: string;
};

export const STYLE_FIELDS: readonly StyleField[] = [
  { id: 'brightness', unit: 0.05, weight: 1, label: 'overall level', more: 'brighter', less: 'darker' },
  { id: 'contrast', unit: 0.03, weight: 1, label: 'tonal spread', more: 'more contrast', less: 'flatter' },
  { id: 'warmth', unit: 0.02, weight: 1.2, label: 'warm–cool balance', more: 'warmer', less: 'cooler' },
  { id: 'green', unit: 0.02, weight: 0.7, label: 'green–magenta bias', more: 'greener', less: 'more magenta' },
  { id: 'saturation', unit: 0.05, weight: 1, label: 'colour intensity', more: 'more saturated', less: 'flatter in colour' },
  { id: 'spread', unit: 0.03, weight: 0.7, label: 'palette breadth', more: 'a broader palette', less: 'a narrower palette' },
  { id: 'highlights', unit: 0.05, weight: 1, label: 'highlight level', more: 'brighter highlights', less: 'deeper highlights' },
  { id: 'shadows', unit: 0.05, weight: 1, label: 'shadow level', more: 'lighter shadows', less: 'deeper shadows' },
  { id: 'highlightWarmth', unit: 0.02, weight: 0.9, label: 'highlight cast', more: 'warmer highlights', less: 'cooler highlights' },
  { id: 'shadowWarmth', unit: 0.02, weight: 0.9, label: 'shadow cast', more: 'warmer shadows', less: 'cooler shadows' },
  { id: 'blackFloor', unit: 0.03, weight: 0.8, label: 'black floor', more: 'more lifted blacks', less: 'deeper blacks' },
];

const TOTAL_WEIGHT = STYLE_FIELDS.reduce((sum, field) => sum + field.weight, 0);

const fieldById = new Map(STYLE_FIELDS.map((field) => [field.id, field]));

export function styleField(id: StyleFieldId): StyleField {
  const known = fieldById.get(id);
  if (!known) throw new Error(`Unknown style field: ${id}`);
  return known;
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** HSL saturation, matching `imageAnalysis.ts` so the two never disagree. */
function chroma(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

/**
 * The measurement, from interleaved pixel bytes.
 *
 * `stride` is 4 for RGBA (what a canvas hands back) and 3 for the RGB the engine
 * renders a sample to, because a reference photograph and a look's effect on a
 * photograph are only comparable when both are read the same way. Alpha is
 * ignored, exactly as `analysePixels` ignores it: a transparent PNG is averaged
 * against a background that is not in the file, and that limitation is
 * documented rather than hidden behind a correction nobody can verify.
 *
 * The ends of the tone scale come out of a 64-bin luminance histogram rather
 * than a sorted pixel list. That is a deliberate trade: a ranking pass reads
 * several hundred of these, and an index sort over 4,096 pixels cost more than
 * the grading it was measuring. A band is filled bin by bin from one end until it
 * holds its fraction of the pixels, and the bin that crosses the boundary
 * contributes in proportion with its centre standing in for its levels — so a
 * band mean can be out by at most half a bin, 0.008 of the print, against a unit
 * of 0.05. Both photographs and every graded sample go through the same bins, so
 * the quantization largely cancels in the comparison it is used for.
 */
const BINS = 64;
const BIN_SIZE = 1 / BINS;

type Band = { readonly level: number; readonly cast: number };

/**
 * The mean level and red–blue cast of the pixels at one end of the tone scale.
 *
 * `fraction` of the pixels are taken, from `side`. Counting from the end makes
 * this a share of *this* photograph rather than a fixed luminance, which is what
 * "the highlights" means when comparing a dark frame to a bright one; the engine
 * itself weights its zone knobs by level, so the two readings are different
 * views of the same tone scale and are not mixed.
 */
function bandOf(count: Float64Array, cast: Float64Array, total: number, fraction: number, side: 'top' | 'bottom'): Band {
  const want = Math.max(1, total * fraction);
  let taken = 0;
  let sumLevel = 0;
  let sumCast = 0;
  for (let step = 0; step < BINS; step++) {
    const bin = side === 'top' ? BINS - 1 - step : step;
    const here = count[bin];
    if (here === 0) continue;
    const centre = (bin + 0.5) * BIN_SIZE;
    const use = Math.min(here, want - taken);
    sumLevel += use * centre;
    /* The partial bin's cast is taken in the same proportion as its pixels, from
       the bin's own average: a boundary bin that is half in, half out contributes
       half its pixels and half their cast. */
    sumCast += (use / here) * cast[bin];
    taken += use;
    if (taken >= want) break;
  }
  const n = Math.max(taken, 1);
  return { level: sumLevel / n, cast: sumCast / n };
}

function readStyle(data: ArrayLike<number>, pixelCount: number, stride: number): StyleRead {
  const n = pixelCount;
  const histCount = new Float64Array(BINS);
  const histCast = new Float64Array(BINS);
  let sumL = 0;
  let sumL2 = 0;
  let sumRb = 0;
  let sumGreen = 0;
  let sumSat = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const r = data[o] / 255;
    const g = data[o + 1] / 255;
    const b = data[o + 2] / 255;
    const l = luminance(r, g, b);
    const bin = Math.min(BINS - 1, Math.floor(l * BINS));
    histCount[bin] += 1;
    histCast[bin] += r - b;
    sumL += l;
    sumL2 += l * l;
    sumRb += r - b;
    sumGreen += g - (r + b) / 2;
    sumSat += chroma(r, g, b);
    sumR += r;
    sumG += g;
    sumB += b;
  }

  const meanL = sumL / n;
  const variance = Math.max(0, sumL2 / n - meanL * meanL);

  /* Palette breadth as the mean distance from the average colour: a second pass
     because the centre is not known until the first one ends. Measured against
     the mean rather than as a count of hues keeps it continuous — a photograph
     with three strong colours and one with thirty sit in the same place when
     their pixels are equally far from the middle. */
  const meanR = sumR / n;
  const meanG = sumG / n;
  const meanB = sumB / n;
  let spread = 0;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const dr = data[o] / 255 - meanR;
    const dg = data[o + 1] / 255 - meanG;
    const db = data[o + 2] / 255 - meanB;
    spread += Math.sqrt(dr * dr + dg * dg + db * db);
  }

  const highlights = bandOf(histCount, histCast, n, 0.25, 'top');
  const shadows = bandOf(histCount, histCast, n, 0.25, 'bottom');
  const floor = bandOf(histCount, histCast, n, 0.02, 'bottom');

  return {
    brightness: meanL,
    contrast: Math.sqrt(variance),
    warmth: sumRb / n,
    green: sumGreen / n,
    saturation: sumSat / n,
    spread: spread / n,
    highlights: highlights.level,
    shadows: shadows.level,
    highlightWarmth: highlights.cast,
    shadowWarmth: shadows.cast,
    blackFloor: floor.level,
  };
}

/** RGBA bytes, as a canvas gives them. */
export function readStyleRgba(data: ArrayLike<number>, pixelCount: number): StyleRead {
  return readStyle(data, pixelCount, 4);
}

/** RGB bytes, as the engine renders a graded sample. */
export function readStyleRgb(rgb: ArrayLike<number>, pixelCount: number): StyleRead {
  return readStyle(rgb, pixelCount, 3);
}

/** `a − b`, field by field: what is still missing between two readings. */
export function subtractStyle(a: StyleRead, b: StyleRead): StyleRead {
  const out = {} as Record<StyleFieldId, number>;
  for (const field of STYLE_FIELDS) out[field.id] = a[field.id] - b[field.id];
  return out as StyleRead;
}

/** How far apart two reads are, in clear steps, averaged over the characteristics. */
export function styleDistance(a: StyleRead, b: StyleRead): number {
  let sum = 0;
  for (const field of STYLE_FIELDS) {
    sum += (field.weight * Math.abs(a[field.id] - b[field.id])) / field.unit;
  }
  return sum / TOTAL_WEIGHT;
}

/**
 * The same measure against nothing, for a difference vector on its own.
 *
 * The descent in `reference.ts` costs a residual rather than a pair of
 * photographs, and it needs the identical yardstick: the two functions share the
 * weights and the units, so a "step" means one thing everywhere it is used.
 */
export function styleSteps(delta: StyleRead): number {
  let sum = 0;
  for (const field of STYLE_FIELDS) {
    sum += (field.weight * Math.abs(delta[field.id])) / field.unit;
  }
  return sum / TOTAL_WEIGHT;
}

export type StyleGap = {
  readonly field: StyleField;
  /** Signed difference in steps; positive means the target has more of it. */
  readonly steps: number;
  readonly label: string;
};

/**
 * What is still missing, largest first, in the same steps the distance uses.
 * Only gaps of half a step or more are returned — smaller ones are not things a
 * reader can check on a photograph.
 */
export function styleGaps(have: StyleRead, target: StyleRead, limit = 3): StyleGap[] {
  const rows: StyleGap[] = [];
  for (const field of STYLE_FIELDS) {
    const raw = target[field.id] - have[field.id];
    const steps = raw / field.unit;
    if (Math.abs(steps) < 0.5) continue;
    rows.push({
      field,
      steps,
      label: `${field.label}: ${steps > 0 ? field.more : field.less}`,
    });
  }
  return rows.sort((a, b) => Math.abs(b.steps) - Math.abs(a.steps) || a.field.id.localeCompare(b.field.id)).slice(0, limit);
}

/** The one line that explains a distance figure. */
export function describeStyleGap(have: StyleRead, target: StyleRead): string {
  const gaps = styleGaps(have, target, 2);
  if (gaps.length === 0) return 'nothing left that this engine can move';
  return gaps.map((gap) => gap.label).join(' and ');
}

/** Two reads in words, for the panel that shows what was measured. */
export function styleSummary(read: StyleRead): string {
  const parts = [
    `${Math.round(read.brightness * 100)}% level`,
    read.contrast < 0.09 ? 'flat' : read.contrast > 0.2 ? 'high contrast' : 'mid contrast',
    read.warmth > 0.02 ? 'warm cast' : read.warmth < -0.02 ? 'cool cast' : 'neutral cast',
    `${Math.round(read.saturation * 100)}% colour`,
    read.spread > 0.11 ? 'broad palette' : 'narrow palette',
    read.blackFloor > 0.045 ? 'lifted blacks' : 'deep blacks',
  ];
  const split = read.shadowWarmth - read.highlightWarmth;
  if (Math.abs(split) > 0.02) {
    parts.push(split > 0 ? 'warm shadows against cool highlights' : 'cool shadows against warm highlights');
  }
  return parts.join(' · ');
}
