/**
 * Finding looks from ordinary language, locally.
 *
 * ## What this is
 * An inverted index over the words the catalogue already uses, plus a ranking
 * rule you can read. Each preset is broken into weighted fields — its name, the
 * tags and category it was imported with, the characteristics derived from its
 * recipe (see traits.ts), the knobs it moves, and its description — and each
 * word points back at the presets that carry it. A search phrase is tokenised
 * the same way and looked up. Nothing is sent anywhere and nothing is learned:
 * the same words give the same order until the catalogue changes.
 *
 * ## Why a word list instead of an embedding
 * There is no model here to ship, run offline, or explain. A vector store would
 * also be unable to say *why* a card appeared, which this project needs for
 * honest labelling. Word matching over real metadata answers the six example
 * searches on its own, so semantic search would add weight without a demonstrated
 * gain. If that ever changes, the seam is `matchPool`.
 *
 * ## The two rules that keep results trustworthy
 * 1. **Every content word must be satisfiable.** A preset missing one of the
 *    words drops out (or into `near`, which the interface labels as a
 *    near-miss). This is why nonsense queries say "nothing matches" instead of
 *    returning five arbitrary looks.
 * 2. **A word that only arrives by synonym counts for less.** The concept table
 *    below maps ordinary language onto words the library genuinely contains —
 *    "sunset" to golden/amber/dusk, because no preset is named after a sunset —
 *    and expanded matches score at a discount, so a preset that literally says
 *    "sunset" would still beat one that merely means it.
 */

import { IDENTITY } from '../image/adjustments';
import { indexById, poolOf, type Query } from './library';
import type { Preset, PresetLibrary } from './schema';
import { traitsOf } from './traits';
import { normalise, tokenize, wordsOf } from './words';

/** Where a word came from, and what a hit there is worth before rarity. */
const FIELD_WEIGHT = {
  name: 9,
  tag: 6,
  category: 6,
  characteristic: 5,
  parameter: 4,
  scene: 3,
  description: 2,
} as const;

type FieldKey = keyof typeof FIELD_WEIGHT;

/**
 * Ordinary words mapped onto vocabulary this catalogue really has.
 *
 * Kept deliberately short and checkable: `search.test.ts` asserts every target
 * appears in at least one preset, so an entry cannot quietly drift into
 * describing a look the library does not contain.
 */
export const CONCEPTS: Readonly<Record<string, readonly string[]>> = {
  sunset: ['dusk', 'twilight', 'golden', 'amber', 'orange', 'warm'],
  sunrise: ['morning', 'golden', 'amber', 'warm'],
  golden: ['amber', 'warm', 'sunlight'],
  moody: ['dark', 'deep', 'dramatic', 'atmospheric', 'low'],
  gloomy: ['dark', 'moody', 'atmospheric', 'gray'],
  dark: ['low', 'deep', 'shadow', 'night'],
  night: ['dark', 'low', 'artificial', 'street', 'lamp'],
  bright: ['airy', 'light', 'open', 'clean', 'high', 'pale'],
  airy: ['bright', 'open', 'light', 'pale'],
  faded: ['washed', 'lifted', 'matte', 'drained', 'pastel', 'print'],
  washed: ['faded', 'drained', 'matte'],
  vintage: ['aged', 'retro', 'classic', 'historical', 'decade', 'newsreel', 'print'],
  retro: ['vintage', 'aged', 'classic'],
  film: ['negative', 'slide', 'reversal', 'grain', 'print'],
  cinematic: ['dramatic', 'film', 'teal', 'moody'],
  movie: ['cinematic', 'dramatic', 'film'],
  portrait: ['skin', 'studio', 'people'],
  people: ['portrait', 'skin'],
  travel: ['geographic', 'cultural', 'place', 'outdoor', 'beach', 'sea', 'sky'],
  landscape: ['nature', 'field', 'outdoor', 'green', 'sky'],
  street: ['urban', 'gritty', 'architecture', 'night'],
  urban: ['street', 'gritty', 'architecture'],
  warm: ['amber', 'golden', 'sunlight', 'temperature'],
  cool: ['cold', 'blue', 'nordic', 'gray'],
  cold: ['cool', 'blue', 'nordic', 'gray'],
  monochrome: ['black', 'white', 'grayscale', 'silver'],
  black: ['white', 'monochrome', 'grayscale'],
  white: ['black', 'monochrome', 'grayscale'],
  color: ['saturation', 'vibrance', 'pastel', 'drained'],
  grain: ['texture', 'pushed'],
  contrast: ['punchy', 'firm', 'hard'],
  dreamy: ['soft', 'hazy', 'glow', 'pale'],
  soft: ['dreamy', 'hazy', 'quiet'],
  pastel: ['faded', 'washed', 'pale', 'quiet'],
  winter: ['snow', 'cold', 'blue', 'festive'],
  summer: ['warm', 'bright', 'light'],
  food: ['product', 'interior', 'warm'],
  video: ['lut', 'motion'],
};

/** Discount for a word that matched only through the concept table. */
const EXPANSION_FACTOR = 0.75;
/** A phrase written exactly as the catalogue writes it is worth more. */
const PHRASE_BONUS = 8;
/** Below this many synonyms a rare word is not three times a common one. */
const MIN_IDF = 0.9;
const MAX_IDF = 3;

type Cell = { weight: number; count: number; fields: number };
type Posting = Map<string, Cell>;

export type SearchIndex = {
  readonly library: PresetLibrary;
  readonly vocab: string[];
  readonly postings: ReadonlyMap<string, Posting>;
  readonly byId: Map<string, Preset>;
  readonly total: number;
};

/** The words of one field, camelCase slugs split so `grainAmount` reads as grain. */
function fieldWords(text: string): string[] {
  const spaced = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  return wordsOf(spaced);
}

/** One preset's contribution to the index: every field, with occurrence counts. */
function fieldsOf(preset: Preset): Record<FieldKey, string[]> {
  const traits = traitsOf(preset);
  return {
    name: fieldWords(preset.name),
    tag: preset.tags.flatMap(fieldWords),
    category: fieldWords(preset.category),
    characteristic: [
      ...traits.visual.map((t) => t.label),
      traits.strength === 'unstated' ? '' : `${traits.strength} change`,
    ].flatMap(fieldWords),
    parameter: [
      ...traits.parameters,
      ...preset.mapped,
      ...Object.keys(preset.adjust).filter((k) => k in IDENTITY),
    ].flatMap(fieldWords),
    scene: traits.scenes.flatMap(fieldWords),
    description: fieldWords(preset.description),
  };
}

function buildIndex(library: PresetLibrary): SearchIndex {
  const postings = new Map<string, Posting>();
  const byId = indexById(library);
  const seen = new Set<string>();
  let total = 0;

  for (const preset of library.presets) {
    if (seen.has(preset.id)) continue;
    seen.add(preset.id);
    total += 1;
    const fields = fieldsOf(preset);
    for (const [field, words] of Object.entries(fields) as Array<[FieldKey, string[]]>) {
      const weight = FIELD_WEIGHT[field];
      const perWord = new Map<string, number>();
      for (const word of words) perWord.set(word, (perWord.get(word) ?? 0) + 1);
      for (const [word, count] of perWord) {
        let cell = postings.get(word)?.get(preset.id);
        if (!cell) {
          const posting = postings.get(word) ?? new Map<string, Cell>();
          postings.set(word, posting);
          cell = { weight: 0, count: 0, fields: 0 };
          posting.set(preset.id, cell);
        }
        // The strongest field carries the score; the rest only nudge it.
        if (weight > cell.weight) cell.weight = weight;
        cell.count = Math.min(6, cell.count + count);
        cell.fields += 1;
      }
    }
  }

  const vocab = [...postings.keys()].sort();
  return { library, vocab, postings, byId, total };
}

const indexCache = new WeakMap<PresetLibrary, SearchIndex>();

/** Built once per catalogue: keystrokes read a cached index, they do not rebuild it. */
export function indexFor(library: PresetLibrary): SearchIndex {
  const known = indexCache.get(library);
  if (known) return known;
  const next = buildIndex(library);
  indexCache.set(library, next);
  return next;
}

/** Words in `vocab` that begin with `prefix`, binary searched. */
function prefixRange(vocab: readonly string[], prefix: string): string[] {
  if (!prefix) return [];
  let lo = lowerBound(vocab, prefix);
  const out: string[] = [];
  while (lo < vocab.length && vocab[lo].startsWith(prefix)) {
    out.push(vocab[lo]);
    lo += 1;
  }
  return out;
}

function lowerBound(vocab: readonly string[], value: string): number {
  let lo = 0;
  let hi = vocab.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (vocab[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 'ies'→'y', 'es' after a sibilant→stem, plain 's'→stem — only for real plurals. */
function stem(word: string): string {
  if (word.length < 4) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * The vocabulary words a query word reaches: itself, its prefix family, and the
 * same for its stem. Short words match exactly, so "sea" cannot summon every
 * word that begins with it.
 *
 * Both candidates go through `normalise` again after stemming, because the
 * spelling table only lists the singular: "colours" stems to "colour", which is
 * the index's "color" — without the second pass a British plural reaches
 * nothing.
 */
export function resolveWord(index: SearchIndex, word: string): string[] {
  if (!word) return [];
  const base = normalise(word);
  if (!base) return [];
  const candidates = base.length > 3 ? [base, normalise(stem(base))] : [base];
  const out = new Set<string>();
  for (const candidate of candidates) {
    if (index.postings.has(candidate)) out.add(candidate);
    if (candidate.length < 4) continue;
    for (const hit of prefixRange(index.vocab, candidate)) {
      out.add(hit);
      if (out.size > 24) break;
    }
  }
  return [...out];
}

function idf(index: SearchIndex, word: string): number {
  const df = index.postings.get(word)?.size ?? 1;
  const raw = 1 + Math.log10((index.total + 1) / (df + 1));
  return Math.min(MAX_IDF, Math.max(MIN_IDF, raw));
}

/** Best score one vocabulary word gives one preset. */
function cellScore(cell: Cell, wordIdf: number, expanded: boolean): number {
  const breadth = 1 + (cell.fields - 1) * 0.4;
  const repetition = 1 + Math.min(3, cell.count - 1) * 0.15;
  const base = cell.weight * breadth * repetition * wordIdf;
  return expanded ? base * EXPANSION_FACTOR : base;
}

export type SearchToken = {
  readonly word: string;
  /** How the word was satisfied: 'literal', 'synonym', or null when unmatched. */
  readonly via: 'literal' | 'synonym' | null;
};

export type SearchMatch = {
  readonly preset: Preset;
  readonly score: number;
  /** Query words this preset satisfies, in the order they were typed. */
  readonly matched: readonly string[];
  /** Query words it does not — empty for a full match. */
  readonly missed: readonly string[];
};

export type SearchOutcome = {
  /** False when the phrase held only filler words, so there is nothing to rank. */
  readonly meaningful: boolean;
  readonly tokens: readonly SearchToken[];
  /** Every content word satisfied. */
  readonly hits: SearchMatch[];
  /** All but one satisfied, for when nothing fully matches. */
  readonly near: SearchMatch[];
};

const EMPTY: SearchOutcome = { meaningful: false, tokens: [], hits: [], near: [] };

/** The same word through the concept table, marked so it can be discounted. */
function expansions(word: string): readonly string[] {
  return CONCEPTS[word] ?? [];
}

function scorePool(index: SearchIndex, pool: ReadonlySet<string>, tokens: readonly string[]) {
  const perPreset = new Map<string, { score: number; matched: Set<string> }>();
  const touched = (id: string) => {
    let entry = perPreset.get(id);
    if (!entry) {
      entry = { score: 0, matched: new Set() };
      perPreset.set(id, entry);
    }
    return entry;
  };

  for (const token of tokens) {
    const literal = resolveWord(index, token);
    const expanded = new Set<string>();
    for (const synonym of expansions(token)) {
      for (const word of resolveWord(index, synonym)) expanded.add(word);
    }

    const tokenBest = new Map<string, { score: number }>();
    const fold = (word: string, isLiteral: boolean) => {
      const posting = index.postings.get(word);
      if (!posting) return;
      const wordIdf = idf(index, word);
      for (const [id, cell] of posting) {
        if (!pool.has(id)) continue;
        const score = cellScore(cell, wordIdf, !isLiteral);
        const current = tokenBest.get(id);
        if (!current || score > current.score) tokenBest.set(id, { score });
      }
    };
    for (const word of literal) fold(word, true);
    for (const word of expanded) if (!literal.includes(word)) fold(word, false);

    for (const [id, best] of tokenBest) {
      const entry = touched(id);
      entry.score += best.score;
      entry.matched.add(token);
    }
  }

  return perPreset;
}

/** A phrase written the way the catalogue writes it is worth a clear bonus. */
function withPhraseBonus(matches: readonly SearchMatch[], phrase: string): SearchMatch[] {
  if (phrase.length < 4) return [...matches];
  return matches.map((match) => {
    const haystack = `${match.preset.name} ${match.preset.category} ${match.preset.tags.join(' ')}`.toLowerCase();
    return haystack.includes(phrase) ? { ...match, score: match.score + PHRASE_BONUS } : match;
  });
}

function collect(
  index: SearchIndex,
  entries: Iterable<[string, { score: number; matched: Set<string> }]>,
  tokens: readonly string[],
): SearchMatch[] {
  const out: SearchMatch[] = [];
  for (const [id, entry] of entries) {
    const preset = index.byId.get(id);
    if (!preset) continue;
    out.push({
      preset,
      score: entry.score,
      matched: tokens.filter((t) => entry.matched.has(t)),
      missed: tokens.filter((t) => !entry.matched.has(t)),
    });
  }
  return out;
}

const byScore = (a: SearchMatch, b: SearchMatch) =>
  b.score - a.score ||
  (b.preset.effect ?? 0) - (a.preset.effect ?? 0) ||
  a.preset.id.localeCompare(b.preset.id);

/**
 * Rank a pool of presets against a phrase.
 *
 * `pool` is whatever the caller is already showing — the usable library, a
 * category, the favourites — so the search never fights a filter.
 */
export function matchPool(
  index: SearchIndex,
  pool: readonly Preset[],
  text: string,
  limit = Number.POSITIVE_INFINITY,
): SearchOutcome {
  const tokens = tokenize(text);
  if (tokens.length === 0) return EMPTY;

  const ids = new Set(pool.map((preset) => preset.id));
  const scored = scorePool(index, ids, tokens);
  const phrase = tokens.join(' ').toLowerCase();

  const full: Array<[string, { score: number; matched: Set<string> }]> = [];
  const partial: Array<[string, { score: number; matched: Set<string> }]> = [];
  for (const [id, entry] of scored) {
    if (entry.matched.size === tokens.length) full.push([id, entry]);
    else if (tokens.length > 1 && entry.matched.size === tokens.length - 1) partial.push([id, entry]);
  }

  const hits = withPhraseBonus(collect(index, full, tokens), phrase)
    .sort(byScore)
    .slice(0, limit);
  const near =
    hits.length === 0
      ? withPhraseBonus(collect(index, partial, tokens), phrase)
          .sort(byScore)
          .slice(0, limit)
      : [];

  const detail: SearchToken[] = tokens.map((word) => {
    const via: SearchToken['via'] =
      resolveWord(index, word).length > 0 ? 'literal' : expansions(word).length > 0 ? 'synonym' : null;
    return { word, via };
  });

  return { meaningful: true, tokens: detail, hits, near };
}

export type RankedResults = {
  readonly presets: Preset[];
  /** The search behind the order, or null when the box holds only filler words. */
  readonly outcome: SearchOutcome | null;
  /** False when these are the closest available matches rather than full ones. */
  readonly exact: boolean;
};

/**
 * The one entry point the interface uses: the browser's own filters choose the
 * pool, the index chooses the order.
 */
export function queryPresets(
  library: PresetLibrary,
  query: Query,
  limit = Number.POSITIVE_INFINITY,
): RankedResults {
  const pool = poolOf(library, query);
  const outcome = matchPool(indexFor(library), pool, query.text);
  if (!outcome.meaningful) return { presets: pool, outcome: null, exact: true };
  const exact = outcome.hits.length > 0;
  const presets = (exact ? outcome.hits : outcome.near).map((match) => match.preset);
  return {
    presets: Number.isFinite(limit) ? presets.slice(0, limit) : presets,
    outcome,
    exact,
  };
}
