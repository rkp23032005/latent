/**
 * A starting intensity, from two sets of numbers already measured.
 *
 * ## The rule, in words
 * A look that the engine measured as doing a great deal to a test chart needs
 * less of itself on a photograph that is already doing that thing. A look that
 * barely moves pixels needs all of it. So the suggestion starts at full strength
 * and is moved back by the things that would double up: a strong look, an already
 * punchy photograph, an already dark photograph under a darkening look, an
 * already vivid photograph under a colour-heavy one.
 *
 * ## What this is not
 * No model was trained for this, and nothing here predicts what the user likes.
 * `explain` returns the arithmetic that was applied, and the interface says
 * "a starting point from measured numbers". Every slider the app already had
 * keeps working, and a value the user moved is never overwritten: this only
 * supplies the number a preview starts on.
 *
 * ## Why it is safe to be simple
 * Intensity is a single linear blend towards identity (`scaleRecipe`), applied to
 * the whole recipe, so one number means one thing for every preset in the
 * library — including the ones imported from LUT files, which were converted to
 * slider recipes when they arrived.
 */

import { IDENTITY, type Adjustments } from '../image/adjustments';
import type { Preset } from '../preset/schema';
import { strengthOf } from '../preset/traits';
import type { ImageAnalysis } from './imageAnalysis';

export type IntensitySuggestion = {
  /** 0–100, in steps of 5, clamped to the range the slider offers. */
  readonly value: number;
  /** The measurements that moved it, so the number can be shown honestly. */
  readonly reason: string;
  /** Every rule that fired, in the order applied. */
  readonly steps: readonly string[];
};

const FULL = 100;
const FLOOR = 20;

const liftOf = (r: Adjustments) => r.exposure * 50 + r.brightness + 0.5 * r.shadows + 0.3 * r.blacks;
const colourOf = (r: Adjustments) => r.saturation + r.vibrance;

export function suggestIntensity(preset: Preset, analysis: ImageAnalysis | null): IntensitySuggestion {
  const recipe: Adjustments = { ...IDENTITY, ...preset.adjust };
  const effect = typeof preset.effect === 'number' ? preset.effect : 0;
  const steps: string[] = [];
  let value = FULL;

  const band = strengthOf(preset.effect);
  if (band === 'very strong') {
    value -= 40;
    steps.push(`measured change ${effect.toFixed(0)} of 255 is very strong`);
  } else if (band === 'strong') {
    value -= 20;
    steps.push(`measured change ${effect.toFixed(0)} of 255 is strong`);
  } else if (band === 'moderate') {
    value -= 5;
    steps.push(`measured change ${effect.toFixed(0)} of 255 is moderate`);
  }

  if (analysis) {
    if (analysis.contrastLabel === 'punchy' && recipe.contrast > 15) {
      value -= 15;
      steps.push('contrast already measured high, and this adds more');
    }
    if (analysis.brightness < 0.24 && liftOf(recipe) < -10) {
      value -= 15;
      steps.push('the photograph is already dark, and this darkens it');
    }
    if (analysis.brightness > 0.66 && liftOf(recipe) > 10) {
      value -= 10;
      steps.push('the photograph is already bright, and this brightens it');
    }
    if (analysis.saturation > 0.34 && colourOf(recipe) > 15) {
      value -= 10;
      steps.push('colour already measured vivid, and this adds more');
    }
    if (Math.abs(analysis.warmth) > 0.08) {
      const cast = analysis.warmth > 0 ? recipe.warmth + recipe.temperature : -(recipe.warmth + recipe.temperature);
      if (cast > 15) {
        value -= 10;
        steps.push(`it pushes further into the ${analysis.warmthLabel} cast that was measured`);
      }
    }
  }

  if (steps.length === 0) steps.push('the look is restrained and the photograph leaves room for it');

  value = Math.max(FLOOR, Math.min(FULL, Math.round(value / 5) * 5));
  return {
    value,
    reason: `${steps.join('; ')}.`,
    steps,
  };
}

/** The line the interface shows beside the slider. */
export function intensityNote(suggestion: IntensitySuggestion): string {
  return `A starting point from measured numbers — ${suggestion.reason} Move the slider whenever you like.`;
}
