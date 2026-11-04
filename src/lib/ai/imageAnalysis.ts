/**
 * Local image analysis — no external model, no network requests.
 *
 * Analyses a photograph by sampling its pixels at low resolution and computing
 * objective measurements: brightness, contrast, warmth, saturation, and a
 * dominant hue direction. These are measurements, not predictions. The results
 * are labelled as such in the UI.
 *
 * ## What this can measure reliably
 * - Mean luminance (overall brightness)
 * - Luminance standard deviation (tonal contrast)
 * - Red–blue channel balance (warm vs cool cast)
 * - Mean saturation in HSL space
 * - Dominant hue quadrant (warm/cool/green/neutral)
 *
 * ## What this cannot determine
 * - Subject matter (person, landscape, food, etc.) — no classifier is used
 * - Scene category — inferred loosely from colour/brightness patterns only
 *
 * The caller receives an `ImageAnalysis` object with both raw numbers and
 * human-readable labels so the UI can be honest about what was measured.
 */

import type { Photo } from '../photoStore';

/** The paper every measurement is taken on: one square, coarse, cheap. */
export const SAMPLE_SIZE = 64;


export type BrightnessLabel = 'dark' | 'mid' | 'bright' | 'high-key';
export type ContrastLabel = 'flat' | 'soft' | 'normal' | 'punchy';
export type WarmthLabel = 'cool' | 'neutral' | 'warm';
export type SaturationLabel = 'desaturated' | 'muted' | 'natural' | 'vivid';
export type HueBias = 'warm' | 'cool' | 'green' | 'neutral';

export type ImageAnalysis = {
  readonly brightness: number;
  readonly contrast: number;
  readonly warmth: number;
  readonly saturation: number;
  readonly hueBias: HueBias;
  readonly brightnessLabel: BrightnessLabel;
  readonly contrastLabel: ContrastLabel;
  readonly warmthLabel: WarmthLabel;
  readonly saturationLabel: SaturationLabel;
  /** One-sentence summary of what was measured. */
  readonly summary: string;
  /**
   * Loose scene hints derived from colour/brightness patterns.
   * These are heuristic guesses, not classifier outputs.
   */
  readonly sceneHints: readonly string[];
};

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function toBrightnessLabel(v: number): BrightnessLabel {
  if (v < 0.25) return 'dark';
  if (v < 0.45) return 'mid';
  if (v < 0.65) return 'bright';
  return 'high-key';
}

function toContrastLabel(v: number): ContrastLabel {
  if (v < 0.08) return 'flat';
  if (v < 0.14) return 'soft';
  if (v < 0.22) return 'normal';
  return 'punchy';
}

function toWarmthLabel(v: number): WarmthLabel {
  if (v < -0.04) return 'cool';
  if (v > 0.04) return 'warm';
  return 'neutral';
}

function toSaturationLabel(v: number): SaturationLabel {
  if (v < 0.08) return 'desaturated';
  if (v < 0.18) return 'muted';
  if (v < 0.35) return 'natural';
  return 'vivid';
}

function toHueBias(warmth: number, saturation: number, greenBias: number): HueBias {
  if (saturation < 0.06) return 'neutral';
  if (greenBias > 0.04 && Math.abs(warmth) < 0.06) return 'green';
  if (warmth > 0.04) return 'warm';
  if (warmth < -0.04) return 'cool';
  return 'neutral';
}

type Partial_ = Omit<ImageAnalysis, 'summary' | 'sceneHints'>;

function buildSummary(a: Partial_): string {
  const parts: string[] = [];
  if (a.brightnessLabel === 'dark') parts.push('dark tones');
  else if (a.brightnessLabel === 'high-key') parts.push('very bright, high-key exposure');
  else if (a.brightnessLabel === 'bright') parts.push('bright exposure');
  else parts.push('mid-range exposure');

  if (a.contrastLabel === 'flat') parts.push('flat contrast');
  else if (a.contrastLabel === 'punchy') parts.push('high contrast');
  else if (a.contrastLabel === 'soft') parts.push('soft contrast');

  if (a.warmthLabel === 'warm') parts.push('warm colour cast');
  else if (a.warmthLabel === 'cool') parts.push('cool colour cast');

  if (a.saturationLabel === 'desaturated') parts.push('near-monochrome colours');
  else if (a.saturationLabel === 'vivid') parts.push('vivid colours');
  else if (a.saturationLabel === 'muted') parts.push('muted colours');

  return `Measured: ${parts.join(', ')}.`;
}

function buildSceneHints(a: Partial_): string[] {
  const hints: string[] = [];
  if (a.brightnessLabel === 'dark' && a.saturationLabel !== 'vivid') {
    hints.push('night or low-light scene');
  }
  if (
    (a.brightnessLabel === 'bright' || a.brightnessLabel === 'high-key') &&
    a.warmthLabel === 'warm' &&
    (a.saturationLabel === 'natural' || a.saturationLabel === 'vivid')
  ) {
    hints.push('outdoor daylight');
  }
  if (a.brightnessLabel === 'high-key' && a.saturationLabel === 'muted') {
    hints.push('studio or high-key portrait');
  }
  if (a.warmthLabel === 'cool' && a.saturationLabel !== 'vivid') {
    hints.push('overcast or urban scene');
  }
  if (a.hueBias === 'green') {
    hints.push('landscape or nature');
  }
  if (a.saturationLabel === 'desaturated') {
    hints.push('monochrome or near-monochrome');
  }
  if (a.contrastLabel === 'punchy' && a.warmthLabel === 'warm') {
    hints.push('golden hour or travel');
  }
  return hints.length > 0 ? hints : ['general photography'];
}

/**
 * The measurement itself, on raw RGBA bytes. Kept free of the DOM so the same
 * function runs in the browser and in the tests, over real decoded photographs.
 * `data` holds `pixelCount` RGBA pixels.
 */
export function analysePixels(data: ArrayLike<number>, pixelCount: number): ImageAnalysis {
  const n = pixelCount;
  let sumL = 0, sumR = 0, sumB = 0, sumS = 0, sumGreen = 0;
  const lums: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    const l = luminance(r, g, b);
    lums[i] = l;
    sumL += l;
    sumR += r;
    sumB += b;
    sumGreen += g - (r + b) / 2;
    const [, s] = rgbToHsl(r, g, b);
    sumS += s;
  }

  const meanL = sumL / n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (lums[i] - meanL) ** 2;
  const stdL = Math.sqrt(variance / n);

  const warmthVal = (sumR - sumB) / n;
  const greenBias = sumGreen / n;
  const satVal = sumS / n;

  const partial: Partial_ = {
    brightness: meanL,
    contrast: stdL,
    warmth: warmthVal,
    saturation: satVal,
    hueBias: toHueBias(warmthVal, satVal, greenBias),
    brightnessLabel: toBrightnessLabel(meanL),
    contrastLabel: toContrastLabel(stdL),
    warmthLabel: toWarmthLabel(warmthVal),
    saturationLabel: toSaturationLabel(satVal),
  };

  return {
    ...partial,
    summary: buildSummary(partial),
    sceneHints: buildSceneHints(partial),
  };
}

/**
 * Any image file, reduced to the same 64×64 RGBA sample the measurements read.
 *
 * A photograph being edited and a reference photograph someone else printed are
 * compared only when they are measured on paper of the same grain, so both go
 * through here. It takes a `Blob` rather than a `Photo` because the reference
 * never becomes a `Photo`: nothing outside the editor's own file list should be
 * able to reach the stage.
 */
export async function readSample(blob: Blob): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: SAMPLE_SIZE,
    resizeHeight: SAMPLE_SIZE,
    resizeQuality: 'low',
  });

  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable for image analysis.');

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
}

export async function analysePhoto(photo: Photo): Promise<ImageAnalysis> {
  const data = await readSample(photo.file);
  return analysePixels(data, SAMPLE_SIZE * SAMPLE_SIZE);
}
