/**
 * Measuring what a preset actually does.
 *
 * A preset that changes no pixels is not a look, and a library of two hundred
 * presets that all render the same picture is a list, not a choice. Both claims
 * are cheap to check: run the engine over a fixed test chart — ramps in every
 * channel, three grey levels and eight colour patches — and read the numbers
 * back. Nothing here needs a canvas or a browser, so the same measurement runs
 * in the build scripts and in the tests.
 */

import { IDENTITY, toPipelineParams, type Adjustments } from '../image/adjustments.ts';
import { applyCrossChannel, applyPipeline, buildChannelLuts } from '../image/pipeline.ts';

export type Chart = {
  readonly width: number;
  readonly height: number;
  /** Three bytes per pixel. */
  readonly rgb: Uint8Array;
};

const PATCHES = [
  [232, 199, 172],
  [196, 214, 232],
  [74, 108, 66],
  [178, 62, 58],
  [64, 66, 70],
  [212, 176, 74],
  [30, 34, 40],
  [246, 246, 244],
];

/** Built once, byte for byte, on every machine. */
export function makeChart(width = 96, height = 64): Chart {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const t = x / (width - 1);
      const s = y / (height - 1);
      rgb[i] = Math.round(255 * (0.06 + 0.88 * t));
      rgb[i + 1] = Math.round(255 * (0.06 + 0.88 * (1 - t) * 0.4 + 0.5 * s));
      rgb[i + 2] = Math.round(255 * (0.1 + 0.75 * s));
      const patch = Math.min(PATCHES.length - 1, Math.floor(t * 8));
      if (s > 0.72) {
        rgb[i] = PATCHES[patch][0];
        rgb[i + 1] = PATCHES[patch][1];
        rgb[i + 2] = PATCHES[patch][2];
      }
    }
  }
  return { width, height, rgb };
}

const CHART = makeChart();
const PIXEL = new Float32Array(3);

export function renderChart(adjust: Partial<Adjustments>, chart: Chart = CHART): Uint8Array {
  const params = toPipelineParams({ ...IDENTITY, ...adjust });
  const out = new Uint8Array(chart.rgb.length);
  for (let y = 0; y < chart.height; y++) {
    for (let x = 0; x < chart.width; x++) {
      const i = (y * chart.width + x) * 3;
      PIXEL[0] = chart.rgb[i] / 255;
      PIXEL[1] = chart.rgb[i + 1] / 255;
      PIXEL[2] = chart.rgb[i + 2] / 255;
      applyPipeline(PIXEL, params, {
        u: (x + 0.5) / chart.width,
        v: (y + 0.5) / chart.height,
        x,
        y,
      });
      out[i] = Math.max(0, Math.min(255, Math.round(PIXEL[0] * 255)));
      out[i + 1] = Math.max(0, Math.min(255, Math.round(PIXEL[1] * 255)));
      out[i + 2] = Math.max(0, Math.min(255, Math.round(PIXEL[2] * 255)));
    }
  }
  return out;
}

/** Mean absolute change per channel, 0–255, against the untouched chart. */
export function effectOf(adjust: Partial<Adjustments>): number {
  const before = renderChart({});
  const after = renderChart(adjust);
  let sum = 0;
  for (let i = 0; i < before.length; i++) sum += Math.abs(before[i] - after[i]);
  return sum / before.length;
}

/** How far apart two recipes look, on the same chart. */
export function distanceOf(a: Partial<Adjustments>, b: Partial<Adjustments>): number {
  const left = renderChart(a);
  const right = renderChart(b);
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += Math.abs(left[i] - right[i]);
  return sum / left.length;
}

/** A short fingerprint, used to catch duplicate recipes across sources. */
export function signatureOf(adjust: Partial<Adjustments>): string {
  return JSON.stringify(
    Object.entries({ ...IDENTITY, ...adjust }).sort(([x], [y]) => (x < y ? -1 : 1)),
  );
}

/**
 * A smaller reading of the same chart, for comparing two looks to each other
 * rather than measuring one against the untouched print.
 *
 * The full chart is 96×64 = 6,144 pixels, and asking "which of these six hundred
 * looks is nearest to this one?" means rendering it six hundred times. Twelve
 * looks against the whole library take 5.0 seconds on the full chart and 0.65
 * seconds on the sample, which keeps the same ramps and the same eight colour
 * patches at a third of each edge.
 *
 * What the coarser paper costs is measured rather than assumed. On those twelve
 * looks it returns the same four nearest in eleven cases, and where it differs
 * the two looks involved are separated on the full chart by less than a hundredth
 * of a pixel value; nothing is returned that the full chart ranks further away
 * than 0.006 past its own fourth-nearest. Enlarging the sample does not buy
 * agreement — at 48×36 the ordering matched in eight cases of twelve — so the
 * cheapest one is used, and the claim stays inside what was checked: the nearest
 * of the looks the engine renders, measured on the test chart.
 */
const SAMPLE_CHART = makeChart(32, 24);
const renderedSample = new WeakMap<Partial<Adjustments>, Uint8Array>();

/** The reduced chart itself, for anything that has to read pixels rather than a distance. */
export function sampleChart(): Chart {
  return SAMPLE_CHART;
}

/**
 * The render of the reduced chart for one recipe, remembered per recipe.
 *
 * Anything that compares a great many looks to one another wants these rather
 * than a number: `sampleDistance` is their difference.
 */
export function sampleRender(adjust: Partial<Adjustments>): Uint8Array {
  const known = renderedSample.get(adjust);
  if (known) return known;
  const next = renderChart(adjust, SAMPLE_CHART);
  renderedSample.set(adjust, next);
  return next;
}

/** Mean |Δ| per channel between two recipes' renders of the reduced chart. */
export function sampleDistance(a: Partial<Adjustments>, b: Partial<Adjustments>): number {
  const left = sampleRender(a);
  const right = sampleRender(b);
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += Math.abs(left[i] - right[i]);
  return sum / left.length;
}

const GRADE_PIXEL = new Float32Array(3);

function toGradeByte(value: number): number {
  const byte = Math.round(value * 255);
  return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}

/**
 * The engine's answer for a photograph rather than for the chart: RGBA in, RGB out.
 *
 * This is the CPU fallback's own loop — the three channel tables folded by
 * `buildChannelLuts`, then the cross-channel stages, then the same rounding the
 * preview and the thumbnail cards write — so a number taken here is the number
 * the user would see at that position, and what a card shows and what the
 * reference matcher measures cannot disagree. `ai/reference.ts` needs exactly
 * that, because the chart cannot say what a look does *to this file*: two looks
 * that shift the chart's averages by the same amount can flatten a sky and
 * darken a shadow respectively, and a photograph is full of skies and shadows.
 *
 * It costs about a sixth of what the per-stage reference path costs at the same
 * pixel count — measured at 0.8 ms for a 64×64 sample against 4.6 ms — which is
 * what makes ranking several hundred looks in one button press possible. It
 * inherits the fold requirement documented on `buildChannelLuts`: the tables are
 * only honest while every per-channel stage sits in front of every cross-channel
 * one, and `pipeline.test.ts` keeps that ordering true.
 *
 * `out` may be supplied and reused by the caller: ranking a catalogue means
 * thousands of these buffers, and they are all the same size.
 */
export function gradeSample(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  adjust: Partial<Adjustments>,
  out: Uint8Array = new Uint8Array(width * height * 3),
): Uint8Array {
  const params = toPipelineParams({ ...IDENTITY, ...adjust });
  const table = buildChannelLuts(params);
  const px = { u: 0, v: 0.5, x: 0, y: 0 };
  for (let y = 0; y < height; y++) {
    px.v = (y + 0.5) / height;
    px.y = y;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      px.u = (x + 0.5) / width;
      px.x = x;
      const s = i * 4;
      GRADE_PIXEL[0] = table[rgba[s]];
      GRADE_PIXEL[1] = table[256 + rgba[s + 1]];
      GRADE_PIXEL[2] = table[512 + rgba[s + 2]];
      applyCrossChannel(GRADE_PIXEL, params, px);
      const d = i * 3;
      out[d] = toGradeByte(GRADE_PIXEL[0]);
      out[d + 1] = toGradeByte(GRADE_PIXEL[1]);
      out[d + 2] = toGradeByte(GRADE_PIXEL[2]);
    }
  }
  return out;
}
