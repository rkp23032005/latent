/**
 * Splitting ordinary language into comparable words.
 *
 * Both sides of a search — the catalogue's own metadata and whatever the user
 * types — go through this file, so they meet in one spelling. Everything here is
 * mechanical and testable: lowercase, drop punctuation, drop filler words, and
 * fold the handful of spelling variants this library actually contains onto one
 * canonical word.
 *
 * The UK/US table exists because the shipped catalogue mixes both: descriptions
 * say "colour" (277 presets) while a tag says `color-negative-film` (81). Without
 * folding, a search for "colors" finds nothing in a library full of colour.
 *
 * Plurals and compounds are *not* folded here. Truncating "lens" to "len" costs
 * more than it gains; instead the index resolves a word by prefix, so "colours"
 * reaches "colour" and "grain" reaches "grainy" without damaging either.
 */

/** Words people type around the words they mean. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'any', 'as', 'at', 'be', 'bit', 'but', 'by', 'can', 'come', 'do', 'does',
  'down', 'for', 'from', 'get', 'give', 'in', 'into', 'is', 'it', 'its', 'less', 'like', 'little',
  'make', 'made', 'me', 'more', 'most', 'much', 'my', 'new', 'of', 'on', 'or', 'out',
  'please', 'really', 'show', 'so', 'some', 'than', 'that', 'the', 'their', 'them', 'there',
  'these', 'this', 'to', 'up', 'us', 'use', 'using', 'very', 'want', 'we', 'with', 'you', 'your',
  // words that describe the *act* of editing rather than the look
  'edit', 'editing', 'effect', 'effects', 'filter', 'filters', 'fix', 'look', 'looks', 'preset',
  'presets', 'photo', 'photos', 'photograph', 'photographs', 'picture', 'pictures', 'image',
  'images', 'style', 'styles', 'vibe', 'aesthetic', 'feel',
]);

/** Spelling variants that mean the same thing here, folded onto one form. */
const SPELLING: Readonly<Record<string, string>> = {
  colour: 'color',
  coloured: 'colored',
  favourite: 'favorite',
  flavour: 'flavor',
  grey: 'gray',
  metre: 'meter',
  litre: 'liter',
  centre: 'center',
  organise: 'organize',
};

/** Lowercase, punctuation-free, one canonical spelling. Returns '' for junk. */
export function normalise(word: string): string {
  const owned = /['’]/.test(word);
  const bare = word.toLowerCase().replace(/[^a-z0-9&+]/g, '');
  if (!bare) return '';
  const trimmed = owned && bare.length > 2 && bare.endsWith('s') ? bare.slice(0, -1) : bare;
  return SPELLING[trimmed] ?? trimmed;
}

/** All normalised words in a string, duplicates kept so occurrence counts are real. */
export function wordsOf(text: string): string[] {
  const out: string[] = [];
  // A hyphen or slash separates: `warm-highlight` is the two words the user types.
  for (const raw of text.split(/[^A-Za-z0-9&+]+/)) {
    const w = normalise(raw);
    if (w) out.push(w);
  }
  return out;
}

/**
 * The content words of a search phrase, in order, filler removed.
 *
 * '&' is kept as its own word because "black & white" is a real way to write it
 * and the catalogue uses it; a bare "&" carries no meaning on its own, so the
 * surrounding words do the work and it is dropped.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const w of wordsOf(text)) {
    if (w.length < 2) continue;
    if (/^[&+]+$/.test(w)) continue;
    if (STOPWORDS.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    out.push(w);
  }
  return out;
}

/** A short, readable form of a phrase for the interface: "warm film look". */
export function plainQuery(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
