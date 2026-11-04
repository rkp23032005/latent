/**
 * Preset suggestions, and why each one is on the list.
 *
 * Three things can put a preset in front of the user, and they are not the same
 * kind of claim:
 *
 * - **search** — the preset satisfies the words that were typed. The words are
 *   matched by the same local index the look browser uses (see
 *   `preset/search.ts`), so the box and the assistant cannot disagree.
 * - **image** — the preset's own metadata lines up with measurements taken from
 *   this photograph. Those measurements are brightness, contrast, colour cast and
 *   saturation over a 64×64 sample: numbers, not predictions, and no classifier
 *   decided what the picture is.
 * - **personal** — the user kept it, used it, or asked in those words before.
 *   This says nothing about the photograph and is labelled as the user's own
 *   history, never as a better result.
 *
 * Every suggestion carries which of those it is, and the reason text follows from
 * it. Nothing here is a trained model, nothing leaves the browser, and every
 * suggestion is a preset that exists in the library.
 *
 * ## What this will not do
 * Return five arbitrary looks because it was asked for five. A query whose words
 * the catalogue does not hold produces nothing, and the interface says so. The
 * scoring is deterministic for the same inputs and does not learn.
 */

import { sampleDistance } from '../preset/effect';
import { isUsable } from '../preset/library';
import { indexFor, matchPool } from '../preset/search';
import { traitsOf } from '../preset/traits';
import type { Preset, PresetLibrary } from '../preset/schema';
import type { ImageAnalysis } from './imageAnalysis';

export type SuggestionBasis = 'search' | 'image' | 'personal';

export type Suggestion = {
  readonly preset: Preset;
  readonly score: number;
  /** One sentence, in the register of its `basis`. */
  readonly reason: string;
  readonly basis: SuggestionBasis;
  /** What the look does, read off its own recipe. */
  readonly traits: string;
};

export type SuggestionContext = {
  readonly query?: string;
  readonly analysis?: ImageAnalysis | null;
  readonly favourites?: readonly string[];
  readonly recent?: readonly string[];
  readonly styles?: readonly string[];
  readonly limit?: number;
};

const DEFAULT_LIMIT = 5;

// ── Signals from the photograph's measurements ───────────────────────────────

const BRIGHTNESS_TAGS: Record<string, readonly string[]> = {
  dark:       ['low-key', 'night', 'night-photography', 'deep-shadow', 'dense-shadow', 'dark'],
  mid:        ['natural', 'honest', 'neutral', 'clean', 'soft'],
  bright:     ['bright-and-airy', 'high-key', 'outdoor', 'bright'],
  'high-key': ['high-key', 'bright-and-airy', 'blown-edge', 'pale'],
};

const CONTRAST_TAGS: Record<string, readonly string[]> = {
  flat:   ['lifted-blacks', 'faded-film', 'matte', 'open-contrast'],
  soft:   ['open-contrast', 'dreamy', 'hazy', 'restrained', 'quiet-colour'],
  normal: ['natural', 'clean', 'honest', 'neutral'],
  punchy: ['firm-contrast', 'firm', 'punchy', 'structural', 'dramatic'],
};

const WARMTH_TAGS: Record<string, readonly string[]> = {
  cool:    ['cool-shadow', 'cool', 'cool-split', 'blue-grey', 'nordic'],
  neutral: ['neutral', 'natural', 'honest', 'clean'],
  warm:    ['warm-highlight', 'amber', 'warm', 'warm-split', 'golden', 'earthy'],
};

const SATURATION_TAGS: Record<string, readonly string[]> = {
  desaturated: ['monochrome', 'black-and-white', 'black-white-film', 'drained-colour', 'monochrome-adjacent'],
  muted:       ['quiet-colour', 'restrained', 'washed', 'pale', 'faded'],
  natural:     ['natural', 'honest', 'clean', 'neutral'],
  vivid:       ['saturated', 'charged-colour', 'punchy', 'firm-contrast'],
};

const SCENE_CATEGORY_MAP: Record<string, readonly string[]> = {
  'night or low-light scene':      ['Night photography', 'Cinematic', 'Moody'],
  'outdoor daylight':              ['Landscape', 'Travel', 'Bright and airy', 'Natural', 'Warm'],
  'studio or high-key portrait':   ['Portrait', 'Bright and airy', 'Natural'],
  'overcast or urban scene':       ['Street photography', 'Cinematic', 'Editorial', 'Cool'],
  'landscape or nature':           ['Landscape', 'Natural', 'Travel', 'Seasonal'],
  'monochrome or near-monochrome': ['Black and white', 'Black and white film', 'Alternative processes'],
  'golden hour or travel':         ['Travel', 'Warm', 'Cinematic', 'Landscape'],
  'general photography':           ['Natural', 'Colour negative film', 'Film-inspired'],
};

const has = (preset: Preset, tags: readonly string[], weight: number): number => {
  const own = new Set(preset.tags);
  let score = 0;
  for (const tag of tags) if (own.has(tag)) score += weight;
  return score;
};

/** What the photograph's measurements say about this recipe. */
function imageScore(preset: Preset, a: ImageAnalysis): number {
  let s = 0;
  s += has(preset, BRIGHTNESS_TAGS[a.brightnessLabel] ?? [], 3);
  s += has(preset, CONTRAST_TAGS[a.contrastLabel] ?? [], 2);
  s += has(preset, WARMTH_TAGS[a.warmthLabel] ?? [], 3);
  s += has(preset, SATURATION_TAGS[a.saturationLabel] ?? [], 3);
  for (const hint of a.sceneHints) {
    if ((SCENE_CATEGORY_MAP[hint] ?? []).includes(preset.category)) s += 2;
  }
  // A look the engine measured as barely doing anything is not a suggestion.
  const traits = traitsOf(preset);
  if (traits.strength === 'minimal') s -= 4;
  if (traits.strength === 'very strong' && a.contrastLabel === 'punchy') s -= 2;
  if (traits.visual.some((t) => t.id === 'monochrome') && a.saturationLabel === 'vivid') s -= 1;
  return s;
}

const IMAGE_FLOOR = 5;

// ── Wording ──────────────────────────────────────────────────────────────────

function searchReason(preset: Preset, query: string, matched: readonly string[]): string {
  const words = matched.length > 0 ? matched.join(', ') : query.trim();
  const trait = traitsOf(preset).visual[0]?.label;
  return `Its own metadata carries ${words}${trait ? `, and it is a ${trait} look` : ''}.`;
}

function imageReason(preset: Preset, a: ImageAnalysis): string {
  const traits = traitsOf(preset);
  const mono = traits.visual.some((t) => t.id === 'monochrome');
  if (mono && a.saturationLabel === 'desaturated') {
    return `Colour measured ${Math.round(a.saturation * 100)}%, and this look is already monochrome.`;
  }
  if (a.brightnessLabel === 'dark' && traits.visual.some((t) => t.id === 'dark')) {
    return `Brightness measured ${Math.round(a.brightness * 100)}%; this keeps to the low end.`;
  }
  if (a.brightnessLabel !== 'dark' && traits.visual.some((t) => t.id === 'bright')) {
    return `Brightness measured ${Math.round(a.brightness * 100)}%; this lifts the mid-tones.`;
  }
  if (a.warmthLabel === 'warm' && traits.visual.some((t) => t.id === 'warm')) {
    return `A warm cast was measured, and this works with warm tones.`;
  }
  if (a.warmthLabel === 'cool' && traits.visual.some((t) => t.id === 'cool')) {
    return `A cool cast was measured, and this works with cool tones.`;
  }
  if (a.contrastLabel === 'flat' && traits.visual.some((t) => t.id === 'contrasty')) {
    return `Contrast measured flat (${Math.round(a.contrast * 100)}%); this adds separation.`;
  }
  return `Matches what was measured — ${a.brightnessLabel} exposure, ${a.contrastLabel} contrast, ${a.warmthLabel} cast.`;
}

function personalReason(preset: Preset, personal: { favourite: boolean; used: boolean; style: string | null }): string {
  if (personal.favourite) return `You kept “${preset.name}” as a favourite.`;
  if (personal.used) return `You have used “${preset.name}” recently.`;
  return `Close to the styles you ask for${personal.style ? ` — lately “${personal.style}”` : ''}.`;
}

// ── Ranking ──────────────────────────────────────────────────────────────────

export function suggestPresets(library: PresetLibrary, ctx: SuggestionContext = {}): Suggestion[] {
  const limit = ctx.limit ?? DEFAULT_LIMIT;
  const query = (ctx.query ?? '').trim();
  const analysis = ctx.analysis ?? null;
  const favourites = new Set(ctx.favourites ?? []);
  const recent = new Set(ctx.recent ?? []);
  const styles = ctx.styles ?? [];
  const pool = library.presets.filter(isUsable);

  /** Search hits, by id, with the words each one satisfied. */
  const searched = new Map<string, { score: number; matched: readonly string[] }>();
  let usingNear = false;
  if (query) {
    const outcome = matchPool(indexFor(library), pool, query);
    for (const hit of outcome.hits) searched.set(hit.preset.id, { score: hit.score, matched: hit.matched });
    if (searched.size === 0) {
      usingNear = true;
      for (const hit of outcome.near) searched.set(hit.preset.id, { score: hit.score, matched: hit.matched });
    }
    if (searched.size === 0) return [];
  }

  const rows = pool
    .map((preset) => {
      const hit = searched.get(preset.id);
      const search = hit ? hit.score : 0;
      const image = analysis ? imageScore(preset, analysis) : 0;
      const styleMatch = styles.some((s) => preset.name.toLowerCase().includes(s.toLowerCase()));
      const personal =
        (favourites.has(preset.id) ? 6 : 0) + (recent.has(preset.id) ? 4 : 0) + (styleMatch ? 2 : 0);

      let basis: SuggestionBasis = 'image';
      if (query) basis = 'search';
      else if (personal > 0 && personal >= image) basis = 'personal';

      const score = search + image + personal;
      if (!query && image < IMAGE_FLOOR && personal === 0) return null;
      // Words first: a query means the preset has to satisfy them.
      if (query && !hit) return null;
      return { preset, score, basis, hit, image, personal };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.score - a.score || a.preset.id.localeCompare(b.preset.id));

  // At most two looks from one family, so five cards are not five variants.
  const perCategory = new Map<string, number>();
  const picked: typeof rows = [];
  for (const row of rows) {
    if (picked.length >= limit) break;
    const n = perCategory.get(row.preset.category) ?? 0;
    if (n < 2) {
      perCategory.set(row.preset.category, n + 1);
      picked.push(row);
    }
  }
  for (const row of rows) {
    if (picked.length >= limit) break;
    if (!picked.includes(row)) picked.push(row);
  }

  return picked.map((row) => {
    const preset = row.preset;
    const reason =
      row.basis === 'search'
        ? searchReason(preset, query, row.hit?.matched ?? [])
        : row.basis === 'personal'
          ? personalReason(preset, {
              favourite: favourites.has(preset.id),
              used: recent.has(preset.id),
              style: styles[0] ?? null,
            })
          : imageReason(preset, analysis as ImageAnalysis);
    return {
      preset,
      score: row.score,
      reason: usingNear ? `${reason} (closest match — not every word fits)` : reason,
      basis: row.basis,
      traits: traitsOf(preset).visual.slice(0, 3).map((t) => t.label).join(' · ') || 'no strong character',
    };
  });
}

/**
 * Looks the engine measures as similar to this one.
 *
 * "Similar" is a number, not a guess: the mean absolute difference between the
 * two recipes' renders of the test chart — the same measurement the catalogue's
 * `effect` field is built from, read on a sample a third of each edge so that one
 * look against the whole library takes 0.65 seconds rather than five (see
 * `sampleDistance` in `preset/effect.ts`, which records how far the sample's
 * answer can stray from the full chart's: under a hundredth of a pixel value).
 * Neighbours are the closest of those, over the whole usable library.
 *
 * Narrowing the field by how far the *sliders* are, before rendering anything,
 * was tried and rejected: it changed which four looks came back. Coarser paper
 * costs a little precision; skipping the render costs the claim.
 */
export function similarPresets(library: PresetLibrary, preset: Preset, limit = 4): Preset[] {
  const pool = library.presets.filter((p) => isUsable(p) && p.id !== preset.id);
  return pool
    .map((candidate) => ({ candidate, gap: sampleDistance(preset.adjust, candidate.adjust) }))
    .sort((a, b) => a.gap - b.gap || a.candidate.id.localeCompare(b.candidate.id))
    .slice(0, limit)
    .map((row) => row.candidate);
}
