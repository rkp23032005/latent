/**
 * What a preset does, read out of the numbers it already carries.
 *
 * The catalogue ships a recipe (sixteen knobs in slider units), a measured
 * `effect` (mean absolute change per channel on the test chart), the tags and
 * category the import gave it, and the settings the source asked for. That is
 * already metadata — it is just written in the engine's own dialect, so nobody
 * searching for "faded" or "black and white" can see that a recipe with
 * `fade +38, blacks +22` *is* a faded look.
 *
 * This module translates. Every trait below is a threshold on a real value in
 * the preset, and every scene type is a word the preset's own tags or category
 * already use. Nothing here measures a photograph, tests a camera, or certifies
 * that a look suits a subject: a scene label is "this preset calls itself a
 * portrait look", not "verified for portraits", and it is described that way
 * wherever the interface shows it. Compatibility claims would need a test we
 * have not run, so we do not make them.
 *
 * The catalogue file itself is untouched — derived views belong next to the
 * reader, not inside the shipped artifact.
 */

import { CONTROLS, IDENTITY, type AdjustmentId, type Adjustments } from '../image/adjustments';
import { wordsOf } from './words';
import type { Preset } from './schema';

/** A quality the recipe demonstrably has, and how far it goes. */
export type VisualTrait = {
  /** Stable slug, used for matching and for `More Like This`. */
  readonly id: string;
  /** Ordinary words for the interface, e.g. "faded". */
  readonly label: string;
  /** 0–100 in slider units, or the measured chart change where the trait uses it. */
  readonly magnitude: number;
};

export type PresetTraits = {
  /** What the recipe visibly does, strongest first. */
  readonly visual: readonly VisualTrait[];
  /** Subjects the preset's own category and tags name — self-described, not tested. */
  readonly scenes: readonly string[];
  /** Knob labels the recipe moves, in the editor's words. */
  readonly parameters: readonly string[];
  /** How far the look reaches, from the engine's measurement of it. */
  readonly strength: StrengthBand;
  /** The measured chart change, when the catalogue states it. */
  readonly effect: number | null;
  /** One honest line: what these labels are, and what they are not. */
  readonly provenance: string;
};

export type StrengthBand = 'minimal' | 'subtle' | 'moderate' | 'strong' | 'very strong' | 'unstated';

/** Bands of the engine's own measurement (mean |Δ| per channel, 0–255). */
export function strengthOf(effect: number | undefined): StrengthBand {
  if (typeof effect !== 'number' || !Number.isFinite(effect)) return 'unstated';
  if (effect < 2) return 'minimal';
  if (effect < 8) return 'subtle';
  if (effect < 20) return 'moderate';
  if (effect < 35) return 'strong';
  return 'very strong';
}

/**
 * Words the catalogue's own tags and categories use for a subject. Only terms
 * that already appear in the shipped library are listed, so a scene label can
 * always be traced back to the preset's paperwork. Keys are single normalised
 * words — the same form `wordsOf` produces from a slug like `pale-skin`.
 */
const SCENE_WORDS: readonly [readonly string[], readonly string[]][] = [
  [['portrait', 'pale', 'skin', 'people'], ['portrait', 'people']],
  [['landscape', 'outdoor'], ['landscape', 'outdoors']],
  [['travel', 'geographic', 'cultural'], ['travel', 'place']],
  [['night', 'artificial', 'lamp'], ['night', 'low light']],
  [['street', 'urban', 'gritty'], ['street', 'urban']],
  [['marine', 'seaside', 'water', 'beach'], ['seaside', 'water']],
  [['interior'], ['interior']],
  [['seasonal', 'holiday'], ['seasonal']],
  [['editorial'], ['editorial']],
  [['social', 'mobile'], ['small screen']],
  [['video', 'lut'], ['video']],
  [['monochrome', 'black', 'white', 'gray'], ['monochrome']],
  [['negative', 'slide', 'polaroid', 'process'], ['film']],
  [['vintage', 'decade', 'historical', 'retro'], ['vintage']],
  [['photographer'], ['named photographer']],
  [['genre'], ['by genre']],
  [['foliage', 'dappled'], ['foliage']],
];

const clamp100 = (v: number) => Math.min(100, Math.max(0, Math.round(v)));

/** Net lightening (+) or darkening (−) of a recipe, roughly in slider units. */
function liftOf(r: Adjustments): number {
  return r.exposure * 50 + r.brightness + 0.5 * r.shadows + 0.3 * r.blacks;
}

/** Net warming (+) or cooling (−). */
function warmOf(r: Adjustments): number {
  return r.warmth + r.temperature;
}

/** Net colour added (+) or drained (−). */
function colourOf(r: Adjustments): number {
  return r.saturation + r.vibrance;
}

/**
 * The recipe read as plain words. Thresholds are deliberately generous: a knob
 * moved by two points is not a visible character, so it is not claimed as one.
 */
function visualOf(r: Adjustments, effect: number | undefined): VisualTrait[] {
  const out: VisualTrait[] = [];
  const push = (id: string, label: string, magnitude: number) =>
    out.push({ id, label, magnitude: clamp100(magnitude) });

  if (r.saturation <= -80) push('monochrome', 'black and white', Math.abs(r.saturation));
  else if (colourOf(r) >= 24) push('saturated', 'rich colour', colourOf(r));
  else if (colourOf(r) <= -24) push('muted', 'muted colour', Math.abs(colourOf(r)));

  if (warmOf(r) >= 10) push('warm', 'warm', warmOf(r));
  else if (warmOf(r) <= -10) push('cool', 'cool', Math.abs(warmOf(r)));

  if (r.contrast >= 16) push('contrasty', 'high contrast', r.contrast);
  else if (r.contrast <= -16) push('flat', 'low contrast', Math.abs(r.contrast));

  if (r.fade >= 12 || r.blacks >= 14) push('faded', 'faded', Math.max(r.fade, r.blacks));
  if (r.grain >= 8) push('grainy', 'grain', r.grain);
  if (r.vignette >= 8) push('vignetted', 'darkened edges', r.vignette);
  if (Math.abs(r.toning) >= 14) push('toned', 'colour cast', Math.abs(r.toning));
  if (Math.abs(r.tint) >= 14) push('tinted', 'green or magenta shift', Math.abs(r.tint));

  const lift = liftOf(r);
  if (lift >= 16) push('bright', 'brightened', lift);
  else if (lift <= -16) push('dark', 'darkened', Math.abs(lift));

  if (r.highlights >= 24 || r.shadows >= 24) push('open', 'open tones', Math.max(r.highlights, r.shadows));
  else if (r.highlights <= -24 || r.shadows <= -24) push('deep', 'deep tones', Math.abs(Math.min(r.highlights, r.shadows)));

  if (typeof effect === 'number' && effect < 2 && out.length === 0) push('near-identity', 'barely changes', effect);
  return out.sort((a, b) => b.magnitude - a.magnitude);
}

function scenesOf(preset: Preset): string[] {
  // Tags are slugs, and `wordsOf` already splits them: `black-and-white` puts
  // `black` and `white` in the haystack alongside the phrase's other words.
  const haystack = new Set<string>();
  for (const text of [...preset.tags, preset.category, preset.name]) {
    for (const word of wordsOf(text)) haystack.add(word);
  }

  const out: string[] = [];
  for (const [keys, labels] of SCENE_WORDS) {
    if (keys.some((k) => haystack.has(k))) out.push(...labels);
  }
  return [...new Set(out)];
}

function parametersOf(preset: Preset): string[] {
  return CONTROLS.filter((control) => {
    const value = preset.adjust[control.id as AdjustmentId];
    return typeof value === 'number' && value !== IDENTITY[control.id as AdjustmentId];
  }).map((control) => control.label);
}

const traitsByPreset = new WeakMap<Preset, PresetTraits>();

/** The derived view of one preset, built once and cached against the object. */
export function traitsOf(preset: Preset): PresetTraits {
  const known = traitsByPreset.get(preset);
  if (known) return known;
  const recipe: Adjustments = { ...IDENTITY, ...preset.adjust };
  const visual = visualOf(recipe, preset.effect);
  const scenes = scenesOf(preset);
  const parameters = parametersOf(preset);
  const strength = strengthOf(preset.effect);
  const effect = typeof preset.effect === 'number' && Number.isFinite(preset.effect) ? preset.effect : null;
  const next: PresetTraits = {
    visual,
    scenes,
    parameters,
    strength,
    effect,
    provenance:
      'Characteristics and parameters are read from this preset’s own recipe and from the change the engine measured on its test chart. Scene types are subjects the preset names in its own category and tags — a look calling itself a portrait look is not a test that it suits one.',
  };
  traitsByPreset.set(preset, next);
  return next;
}

/** The strongest thing about a look, in words a card can show. */
export function traitSummary(preset: Preset): string {
  const t = traitsOf(preset);
  const head = t.visual.slice(0, 3).map((trait) => trait.label);
  if (t.strength !== 'unstated') head.push(`${t.strength} change`);
  return head.length > 0 ? head.join(' · ') : 'No visible character';
}

/** Every knob the recipe moves, formatted the way the manual controls do. */
export function parameterSummary(preset: Preset): string {
  const t = traitsOf(preset);
  return t.parameters.length > 0 ? t.parameters.join(' · ') : 'Moves no knob';
}
