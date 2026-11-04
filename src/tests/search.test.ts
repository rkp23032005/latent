/**
 * Preset discovery — §1, §2 and the honest half of §7.
 *
 * The claim under test is narrow and absolute: a search returns real presets from
 * the shipped catalogue, ranked by the catalogue's own words, and returns
 * *nothing* rather than something invented when the words do not fit. Every
 * result is therefore checked back against the library by id.
 *
 * The phrases are the ones the brief asked for, verbatim.
 */

import { describe, expect, it } from 'vitest';
import { CONCEPTS, indexFor, queryPresets, resolveWord } from '../lib/preset/search';
import { isUsable, poolOf, type Query } from '../lib/preset/library';
import { parameterSummary, strengthOf, traitsOf, traitSummary } from '../lib/preset/traits';
import type { Preset, PresetLibrary } from '../lib/preset/schema';
import { library } from './helpers';

const asked = (text: string, over: Partial<Query> = {}): Query => ({
  text,
  category: null,
  tab: 'all',
  favourites: [],
  recent: [],
  collections: {},
  collection: null,
  ...over,
});

/** Every id in the catalogue, so "is this a real preset?" has one answer. */
const realIds = new Set(library.presets.map((preset) => preset.id));

const find = (id: string): Preset => {
  const preset = library.presets.find((item) => item.id === id);
  if (!preset) throw new Error(`${id} is not in the catalogue`);
  return preset;
};

const SPEC_PHRASES = [
  'Warm film look.',
  'Natural portrait.',
  'Moody night photography.',
  'Bright travel photo.',
  'Cinematic sunset.',
  'Faded vintage colours.',
];

describe('natural-language preset search', () => {
  it.each(SPEC_PHRASES)('“%s” returns presets that exist in the catalogue', (text) => {
    const { presets, exact } = queryPresets(library, asked(text));
    expect(presets.length).toBeGreaterThan(0);
    expect(exact).toBe(true);
    for (const preset of presets) {
      expect(realIds.has(preset.id)).toBe(true);
      expect(isUsable(preset)).toBe(true);
    }
  });

  it('orders “Moody night photography” by the night looks', () => {
    const { presets } = queryPresets(library, asked('Moody night photography.'));
    expect(presets[0]?.category).toBe('Night photography');
    expect(presets.slice(0, 4).every((preset) => preset.category === 'Night photography')).toBe(true);
  });

  it('finds the portrait looks for “Natural portrait”', () => {
    const { presets } = queryPresets(library, asked('Natural portrait.'));
    expect(presets.some((preset) => preset.tags.includes('portrait'))).toBe(true);
    expect(presets.every((preset) => realIds.has(preset.id))).toBe(true);
  });

  it('treats the British and American spellings as one word', () => {
    const british = queryPresets(library, asked('Faded vintage colours')).presets;
    const american = queryPresets(library, asked('Faded vintage colors')).presets;
    expect(british.length).toBeGreaterThan(0);
    expect(british.map((p) => p.id)).toEqual(american.map((p) => p.id));
  });

  it('ignores filler, so “warm film look” and “warm film” agree', () => {
    const withFiller = queryPresets(library, asked('warm film look')).presets.map((p) => p.id);
    const without = queryPresets(library, asked('warm film')).presets.map((p) => p.id);
    expect(withFiller).toEqual(without);
  });

  it('reaches a plural through the stem, not by luck', () => {
    const index = indexFor(library);
    expect(resolveWord(index, 'colours').length).toBeGreaterThan(0);
    expect(resolveWord(index, 'shadows').length).toBeGreaterThan(0);
  });

  it('returns nothing for a word the catalogue does not use', () => {
    const { presets, outcome } = queryPresets(library, asked('periglaciar zzzz'));
    expect(presets).toHaveLength(0);
    expect(outcome?.tokens.every((token) => token.via === null)).toBe(true);
  });

  it('labels a partial match instead of passing it off as one', () => {
    const { presets, exact, outcome } = queryPresets(library, asked('warm zebra'));
    expect(exact).toBe(false);
    expect(outcome?.hits).toHaveLength(0);
    expect(presets.length).toBeGreaterThan(0);
    // The nearest looks satisfy one word and admit missing the other.
    for (const match of outcome?.near ?? []) {
      expect(match.matched).toEqual(['warm']);
      expect(match.missed).toEqual(['zebra']);
      expect(realIds.has(match.preset.id)).toBe(true);
    }
    expect(presets.map((preset) => preset.id)).toEqual((outcome?.near ?? []).map((match) => match.preset.id));
  });

  it('never expands a query into a word the catalogue does not contain', () => {
    const index = indexFor(library);
    for (const [word, targets] of Object.entries(CONCEPTS)) {
      for (const target of targets) {
        expect(resolveWord(index, target).length, `${word} → ${target}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('filters and pools', () => {
  it('narrows a search to one category without contradicting it', () => {
    const { presets } = queryPresets(library, asked('warm', { category: 'Night photography' }));
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.every((preset) => preset.category === 'Night photography')).toBe(true);
  });

  it('searches favourites, and only favourites', () => {
    const ids = library.presets.filter(isUsable).slice(0, 3).map((preset) => preset.id);
    const { presets } = queryPresets(library, asked('warm', { tab: 'favourites', favourites: ids }));
    expect(presets.every((preset) => ids.includes(preset.id))).toBe(true);
  });

  it('keeps the collection pool to the named collection', () => {
    const [a, b] = library.presets.filter(isUsable);
    const pool = poolOf(library, asked('', { tab: 'collections', collections: { Days: [a.id], Nights: [b.id] }, collection: 'Days' }));
    expect(pool.map((preset) => preset.id)).toEqual([a.id]);
  });

  it('lists only unusable entries under “left behind”', () => {
    const unusable = library.presets.filter((preset) => !isUsable(preset));
    expect(unusable.length).toBeGreaterThan(0);
    const pool = poolOf(library, asked('', { tab: 'left behind' }));
    expect(pool).toHaveLength(unusable.length);
    expect(pool.every((preset) => !isUsable(preset))).toBe(true);
  });

  it('passes the whole pool through when the box holds only filler', () => {
    const { presets, outcome, exact } = queryPresets(library, asked('the look'));
    expect(outcome).toBeNull();
    expect(exact).toBe(true);
    expect(presets).toHaveLength(library.presets.filter(isUsable).length);
  });
});

describe('derived preset metadata', () => {
  it('names a monochrome recipe black and white', () => {
    const mono = library.presets.find((preset) => (preset.adjust.saturation ?? 0) <= -80);
    expect(mono).toBeDefined();
    expect(traitsOf(mono as Preset).visual.some((trait) => trait.id === 'monochrome')).toBe(true);
  });

  it('lists exactly the knobs the recipe moves', () => {
    for (const preset of library.presets.slice(0, 40)) {
      const summary = parameterSummary(preset);
      const moved = Object.entries(preset.adjust).filter(([, value]) => value !== 0).length;
      expect(summary === 'Moves no knob' ? 0 : summary.split(' · ').length).toBe(moved);
    }
  });

  it('bands the measured change without rounding it up', () => {
    expect(strengthOf(undefined)).toBe('unstated');
    expect(strengthOf(1.9)).toBe('minimal');
    expect(strengthOf(7.9)).toBe('subtle');
    expect(strengthOf(19.9)).toBe('moderate');
    expect(strengthOf(34.9)).toBe('strong');
    expect(strengthOf(70)).toBe('very strong');
  });

  it('does not claim a subject the preset never named', () => {
    const quiet: Preset = {
      ...library.presets[0],
      id: 'synthetic-quiet',
      name: 'Recipe 12',
      category: 'Uncategorised',
      tags: [],
      description: '',
    };
    expect(traitsOf(quiet).scenes).toEqual([]);
    expect(traitSummary(quiet)).not.toMatch(/portrait|night|travel/);
  });

  it('says what the scene labels are not', () => {
    const traits = traitsOf(find(library.presets[0].id));
    expect(traits.provenance).toMatch(/not a test/);
  });

  it('derives the same traits twice, and only computes once', () => {
    const preset = find(library.presets[7].id);
    expect(traitsOf(preset)).toBe(traitsOf(preset));
  });

  it('keeps a catalogue-wide trait claim traceable to the recipe', () => {
    for (const preset of library.presets.filter(isUsable).slice(0, 120)) {
      for (const trait of traitsOf(preset).visual) {
        expect(trait.magnitude, `${preset.id} · ${trait.id}`).toBeGreaterThanOrEqual(0);
        expect(trait.magnitude).toBeLessThanOrEqual(100);
      }
    }
  });
});

/** A library built in memory, to prove the index follows the file it is given. */
describe('index freshness', () => {
  it('ranks a smaller library without the shipped one', () => {
    const small: PresetLibrary = {
      ...library,
      presets: [
        { ...library.presets[0], id: 's1', name: 'Copper Dusk', category: 'Warm', tags: ['amber'], adjust: { warmth: 20 } },
        { ...library.presets[1], id: 's2', name: 'Cold Slate', category: 'Cool', tags: ['blue-grey'], adjust: { warmth: -20 } },
      ],
    };
    const warm = queryPresets(small, asked('amber'));
    expect(warm.presets.map((preset) => preset.id)).toEqual(['s1']);
    expect(queryPresets(small, asked('blue-grey')).presets.map((p) => p.id)).toEqual(['s2']);
    expect(queryPresets(small, asked('portrait')).presets).toHaveLength(0);
  });
});
