/**
 * One-tap enhance: three visually distinct looks adapted to the measured
 * characteristics of the loaded photograph.
 *
 * ## What this is — and is not
 * Automated rules. The photograph is measured (brightness, contrast, colour
 * cast, saturation — see imageAnalysis.ts) and those numbers are scored against
 * the real recipes in the preset library. Nothing here is a neural network or a
 * generative model, nothing is sent anywhere, and the UI must not describe it
 * as AI. `basis` is carried on every option so the interface can state that
 * truthfully instead of assuming it.
 *
 * ## The three looks
 * - Natural   — a gentle correction that moves the measured weaknesses of this
 *               photograph (too dark, too flat, a cast, muted colour) towards a
 *               balanced rendering. Subtle by construction.
 * - Cinematic — a contrast-led, filmic grade with real depth.
 * - Creative  — a character look: faded, vintage, dreamy, monochrome, …
 *
 * Every option is an existing preset; its recipe is used exactly as stored.
 *
 * ## Staying distinct
 * Looks are chosen one after another, and each must differ from those already
 * chosen by a minimum amount *measured by the engine itself* on the test chart
 * (the same measurement the library uses for `effect`). If nothing in a family
 * clears the bar, the most different candidate is taken instead, so a family
 * never silently collapses into another.
 *
 * ## Intensity
 * Not handled here. A preset recipe is blended towards identity by the shared
 * `scaleRecipe`, in slider units. This engine has no 3D-LUT stage — presets
 * that came from LUT files were converted to slider recipes at import — so one
 * blend is correct for every option offered.
 */

import { CONTROLS, IDENTITY, type Adjustments } from '../image/adjustments';
import { renderChart } from '../preset/effect';
import { isUsable } from '../preset/library';
import type { Preset, PresetLibrary } from '../preset/schema';
import type { ImageAnalysis } from './imageAnalysis';

export type EnhanceKind = 'natural' | 'cinematic' | 'creative';

export type EnhanceOption = {
  readonly kind: EnhanceKind;
  readonly label: string;
  readonly preset: Preset;
  /** Why this look was chosen for this photograph. One short sentence. */
  readonly explanation: string;
  /** What the recipe actually does, in the editor's own knob names. */
  readonly changes: string;
  /** How the option was produced. Always automated rules today. */
  readonly basis: 'rules';
};

/** Minimum difference between two chosen looks, mean |Δ| on the 0–255 chart. */
export const MIN_DISTINCT = 6;

// ── Category pools ───────────────────────────────────────────────────────────

const NATURAL_CATS = new Set(['Natural', 'Bright and airy', 'Portrait', 'Warm', 'Cool']);

const CINEMATIC_CATS = new Set([
  'Cinematic', 'Moody', 'Film makers', 'Film-inspired', 'Night photography',
  'Street photography', 'Editorial',
]);

const CREATIVE_CATS = new Set([
  'Faded film', 'Vintage', 'Dreamy', 'Alternative processes', 'Black and white',
  'Black and white film', 'Historical decades', 'Colour negative film', 'Slide film',
]);

const CINEMATIC_PREFER: Record<string, readonly string[]> = {
  dark: ['low-key', 'night-photography', 'moody', 'cinematic'],
  mid: ['cinematic', 'firm-contrast', 'dramatic'],
  bright: ['cinematic', 'warm-highlight', 'amber'],
  'high-key': ['cinematic', 'cool-shadow', 'editorial'],
};

const CREATIVE_PREFER: Record<string, readonly string[]> = {
  dark: ['monochrome', 'black-white-film', 'alternative-processes'],
  mid: ['faded-film', 'lifted-blacks', 'vintage', 'dreamy'],
  bright: ['dreamy', 'pale', 'quiet-colour', 'faded-film'],
  'high-key': ['dreamy', 'pale', 'monochrome', 'alternative-processes'],
};

const WARMTH_BONUS: Record<string, readonly string[]> = {
  warm: ['warm-highlight', 'amber', 'warm-split', 'warm'],
  cool: ['cool-shadow', 'cool-split', 'cool', 'nordic'],
};

// ── Recipe features ──────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

type Features = {
  /** Net lightening (+) or darkening (−), roughly in slider units. */
  readonly lift: number;
  readonly contrast: number;
  /** Net warming (+) or cooling (−). */
  readonly warm: number;
  /** Net colour boost (+) or drain (−). */
  readonly colour: number;
  readonly mono: boolean;
  readonly strength: number;
  readonly vignette: number;
};

function featuresOf(preset: Preset): Features {
  const r: Adjustments = { ...IDENTITY, ...preset.adjust };
  return {
    lift: r.exposure * 50 + r.brightness + 0.5 * r.shadows + 0.3 * r.blacks,
    contrast: r.contrast,
    warm: r.warmth + r.temperature,
    colour: r.saturation + r.vibrance,
    mono: r.saturation <= -80,
    strength: preset.effect ?? 0,
    vignette: r.vignette,
  };
}

function tagScore(preset: Preset, tags: readonly string[], weight: number): number {
  const have = new Set(preset.tags);
  let s = 0;
  for (const tag of tags) if (have.has(tag)) s += weight;
  return s;
}

// ── Scoring per family ───────────────────────────────────────────────────────

/** Natural: does the recipe move the measured weaknesses towards balance? */
function scoreNatural(preset: Preset, a: ImageAnalysis): number {
  if (!NATURAL_CATS.has(preset.category)) return -Infinity;
  const f = featuresOf(preset);
  if (f.strength < 1.5 || f.strength > 25) return -Infinity;
  if (f.mono && a.saturationLabel !== 'desaturated') return -Infinity;

  let s = 0;
  // Exposure: aim for a mean luminance near 0.45.
  const dBright = 0.45 - a.brightness;
  s += clamp((sign(dBright) * f.lift) / 10, -6, 6) * Math.min(1, Math.abs(dBright) / 0.15);
  // Contrast: aim for a spread near 0.18.
  const dContrast = 0.18 - a.contrast;
  s += clamp((sign(dContrast) * f.contrast) / 10, -4, 4) * Math.min(1, Math.abs(dContrast) / 0.06);
  // A strong cast is eased, never removed outright (golden light is a feature).
  if (Math.abs(a.warmth) > 0.08) s += clamp((-sign(a.warmth) * f.warm) / 10, -3, 3);
  // Colour: lift muted images, restrain vivid ones.
  if (a.saturation < 0.18) s += clamp(f.colour / 10, -3, 3);
  else if (a.saturation > 0.35) s += clamp(-f.colour / 10, -3, 3);
  s += tagScore(preset, ['natural', 'clean', 'honest'], 1);
  if (preset.tags.includes('featured')) s += 0.5;
  return s;
}

function scoreCinematic(preset: Preset, a: ImageAnalysis): number {
  if (!CINEMATIC_CATS.has(preset.category)) return -Infinity;
  const f = featuresOf(preset);
  if (f.strength < 10 || f.strength > 55) return -Infinity;
  if (f.mono) return -Infinity;

  let s = tagScore(preset, CINEMATIC_PREFER[a.brightnessLabel] ?? [], 3);
  s += tagScore(preset, WARMTH_BONUS[a.warmthLabel] ?? [], 2);
  // Cinematic means depth: reward added contrast and edge falloff.
  s += clamp(f.contrast / 10, -2, 3);
  if (f.vignette > 0) s += 1;
  // Do not bury a photograph that is already dark.
  if (a.brightness < 0.2 && f.lift < -15) s -= 5;
  // Do not pile contrast on an already punchy one.
  if (a.contrastLabel === 'punchy' && f.contrast > 25) s -= 2;
  if (preset.tags.includes('featured')) s += 0.5;
  return s;
}

function scoreCreative(preset: Preset, a: ImageAnalysis): number {
  if (!CREATIVE_CATS.has(preset.category)) return -Infinity;
  const f = featuresOf(preset);
  if (f.strength < 12) return -Infinity;

  let s = tagScore(preset, CREATIVE_PREFER[a.brightnessLabel] ?? [], 3);
  s += tagScore(preset, WARMTH_BONUS[a.warmthLabel] ?? [], 1);
  if (preset.tags.includes('featured')) s += 0.5;
  return s;
}

// ── Distinctness, measured by the engine ─────────────────────────────────────

const chartCache = new Map<string, Uint8Array>();

function chartOf(preset: Preset): Uint8Array {
  let out = chartCache.get(preset.id);
  if (!out) {
    out = renderChart(preset.adjust);
    chartCache.set(preset.id, out);
  }
  return out;
}

/** Mean |Δ| per channel between two presets' renders of the same chart. */
export function lookDistance(a: Preset, b: Preset): number {
  const x = chartOf(a);
  const y = chartOf(b);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

const CANDIDATES = 14;

function pickDistinct(
  presets: readonly Preset[],
  score: (p: Preset) => number,
  chosen: readonly Preset[],
): Preset | null {
  const ranked = presets
    .map((preset) => ({ preset, s: score(preset) }))
    .filter((c) => Number.isFinite(c.s))
    .sort((p, q) => q.s - p.s || (p.preset.id < q.preset.id ? -1 : 1))
    .slice(0, CANDIDATES);
  if (ranked.length === 0) return null;
  if (chosen.length === 0) return ranked[0].preset;

  const gap = (p: Preset) => Math.min(...chosen.map((c) => lookDistance(p, c)));
  const clear = ranked.find((c) => gap(c.preset) >= MIN_DISTINCT);
  if (clear) return clear.preset;
  // Nothing clears the bar: take the most different candidate available.
  return ranked.reduce((best, c) => (gap(c.preset) > gap(best.preset) ? c : best)).preset;
}

// ── Words ────────────────────────────────────────────────────────────────────

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** The knobs a recipe moves furthest, in the editor's own words. */
export function describeChanges(preset: Preset, limit = 4): string {
  const rows = CONTROLS.map((control) => {
    const value = preset.adjust[control.id] ?? IDENTITY[control.id];
    const span = Math.max(Math.abs(control.min), Math.abs(control.max));
    return { control, value, weight: Math.abs(value - IDENTITY[control.id]) / span };
  })
    .filter((row) => row.weight > 0.02)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
  if (rows.length === 0) return 'No knob changes';
  return rows.map((row) => `${row.control.label} ${row.control.format(row.value)}`).join(' · ');
}

function naturalReason(p: Preset, a: ImageAnalysis): string {
  const f = featuresOf(p);
  if (a.brightness < 0.3 && f.lift > 3)
    return `Brightness measured ${pct(a.brightness)}, so this opens the exposure gently.`;
  if (a.brightness > 0.62 && f.lift < -3)
    return `Brightness measured ${pct(a.brightness)}, so this eases the exposure back.`;
  if (a.contrast < 0.1 && f.contrast > 3)
    return `Contrast measured low (${pct(a.contrast)}), so this adds some separation.`;
  if (a.contrast > 0.22 && f.contrast < -3)
    return `Contrast measured high (${pct(a.contrast)}), so this softens it a little.`;
  if (Math.abs(a.warmth) > 0.08 && Math.sign(f.warm) === -Math.sign(a.warmth) && f.warm !== 0)
    return `A ${a.warmthLabel} cast was measured; this eases it without removing it.`;
  if (a.saturation < 0.18 && f.colour > 3)
    return `Colour measured muted (${pct(a.saturation)}), so this brings a little back.`;
  return 'Exposure, contrast and colour measured close to balanced, so this stays subtle.';
}

function cinematicReason(_p: Preset, a: ImageAnalysis): string {
  if (a.brightnessLabel === 'dark') return 'A dark, low-light exposure suits a deep, filmic grade.';
  if (a.warmthLabel === 'warm') return 'The warm tones measured here suit a filmic, contrast-led grade.';
  if (a.warmthLabel === 'cool') return 'The cool cast measured here suits a split-tone, contrast-led grade.';
  if (a.contrastLabel === 'punchy') return 'Existing strong contrast gives a dramatic grade room to work.';
  return 'Adds depth with a contrast-led, film-inspired grade.';
}

function creativeReason(p: Preset, a: ImageAnalysis): string {
  const f = featuresOf(p);
  if (f.mono) return 'Drops colour to put the emphasis on tone and texture.';
  if (p.tags.includes('faded-film') || p.tags.includes('lifted-blacks'))
    return 'A faded, analogue treatment with lifted blacks.';
  if (p.tags.includes('dreamy') || p.tags.includes('pale'))
    return `A soft, pale treatment for a ${a.brightnessLabel} exposure.`;
  if (p.tags.includes('vintage') || p.tags.includes('historical-decade'))
    return 'A vintage colour character from an earlier era.';
  return 'A deliberately stylised look that departs from the original.';
}

// ── Public API ───────────────────────────────────────────────────────────────

export function generateOptions(
  library: PresetLibrary,
  analysis: ImageAnalysis,
): EnhanceOption[] {
  const usable = library.presets.filter(isUsable);
  const chosen: Preset[] = [];
  const options: EnhanceOption[] = [];

  const families: Array<{
    kind: EnhanceKind;
    label: string;
    score: (p: Preset) => number;
    reason: (p: Preset, a: ImageAnalysis) => string;
  }> = [
    { kind: 'natural', label: 'Natural', score: (p) => scoreNatural(p, analysis), reason: naturalReason },
    { kind: 'cinematic', label: 'Cinematic', score: (p) => scoreCinematic(p, analysis), reason: cinematicReason },
    { kind: 'creative', label: 'Creative', score: (p) => scoreCreative(p, analysis), reason: creativeReason },
  ];

  for (const family of families) {
    const preset = pickDistinct(usable, family.score, chosen);
    if (!preset) continue;
    chosen.push(preset);
    options.push({
      kind: family.kind,
      label: family.label,
      preset,
      explanation: family.reason(preset, analysis),
      changes: describeChanges(preset),
      basis: 'rules',
    });
  }
  return options;
}
