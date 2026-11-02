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
import { applyPipeline } from '../image/pipeline.ts';

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
