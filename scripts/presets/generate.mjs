#!/usr/bin/env node
/**
 * Build the original preset collection with the app's own engine.
 *
 * Nothing here is copied from anywhere: every recipe starts as a statement
 * about light — how much of it, how far apart its ends are, which way the
 * balance leans, how much air is left in the blacks — and is then measured by
 * the real pipeline over the fixed test chart. A candidate only reaches the
 * library if it visibly moves pixels, carries a fingerprint no other preset
 * has, and looks measurably different from everything already accepted.
 *
 * Run:    node scripts/presets/generate.mjs
 * Output: .cache/presets/generated.json  ({ presets, summary })
 *
 * Deterministic: one constant seed, jitter hashed per candidate, no clock, no
 * randomness from the environment. Two runs write the same bytes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KNOBS,
  MIN_DISTANCE,
  MIN_EFFECT,
  descriptionFor,
  distanceOf,
  effectOf,
  hashToSeed,
  isAtLeast,
  kebab,
  limitationFor,
  mappedFor,
  metricsSource,
  mulberry32,
  normalizeRecipe,
  ordinalLabel,
  signatureOf,
  useOfficialEffectModule,
} from './generate-lib.mjs';

/* effect.ts is the contract for these numbers, so it is the measurement this
   build uses whenever it loads. Its chart is built while the module initialises
   — if that ever throws (the patch index runs off the end of PATCHES in the
   chart's last column unless it is clamped) the build falls back to the same
   chart on the same pipeline, and the summary says which one was used. */
try {
  const official = await import('../../src/lib/preset/effect.ts');
  if (typeof official.renderChart === 'function') useOfficialEffectModule(official);
} catch {
  /* keep the local copy of the measurement */
}

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

const SEED = 0x5eed1a7c;
const MIN_PER_CATEGORY = 6;
const MAX_PER_CATEGORY = 9;
const TOTAL_FLOOR = 120;

const TIERS = [
  { key: 'soft', scale: 0.5 },
  { key: 'standard', scale: 0.85 },
  { key: 'bold', scale: 1.2 },
];

/* How far a "lean" pushes one knob: variants differ in kind, not only amount. */
const LEAN_DELTA = {
  exposure: 0.15,
  brightness: 8,
  contrast: 12,
  warmth: 12,
  saturation: 10,
  fade: 12,
  toning: 18,
  vignette: 14,
};

/* Per-knob jitter, small enough to keep an archetype's character.
   The Advanced Edit knobs are deliberately jittered by nothing at all: these
   original looks are written in the eight numbers they were designed with, and
   the newer knobs arrive through imported recipes that actually asked for them.
   Listing them at zero keeps the draw order — and therefore every existing
   recipe — exactly as it was. */
const JITTER = {
  exposure: 0.1,
  brightness: 5,
  contrast: 7,
  warmth: 7,
  saturation: 6,
  fade: 6,
  toning: 10,
  vignette: 7,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  grain: 0,
};

const LEAN_WORD = {
  exposure: { 1: 'more light', '-1': 'less light' },
  brightness: { 1: 'raised print', '-1': 'lowered print' },
  contrast: { 1: 'firm contrast', '-1': 'open contrast' },
  warmth: { 1: 'amber lean', '-1': 'cool lean' },
  saturation: { 1: 'charged colour', '-1': 'quiet colour' },
  fade: { 1: 'lifted blacks' },
  toning: { 1: 'warm split', '-1': 'cool split' },
  vignette: { 1: 'deep corners' },
};

const TIER_WORD = { soft: 'understated', bold: 'pushed' };

/**
 * The order a single archetype's twelve candidates are tried in, as
 * [tier, variant] pairs. It is deliberately not tier-major: a look family
 * should reach the shelf as a standard version, a bold one with a lean, a
 * soft one with a different lean — not nine half-strength siblings of one
 * another. Variants: 0 pure, then one lean per remaining index.
 */
const TRY_ORDER = [
  [1, 0],
  [2, 1],
  [0, 2],
  [1, 3],
  [2, 0],
  [0, 1],
  [1, 1],
  [2, 2],
  [0, 0],
  [1, 2],
  [2, 3],
  [0, 3],
];

/* ------------------------------------------------------------------ *
 * The categories. `base` is the standard-tier recipe in slider units; the
 * tiers scale it, the leans push one knob further, the jitter breaks the tie.
 * ------------------------------------------------------------------ */

const CATEGORIES = [
  {
    category: 'Cinematic',
    tags: ['cinematic', 'wide'],
    leans: ['fade', 'vignette', ['toning', 1]],
    archetypes: [
      {
        name: 'Teal Hour',
        tags: ['cool-shadow', 'warm-highlight'],
        base: { exposure: -0.12, contrast: 20, warmth: -8, saturation: -14, fade: 16, toning: 38, vignette: 24 },
      },
      {
        name: 'Night Ledger',
        tags: ['low-key', 'cool-shadow'],
        base: { exposure: -0.45, brightness: -8, contrast: 28, warmth: -14, saturation: -22, fade: 10, toning: 30, vignette: 36 },
      },
      {
        name: 'Slow Pan',
        tags: ['matte', 'quiet-colour'],
        base: { exposure: -0.18, contrast: 12, warmth: 5, saturation: -8, fade: 24, toning: 48, vignette: 14 },
      },
      {
        name: 'Copper Dusk',
        tags: ['warm-highlight', 'amber'],
        base: { exposure: -0.22, contrast: 24, warmth: 16, saturation: -6, fade: 12, toning: 58, vignette: 28 },
      },
      {
        name: 'Interior Rain',
        tags: ['cool-highlight', 'restrained'],
        base: { exposure: -0.35, brightness: 6, contrast: 16, warmth: -18, saturation: -18, fade: 20, toning: -26, vignette: 22 },
      },
    ],
  },
  {
    category: 'Warm',
    tags: ['warm-balance'],
    leans: ['fade', 'vignette', ['toning', 1]],
    archetypes: [
      {
        name: 'Late Field',
        tags: ['golden', 'outdoor'],
        base: { exposure: 0.12, contrast: 12, warmth: 34, saturation: 8, fade: 6, toning: 22, vignette: 8 },
      },
      {
        name: 'Amber Porch',
        tags: ['amber', 'interior'],
        base: { exposure: 0.2, brightness: 7, contrast: 6, warmth: 48, saturation: -8, fade: 12, toning: 34, vignette: 12 },
      },
      {
        name: 'Sun Bleached',
        tags: ['open', 'washed-highlight'],
        base: { exposure: 0.35, contrast: -14, warmth: 38, saturation: -20, fade: 26, toning: 28, vignette: 6 },
      },
      {
        name: 'Hearthlight',
        tags: ['low-key', 'amber'],
        base: { exposure: -0.15, contrast: 22, warmth: 56, saturation: 4, fade: 4, toning: 46, vignette: 20 },
      },
      {
        name: 'Terracotta Wall',
        tags: ['earthy', 'saturated'],
        base: { exposure: 0.05, contrast: 18, warmth: 26, saturation: 20, fade: 4, toning: 12, vignette: 10 },
      },
    ],
  },
  {
    category: 'Cool',
    tags: ['cool-balance'],
    leans: [['toning', -1], 'fade', 'vignette'],
    archetypes: [
      {
        name: 'North Window',
        tags: ['daylight', 'restrained'],
        base: { exposure: 0.12, contrast: 16, warmth: -36, saturation: -12, fade: 8, toning: -28, vignette: 6 },
      },
      {
        name: 'Blue Hour',
        tags: ['twilight', 'deep-shadow'],
        base: { exposure: -0.2, contrast: 22, warmth: -48, saturation: 8, fade: 6, toning: -40, vignette: 16 },
      },
      {
        name: 'Glacier Milk',
        tags: ['high-key', 'pale'],
        base: { exposure: 0.3, contrast: -16, warmth: -28, saturation: -24, fade: 22, toning: -20, vignette: 4 },
      },
      {
        name: 'Cold Ceramic',
        tags: ['clean', 'interior'],
        base: { exposure: 0.15, brightness: 9, contrast: 8, warmth: -54, saturation: -4, fade: 14, toning: -32, vignette: 8 },
      },
      {
        name: 'Sea Fog',
        tags: ['haze', 'quiet-colour'],
        base: { exposure: 0.05, contrast: 6, warmth: -30, saturation: -16, fade: 18, toning: -46, vignette: 12 },
      },
    ],
  },
  {
    category: 'Vintage',
    tags: ['aged-print'],
    leans: ['fade', 'vignette', ['toning', 1]],
    archetypes: [
      {
        name: 'Attic Print',
        tags: ['faded', 'warm-split'],
        base: { exposure: 0.1, contrast: -20, warmth: 24, saturation: -28, fade: 36, toning: 30, vignette: 26 },
      },
      {
        name: 'Faded Postcard',
        tags: ['washed', 'pastel'],
        base: { exposure: 0.25, brightness: 9, contrast: -28, warmth: 16, saturation: -36, fade: 48, toning: 22, vignette: 16 },
      },
      {
        name: 'Oxidised Bracket',
        tags: ['green-cast', 'cool-split'],
        base: { exposure: -0.1, contrast: 10, warmth: -14, saturation: -24, fade: 32, toning: -36, vignette: 30 },
      },
      {
        name: 'Sunday Kitchen',
        tags: ['amber', 'soft-contrast'],
        base: { exposure: 0.15, brightness: 6, contrast: -12, warmth: 36, saturation: -14, fade: 26, toning: 42, vignette: 10 },
      },
      {
        name: 'Sepia Ledger',
        tags: ['sepia-adjacent', 'quiet-colour'],
        base: { exposure: 0.05, contrast: 14, warmth: 30, saturation: -48, fade: 30, toning: 54, vignette: 22 },
      },
    ],
  },
  {
    category: 'Film-inspired',
    tags: ['print-like'],
    leans: ['fade', ['toning', 1], 'vignette'],
    archetypes: [
      {
        name: 'Matte Stock',
        tags: ['matte', 'soft-contrast'],
        base: { exposure: 0.05, contrast: 12, warmth: 8, saturation: -12, fade: 20, toning: 16, vignette: 12 },
      },
      {
        name: 'Cross-Process',
        tags: ['shifted', 'charged-colour'],
        base: { exposure: -0.1, contrast: 32, warmth: -20, saturation: 24, fade: 6, toning: -34, vignette: 10 },
      },
      {
        name: 'Halide Warm',
        tags: ['amber', 'print-density'],
        base: { exposure: 0.15, contrast: 18, warmth: 20, saturation: -6, fade: 12, toning: 30, vignette: 16 },
      },
      {
        name: 'Reversal Sheet',
        tags: ['punchy', 'clean'],
        base: { exposure: 0.2, contrast: 36, warmth: 10, saturation: 16, fade: 4, toning: 10, vignette: 6 },
      },
      {
        name: 'Second Run Print',
        tags: ['lifted-blacks', 'faded'],
        base: { exposure: -0.05, brightness: 9, contrast: -10, warmth: 14, saturation: -20, fade: 28, toning: 36, vignette: 20 },
      },
    ],
  },
  {
    category: 'Portrait',
    tags: ['skin'],
    leans: ['fade', ['saturation', -1], 'vignette'],
    archetypes: [
      {
        name: 'Window Portrait',
        tags: ['soft-light', 'natural'],
        base: { exposure: 0.15, contrast: 8, warmth: 12, saturation: -12, fade: 12, toning: 14, vignette: 10 },
      },
      {
        name: 'Studio Soft',
        tags: ['open-contrast', 'pale-skin'],
        base: { exposure: 0.25, brightness: 5, contrast: -8, warmth: 8, saturation: -18, fade: 20, toning: 8, vignette: 6 },
      },
      {
        name: 'Bronze Skin',
        tags: ['warm-highlight', 'firm'],
        base: { exposure: -0.05, contrast: 16, warmth: 24, saturation: 4, fade: 4, toning: 32, vignette: 14 },
      },
      {
        name: 'Quiet Complexion',
        tags: ['restrained', 'cool-split'],
        base: { exposure: 0.1, contrast: 4, warmth: -6, saturation: -24, fade: 10, toning: -14, vignette: 8 },
      },
      {
        name: 'Backlit Headshot',
        tags: ['backlit', 'airy'],
        base: { exposure: 0.35, contrast: -14, warmth: 16, saturation: -8, fade: 22, toning: 24, vignette: 18 },
      },
    ],
  },
  {
    category: 'Travel',
    tags: ['colour-forward'],
    leans: ['vignette', ['saturation', 1], ['toning', 1]],
    archetypes: [
      {
        name: 'Market Morning',
        tags: ['warm', 'busy-scene'],
        base: { exposure: 0.15, contrast: 24, warmth: 16, saturation: 18, fade: 4, toning: 16, vignette: 14 },
      },
      {
        name: 'Harbour Blue',
        tags: ['cool', 'clean'],
        base: { exposure: 0.05, contrast: 28, warmth: -20, saturation: 12, fade: 6, toning: -26, vignette: 16 },
      },
      {
        name: 'Dust Road',
        tags: ['amber', 'dry'],
        base: { exposure: 0.1, contrast: 20, warmth: 30, saturation: 6, fade: 10, toning: 32, vignette: 12 },
      },
      {
        name: 'High Altitude',
        tags: ['crisp', 'cool-shadow'],
        base: { exposure: -0.15, contrast: 32, warmth: -12, saturation: 22, fade: 4, toning: -18, vignette: 22 },
      },
      {
        name: 'Souvenir Gate',
        tags: ['saturated', 'bright'],
        base: { exposure: 0.2, brightness: 5, contrast: 14, warmth: 6, saturation: 26, fade: 8, toning: 8, vignette: 8 },
      },
    ],
  },
  {
    category: 'Landscape',
    tags: ['outdoor'],
    leans: ['vignette', ['toning', -1], ['contrast', 1]],
    archetypes: [
      {
        name: 'Ridge Line',
        tags: ['structural', 'cool-shadow'],
        base: { exposure: 0.1, contrast: 30, warmth: -10, saturation: 16, fade: 4, toning: -22, vignette: 12 },
      },
      {
        name: 'Valley Haze',
        tags: ['atmospheric', 'open'],
        base: { exposure: 0.25, contrast: 10, warmth: -16, saturation: -12, fade: 26, toning: -32, vignette: 8 },
      },
      {
        name: 'Long Field',
        tags: ['warm-highlight', 'even'],
        base: { exposure: -0.05, contrast: 24, warmth: 12, saturation: 10, fade: 6, toning: 26, vignette: 18 },
      },
      {
        name: 'Storm Light',
        tags: ['low-key', 'dramatic'],
        base: { exposure: -0.3, contrast: 38, warmth: -24, saturation: 6, fade: 8, toning: -36, vignette: 28 },
      },
      {
        name: 'Coastal Noon',
        tags: ['blue-water', 'hard-light'],
        base: { exposure: 0.2, contrast: 26, warmth: -32, saturation: 20, fade: 10, toning: -14, vignette: 10 },
      },
    ],
  },
  {
    category: 'Natural',
    tags: ['restrained'],
    leans: ['fade', ['toning', -1], ['warmth', 1]],
    archetypes: [
      {
        name: 'Even Daylight',
        tags: ['neutral', 'honest'],
        base: { exposure: 0.1, contrast: 12, warmth: 7, saturation: 8, fade: 8, toning: 8 },
      },
      {
        name: 'Undyed Cotton',
        tags: ['quiet-colour', 'cool'],
        base: { exposure: 0.05, contrast: 7, warmth: -10, saturation: -10, fade: 12, toning: -16, vignette: 4 },
      },
      {
        name: 'Kitchen Table',
        tags: ['interior', 'warm'],
        base: { exposure: 0.15, brightness: 5, contrast: 10, warmth: 13, saturation: -5, fade: 10, toning: 12, vignette: 6 },
      },
      {
        name: 'Overcast Honest',
        tags: ['flat-light', 'cool'],
        base: { exposure: 0.2, contrast: 16, warmth: -14, saturation: 5, fade: 14, toning: -20, vignette: 4 },
      },
      {
        name: 'Garden Shade',
        tags: ['green', 'dappled'],
        base: { exposure: -0.1, contrast: 14, warmth: -7, saturation: 14, fade: 5, toning: 14, vignette: 9 },
      },
    ],
  },
  {
    category: 'Moody',
    tags: ['low-key'],
    leans: ['vignette', 'fade', ['saturation', -1]],
    archetypes: [
      {
        name: 'Low Room',
        tags: ['dark', 'cool-shadow'],
        base: { exposure: -0.6, contrast: 26, warmth: -16, saturation: -20, fade: 14, toning: -28, vignette: 44 },
      },
      {
        name: 'Rain Window',
        tags: ['wet', 'desaturated'],
        base: { exposure: -0.4, brightness: -7, contrast: 20, warmth: -24, saturation: -28, fade: 22, toning: -36, vignette: 36 },
      },
      {
        name: 'Ash Interiors',
        tags: ['drained-colour', 'warm-split'],
        base: { exposure: -0.5, contrast: 14, warmth: 7, saturation: -36, fade: 28, toning: 20, vignette: 30 },
      },
      {
        name: 'Blue Gloom',
        tags: ['cold', 'heavy-corner'],
        base: { exposure: -0.7, contrast: 30, warmth: -38, saturation: -14, fade: 12, toning: -44, vignette: 48 },
      },
      {
        name: 'Weight Of Cloud',
        tags: ['contrast', 'stormy'],
        base: { exposure: -0.35, contrast: 36, warmth: -9, saturation: -24, fade: 8, toning: -20, vignette: 38 },
      },
    ],
  },
  {
    category: 'Dreamy',
    tags: ['soft'],
    leans: ['fade', ['toning', 1], ['contrast', -1]],
    archetypes: [
      {
        name: 'Morning Veil',
        tags: ['hazy', 'lifted-blacks'],
        base: { exposure: 0.35, contrast: -24, warmth: 12, saturation: -16, fade: 36, toning: 20, vignette: 8 },
      },
      {
        name: 'Salt Air',
        tags: ['marine', 'pale'],
        base: { exposure: 0.4, brightness: 7, contrast: -28, warmth: -10, saturation: -24, fade: 44, toning: -22, vignette: 6 },
      },
      {
        name: 'Cotton Sleep',
        tags: ['washed', 'warm-split'],
        base: { exposure: 0.25, brightness: 9, contrast: -32, warmth: 18, saturation: -32, fade: 50, toning: 28, vignette: 4 },
      },
      {
        name: 'Bloom Line',
        tags: ['glow', 'amber'],
        base: { exposure: 0.3, contrast: -18, warmth: 26, saturation: 10, fade: 32, toning: 36, vignette: 12 },
      },
      {
        name: 'Far Memory',
        tags: ['cool-split', 'faded'],
        base: { exposure: 0.15, brightness: 5, contrast: -22, warmth: -16, saturation: -20, fade: 40, toning: -32, vignette: 14 },
      },
    ],
  },
  {
    category: 'Editorial',
    tags: ['graphic'],
    leans: [['contrast', 1], ['saturation', -1], 'vignette'],
    archetypes: [
      {
        name: 'Magazine Cover',
        tags: ['crisp', 'front-of-frame'],
        base: { exposure: 0.1, contrast: 40, warmth: 5, saturation: -8, fade: 4, toning: 12, vignette: 8 },
      },
      {
        name: 'Glossy Spread',
        tags: ['bright', 'clean'],
        base: { exposure: 0.2, contrast: 32, warmth: -8, saturation: 12, fade: 6, toning: -14, vignette: 6 },
      },
      {
        name: 'Cold Type',
        tags: ['monochrome-adjacent', 'hard'],
        base: { contrast: 46, warmth: -26, saturation: -18, fade: 8, toning: -24, vignette: 12 },
      },
      {
        name: 'Studio Print',
        tags: ['dense-shadow', 'restrained'],
        base: { exposure: -0.1, contrast: 42, warmth: 12, saturation: -24, fade: 10, toning: 22, vignette: 18 },
      },
      {
        name: 'Split Grey',
        tags: ['drained-colour', 'warm-split'],
        base: { exposure: 0.05, contrast: 50, warmth: 18, saturation: -42, toning: 44, vignette: 10 },
      },
    ],
  },
  {
    category: 'Bright and airy',
    tags: ['high-key'],
    leans: ['fade', ['warmth', 1], ['toning', 1]],
    archetypes: [
      {
        name: 'White Room',
        tags: ['open', 'quiet-colour'],
        base: { exposure: 0.5, contrast: -22, warmth: 9, saturation: -16, fade: 26, toning: 8 },
      },
      {
        name: 'Scandi Light',
        tags: ['pale', 'nordic'],
        base: { exposure: 0.65, brightness: 7, contrast: -26, warmth: 13, saturation: -22, fade: 32, toning: 16, vignette: 4 },
      },
      {
        name: 'Linen Morning',
        tags: ['warm-white', 'soft-contrast'],
        base: { exposure: 0.4, contrast: -18, warmth: 18, saturation: -28, fade: 36, toning: 24, vignette: 6 },
      },
      {
        name: 'Airy Cafe',
        tags: ['interior', 'lifted'],
        base: { exposure: 0.55, brightness: 9, contrast: -30, warmth: 5, saturation: -12, fade: 28, toning: 10, vignette: 8 },
      },
      {
        name: 'High Key Field',
        tags: ['outdoor', 'blown-edge'],
        base: { exposure: 0.8, contrast: -14, warmth: 7, saturation: -20, fade: 18, toning: 18, vignette: 4 },
      },
    ],
  },
  {
    category: 'Street photography',
    tags: ['documentary'],
    leans: ['vignette', 'fade', ['toning', -1]],
    archetypes: [
      {
        name: 'Crosswalk',
        tags: ['gritty', 'cool-shadow'],
        base: { exposure: -0.1, contrast: 32, warmth: -12, saturation: -16, fade: 10, toning: -18, vignette: 26 },
      },
      {
        name: 'Night Market Colour',
        tags: ['artificial-light', 'amber'],
        base: { exposure: -0.25, contrast: 26, warmth: 20, saturation: 12, fade: 8, toning: 32, vignette: 30 },
      },
      {
        name: 'Concrete Grey Green',
        tags: ['drained-colour', 'urban'],
        base: { exposure: 0.05, contrast: 28, warmth: -26, saturation: -32, fade: 14, toning: -30, vignette: 20 },
      },
      {
        name: 'Headlight Warm',
        tags: ['night', 'warm-split'],
        base: { exposure: -0.35, brightness: -5, contrast: 36, warmth: 28, saturation: -10, fade: 12, toning: 40, vignette: 34 },
      },
      {
        name: 'Rooftop Noon',
        tags: ['hard-light', 'crisp'],
        base: { exposure: 0.15, contrast: 42, warmth: 3, saturation: 8, fade: 6, toning: 6, vignette: 14 },
      },
    ],
  },
  {
    category: 'Night photography',
    tags: ['after-dark'],
    leans: ['vignette', 'fade', ['toning', -1]],
    archetypes: [
      {
        name: 'After Hours',
        tags: ['cool-shadow', 'heavy-corner'],
        base: { exposure: -0.8, contrast: 24, warmth: -28, saturation: -18, fade: 22, toning: -36, vignette: 50 },
      },
      {
        name: 'Sodium Vapour',
        tags: ['street-lamp', 'amber'],
        base: { exposure: -0.5, contrast: 30, warmth: 36, saturation: -10, fade: 14, toning: 44, vignette: 42 },
      },
      {
        name: 'Neon Rain',
        tags: ['charged-colour', 'wet'],
        base: { exposure: -0.65, brightness: -7, contrast: 34, warmth: -20, saturation: 22, fade: 18, toning: -28, vignette: 46 },
      },
      {
        name: 'Parking Light',
        tags: ['cold', 'deep-shadow'],
        base: { exposure: -0.9, contrast: 20, warmth: -42, saturation: -28, fade: 28, toning: -46, vignette: 54 },
      },
      {
        name: 'Late Commute',
        tags: ['blue', 'lifted-blacks'],
        base: { exposure: -0.4, contrast: 28, warmth: -32, saturation: 10, fade: 24, toning: -32, vignette: 38 },
      },
    ],
  },
  {
    category: 'Black and white',
    tags: ['monochrome'],
    /* Drained colour is the whole point of the family, so it is set at the
     * engine's floor for every tier and never jittered away from true grey. */
    lock: ['saturation'],
    leans: ['vignette', 'fade', ['toning', -1]],
    archetypes: [
      {
        name: 'Silver Press',
        tags: ['warm-split', 'print-density'],
        base: { exposure: 0.05, contrast: 32, toning: 26, fade: 10, vignette: 12, saturation: -100 },
      },
      {
        name: 'Warm Grey Letter',
        tags: ['amber-grey', 'soft'],
        base: { exposure: 0.1, contrast: 20, warmth: 16, toning: 46, fade: 18, vignette: 10, saturation: -100 },
      },
      {
        name: 'Cold Silver',
        tags: ['cool-split', 'crisp'],
        base: { contrast: 38, warmth: -20, toning: -38, fade: 8, vignette: 16, saturation: -100 },
      },
      {
        name: 'Deep Tone Print',
        tags: ['low-key', 'hard'],
        base: { exposure: -0.25, contrast: 44, toning: 14, fade: 6, vignette: 26, saturation: -100 },
      },
      {
        name: 'Paper Grey',
        tags: ['matte', 'lifted-blacks'],
        base: { exposure: 0.2, brightness: 9, contrast: -14, toning: 30, fade: 36, vignette: 8, saturation: -100 },
      },
      {
        name: 'Ash Grade',
        tags: ['flat', 'cool-split'],
        base: { exposure: -0.1, contrast: 26, toning: -22, fade: 22, vignette: 20, saturation: -100 },
      },
    ],
  },
  {
    category: 'Faded film',
    tags: ['washed'],
    leans: ['fade', ['toning', -1], ['brightness', 1]],
    archetypes: [
      {
        name: 'Washed Summer',
        tags: ['amber', 'lifted-blacks'],
        base: { exposure: 0.3, contrast: -26, warmth: 22, saturation: -30, fade: 54, toning: 32, vignette: 14 },
      },
      {
        name: 'Thrift Store Fade',
        tags: ['pastel', 'cool-split'],
        base: { exposure: 0.2, brightness: 9, contrast: -32, warmth: 10, saturation: -38, fade: 62, toning: -24, vignette: 10 },
      },
      {
        name: 'Sun Faded Drawer',
        tags: ['bleached', 'warm-split'],
        base: { exposure: 0.4, contrast: -22, warmth: 28, saturation: -24, fade: 58, toning: 38, vignette: 6 },
      },
      {
        name: 'Cold Fade',
        tags: ['blue-grey', 'faded'],
        base: { exposure: 0.25, contrast: -20, warmth: -22, saturation: -26, fade: 52, toning: -40, vignette: 12 },
      },
      {
        name: 'Pastel Ghost',
        tags: ['drained-colour', 'matte'],
        base: { exposure: 0.35, brightness: 7, contrast: -28, warmth: 5, saturation: -42, fade: 66, toning: 20, vignette: 8 },
      },
    ],
  },
  {
    category: 'Social media photography',
    tags: ['small-screen'],
    leans: [['saturation', 1], 'vignette', ['toning', 1]],
    archetypes: [
      {
        name: 'Feed Ready',
        tags: ['punchy', 'clean'],
        base: { exposure: 0.25, contrast: 26, warmth: 7, saturation: 24, fade: 6, toning: 12, vignette: 6 },
      },
      {
        name: 'Crisp Square',
        tags: ['cool-shadow', 'sharp-looking'],
        base: { exposure: 0.15, contrast: 34, warmth: -10, saturation: 18, fade: 8, toning: -16, vignette: 8 },
      },
      {
        name: 'Bright Pop',
        tags: ['saturated', 'high-key'],
        base: { exposure: 0.4, brightness: 7, contrast: 20, warmth: 13, saturation: 30, fade: 10, toning: 18, vignette: 4 },
      },
      {
        name: 'Clean Brand',
        tags: ['restrained', 'neutral'],
        base: { exposure: 0.2, contrast: 22, warmth: -16, saturation: 6, fade: 12, toning: -22, vignette: 5 },
      },
      {
        name: 'Warm Scroll',
        tags: ['amber', 'friendly'],
        base: { exposure: 0.3, contrast: 16, warmth: 24, saturation: 20, fade: 14, toning: 28, vignette: 8 },
      },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Candidate construction
 * ------------------------------------------------------------------ */

function leanOf(spec, variantIndex) {
  if (variantIndex === 0) return null;
  return normalizeLean(spec.leans[(variantIndex - 1) % spec.leans.length]);
}

function normalizeLean(entry) {
  return Array.isArray(entry) ? { knob: entry[0], dir: entry[1] } : { knob: entry, dir: 1 };
}

/**
 * One candidate recipe: the archetype scaled to a tier, one knob pushed further
 * by the variant's lean, then a hashed jitter so the looks do not sit on a line.
 * Knobs the category locks (monochrome's saturation, say) take the archetype's
 * own value at every tier and are never jittered.
 */
export function buildRecipe(spec, archetype, archetypeIndex, tierIndex, variantIndex) {
  const tier = TIERS[tierIndex];
  const scaledBase = {};
  for (const [id, base] of Object.entries(archetype.base)) scaledBase[id] = base * tier.scale;
  const values = { ...scaledBase };

  const lean = leanOf(spec, variantIndex);
  if (lean) {
    const dir =
      lean.knob === 'fade' || lean.knob === 'vignette'
        ? 1
        : archetype.base[lean.knob] !== undefined && archetype.base[lean.knob] < 0
          ? -1
          : lean.dir;
    const push = LEAN_DELTA[lean.knob] * dir * (0.6 + 0.3 * tierIndex);
    values[lean.knob] = (values[lean.knob] ?? 0) + push;
  }

  /* The jitter is keyed to the candidate alone, so reordering the loops or
     changing the acceptance caps cannot change a recipe. */
  const key = `${spec.category}|${archetype.name}|${tier.key}|${variantIndex}|${archetypeIndex}`;
  const rand = mulberry32((SEED ^ hashToSeed(key)) >>> 0);
  const locked = new Set(spec.lock ?? []);
  for (const id of KNOBS) {
    /* Drawn for every knob, locked or not, so adding a lock cannot reshuffle
       the jitter of everything else in the recipe. */
    const nudge = (rand() * 2 - 1) * JITTER[id];
    const introduce = rand() < 0.35;
    if (locked.has(id)) continue;
    if (values[id] !== undefined) values[id] += nudge;
    else if (introduce) values[id] = nudge * 0.7;
  }
  for (const id of locked) if (archetype.base[id] !== undefined) values[id] = archetype.base[id];

  return { adjust: normalizeRecipe(values), lean, scaledBase };
}

/**
 * Order the candidates so the first ones tried reach every archetype in the
 * category: round-robin across archetypes, tiers/leans advancing within each.
 */
function candidatesFor(spec) {
  const perArchetype = spec.archetypes.map((archetype, archetypeIndex) =>
    TRY_ORDER.map(([tierIndex, variantIndex]) => ({ spec, archetype, archetypeIndex, tierIndex, variantIndex })),
  );

  /* Round-robin across archetypes, with each archetype's own list rotated by
     its position: the first five visits therefore reach every archetype in the
     category *and* five different tier/lean combinations, rather than the same
     slot of all five. Without the rotation a full shelf collapses onto the
     first two or three archetypes and the rest of the family never appears. */
  const merged = [];
  const seen = new Set();
  const depth = perArchetype[0].length;
  for (let round = 0; round < depth; round++) {
    for (let position = 0; position < perArchetype.length; position++) {
      const plan = perArchetype[position][(round + position) % depth];
      const key = `${plan.archetypeIndex}|${plan.tierIndex}|${plan.variantIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(plan);
    }
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 * Names, tags, presets
 * ------------------------------------------------------------------ */

/**
 * A name says which way this variant leans, but only when the finished recipe
 * really does lean that way — a lean the jitter cancelled out is not worth
 * putting on a card. Otherwise the tier word carries it.
 */
function variantWordFor(lean, adjust, scaledBase) {
  if (!lean) return null;
  const value = adjust[lean.knob];
  if (value === undefined) return null;
  const direction = lean.knob === 'fade' || lean.knob === 'vignette' ? 1 : lean.dir;
  const wentFurther = Math.sign(value) === direction && Math.abs(value) >= Math.abs(scaledBase[lean.knob] ?? 0) + 1;
  if (!wentFurther) return null;
  return LEAN_WORD[lean.knob][String(direction)] ?? LEAN_WORD[lean.knob]['1'];
}

function nameFor(archetype, tierIndex, variantWord, taken) {
  const tierWord = TIER_WORD[TIERS[tierIndex].key];
  const word = variantWord ?? tierWord;
  const root = word ? `${archetype.name} — ${word}` : archetype.name;
  if (!taken.has(root)) return root;
  let count = 2;
  while (taken.has(`${root} ${ordinalLabel(count)}`)) count++;
  return `${root} ${ordinalLabel(count)}`;
}

function tagsFor(spec, archetype, tierIndex, adjust, categoryTag) {
  const tags = [categoryTag, ...archetype.tags];
  const a = adjust;
  if (a.saturation !== undefined && a.saturation <= -95) tags.push('monochrome');
  if (a.fade !== undefined && a.fade >= 35) tags.push('lifted-blacks');
  if (a.vignette !== undefined && a.vignette >= 35) tags.push('heavy-corner');
  if (a.exposure !== undefined && a.exposure <= -0.4) tags.push('low-key');
  if (a.exposure !== undefined && a.exposure >= 0.4) tags.push('high-key');
  if (a.contrast !== undefined && a.contrast >= 34) tags.push('firm-contrast');
  if (a.contrast !== undefined && a.contrast <= -20) tags.push('open-contrast');
  if (a.toning !== undefined && a.toning >= 35) tags.push('warm-highlight');
  if (a.toning !== undefined && a.toning <= -35) tags.push('cool-shadow');
  if (tierIndex === 2) tags.push('strong');
  return [...new Set(tags)];
}

/* ------------------------------------------------------------------ *
 * The build
 * ------------------------------------------------------------------ */

const accepted = [];
const seenSignatures = new Map();
const takenNames = new Set();
const takenIds = new Set();

const rejections = { empty: 0, effect: 0, signature: 0, distance: 0, name: 0 };
const rejectionSamples = [];
let candidatesTried = 0;
let candidatesSkipped = 0;

function note(reason, detail, candidate) {
  rejections[reason] += 1;
  if (rejectionSamples.length < 24) {
    rejectionSamples.push({
      reason,
      candidate: `${candidate.spec.category} / ${candidate.archetype.name} / ${TIERS[candidate.tierIndex].key} / variant ${candidate.variantIndex}`,
      detail,
    });
  }
}

for (const spec of CATEGORIES) {
  const categoryTag = kebab(spec.category);
  const filled = () => accepted.filter((entry) => entry.preset.category === spec.category).length;

  for (const plan of candidatesFor(spec)) {
    if (filled() >= MAX_PER_CATEGORY) {
      candidatesSkipped += 1;
      continue;
    }
    candidatesTried += 1;
    const recipe = buildRecipe(spec, plan.archetype, plan.archetypeIndex, plan.tierIndex, plan.variantIndex);
    const adjust = recipe.adjust;

    if (Object.keys(adjust).length === 0) {
      note('empty', 'every knob quantised back to zero', plan);
      continue;
    }

    const effect = effectOf(adjust);
    if (effect < MIN_EFFECT) {
      note('effect', `measured ${effect.toFixed(2)} — under the ${MIN_EFFECT} floor`, plan);
      continue;
    }

    const signature = signatureOf(adjust);
    if (seenSignatures.has(signature)) {
      note('signature', `same fingerprint as ${seenSignatures.get(signature)}`, plan);
      continue;
    }

    let clash = null;
    for (const entry of accepted) {
      if (!isAtLeast(MIN_DISTANCE, adjust, entry.preset.adjust)) {
        clash = entry;
        break;
      }
    }
    if (clash) {
      note(
        'distance',
        `${distanceOf(adjust, clash.preset.adjust).toFixed(3)} from ${clash.preset.id} — under the ${MIN_DISTANCE} floor`,
        plan,
      );
      continue;
    }

    const word = variantWordFor(recipe.lean, adjust, recipe.scaledBase);
    const name = nameFor(plan.archetype, plan.tierIndex, word, takenNames);
    const id = `gen-${categoryTag}-${kebab(name)}`;
    if (takenNames.has(name) || takenIds.has(id)) {
      note('name', `name or id already used (${id})`, plan);
      continue;
    }

    seenSignatures.set(signature, id);
    takenNames.add(name);
    takenIds.add(id);
    accepted.push({
      preset: {
        id,
        name,
        category: spec.category,
        description: descriptionFor(spec.category, adjust),
        adjust,
        support: 'full',
        origin: 'generated',
        source: {
          sourceId: 'generated',
          licence: 'Latent original',
          origin: 'Built with this app’s own engine',
        },
        mapped: mappedFor(adjust),
        dropped: [],
        ...(limitationFor(adjust) ? { limitation: limitationFor(adjust) } : {}),
        tags: tagsFor(spec, plan.archetype, plan.tierIndex, adjust, categoryTag),
        effect: Math.round(effect * 100) / 100,
      },
      sort: { category: CATEGORIES.indexOf(spec), archetype: plan.archetypeIndex, tier: plan.tierIndex, variant: plan.variantIndex },
      categoryTag,
    });
  }
}

accepted.sort((a, b) =>
  a.sort.category - b.sort.category ||
  a.sort.archetype - b.sort.archetype ||
  a.sort.tier - b.sort.tier ||
  a.sort.variant - b.sort.variant,
);

/* One or two standouts per category, chosen by measured effect and taken from
   different archetypes so the shelf is not one recipe twice. */
for (const spec of CATEGORIES) {
  const categoryTag = kebab(spec.category);
  const entries = accepted.filter((entry) => entry.categoryTag === categoryTag);
  const byEffect = [...entries].sort((a, b) => b.preset.effect - a.preset.effect || (a.preset.id < b.preset.id ? -1 : 1));
  const chosen = [];
  const usedArchetypes = new Set();
  for (const entry of byEffect) {
    if (usedArchetypes.has(entry.sort.archetype)) continue;
    usedArchetypes.add(entry.sort.archetype);
    chosen.push(entry);
    if (chosen.length === 2) break;
  }
  for (const entry of chosen) entry.preset.tags.push('featured');
}

/* ------------------------------------------------------------------ *
 * The file
 * ------------------------------------------------------------------ */

const effects = accepted.map((entry) => entry.preset.effect).sort((a, b) => a - b);
const perCategory = {};
const perCategoryArchetypes = {};
for (const spec of CATEGORIES) {
  const entries = accepted.filter((e) => e.preset.category === spec.category);
  perCategory[spec.category] = entries.length;
  perCategoryArchetypes[spec.category] = new Set(entries.map((e) => e.sort.archetype)).size;
}

let closestPair = { distance: Infinity, pair: null };
for (let i = 0; i < accepted.length; i++) {
  for (let j = i + 1; j < accepted.length; j++) {
    const d = distanceOf(accepted[i].preset.adjust, accepted[j].preset.adjust);
    if (d < closestPair.distance) closestPair = { distance: d, pair: [accepted[i].preset.id, accepted[j].preset.id] };
  }
}

const summary = {
  generator: 'scripts/presets/generate.mjs',
  seed: SEED,
  measurement: metricsSource,
  thresholds: {
    minEffect: MIN_EFFECT,
    minDistance: MIN_DISTANCE,
    minPerCategory: MIN_PER_CATEGORY,
    maxPerCategory: MAX_PER_CATEGORY,
    totalFloor: TOTAL_FLOOR,
  },
  candidatesTried,
  candidatesSkippedOnceCategoryFull: candidatesSkipped,
  accepted: accepted.length,
  rejected: rejections,
  rejectedTotal: Object.values(rejections).reduce((n, v) => n + v, 0),
  rejectionSamples,
  perCategory,
  /* Rule 1 is about tone, not volume: a category whose nine looks all came from
     two archetypes would be one recipe at many strengths. These two fields say
     how many archetypes actually reached the shelf. */
  archetypesReachedPerCategory: perCategoryArchetypes,
  categoriesWithThinFamilies: Object.entries(perCategoryArchetypes)
    .filter(([, count]) => count < 4)
    .map(([name, count]) => `${name}: ${count}`),
  categoriesShort: Object.entries(perCategory)
    .filter(([, count]) => count < MIN_PER_CATEGORY)
    .map(([name, count]) => `${name}: ${count}`),
  effect: {
    min: effects[0],
    median: effects[Math.floor(effects.length / 2)],
    max: effects[effects.length - 1],
  },
  closestAcceptedPair: {
    distance: Math.round(closestPair.distance * 10000) / 10000,
    ids: closestPair.pair,
  },
};

const payload = { presets: accepted.map((entry) => entry.preset), summary };

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', '.cache', 'presets', 'generated.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);
console.log('Generated preset library');
line('measurement source', metricsSource);
line('candidates tried', candidatesTried);
line('accepted', accepted.length);
line('skipped (category already full)', candidatesSkipped);
line('rejected: effect', rejections.effect);
line('rejected: distance', rejections.distance);
line('rejected: signature', rejections.signature);
line('rejected: empty recipe', rejections.empty);
line('rejected: name clash', rejections.name);
line('effect min / median / max', `${summary.effect.min} / ${summary.effect.median} / ${summary.effect.max}`);
line('closest accepted pair', `${summary.closestAcceptedPair.distance} (${(summary.closestAcceptedPair.ids ?? []).join(' vs ')})`);
for (const spec of CATEGORIES) line(spec.category, `${perCategory[spec.category]} looks from ${perCategoryArchetypes[spec.category]} families`);
console.log(`\nwrote ${out}`);
