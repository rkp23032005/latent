// @vitest-environment jsdom
/**
 * Recommendations, personalisation and starting strength — §3, §4, §5, §7.
 *
 * Two claims hold this file together.
 *
 * 1. Nothing is invented. A suggestion is a preset from the shipped catalogue,
 *    an intensity is arithmetic over numbers that exist, and a query that fits
 *    nothing produces an empty list rather than five arbitrary looks.
 * 2. A personalised ranking is not an objective one. The basis of every
 *    suggestion is carried with it and tested here, so "you kept this" can never
 *    be shown as "this suits your photograph".
 *
 * No model is involved, and the tests would fail if the code claimed otherwise:
 * every path is deterministic over the catalogue and a fixed 64×64 measurement.
 */

import { act, renderHook } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDENTITY } from '../lib/image/adjustments';
import { lookDistance } from '../lib/ai/enhance';
import { suggestIntensity } from '../lib/ai/intensity';
import type { ImageAnalysis } from '../lib/ai/imageAnalysis';
import { similarPresets, suggestPresets } from '../lib/ai/recommender';
import { isCataloguePreset, isUsable, loadLibrary, loadedLibrary, resetLibraryCache } from '../lib/preset/library';
import { sampleDistance } from '../lib/preset/effect';
import { presetAdjustments, type Preset } from '../lib/preset/schema';
import {
  COLLECTION_LIMIT,
  FAVOURITES_KEY,
  RECENT_LIMIT,
  clearPreferences,
  collectionNames,
  createCollection,
  deleteCollection,
  preferencesSnapshot,
  readPreferences,
  rememberRecent,
  rememberStyle,
  resetPreferences,
  subscribePreferences,
  toggleFavourite,
  toggleInCollection,
} from '../lib/preset/preferences';
import { usePresetLibrary } from '../lib/preset/usePresetLibrary';
import { useAdjustments } from '../lib/useAdjustments';
import { useProposal } from '../lib/useProposal';
import { library } from './helpers';

const ids = new Set(library.presets.map((preset) => preset.id));
const usable = library.presets.filter(isUsable);
const byId = (id: string): Preset => usable.find((preset) => preset.id === id) as Preset;

/** The two ends of the catalogue's measured strength. */
const veryStrong = usable.reduce((a, b) => ((b.effect ?? 0) > (a.effect ?? 0) ? b : a));
const minimal = usable.reduce((a, b) => ((b.effect ?? 0) < (a.effect ?? 0) ? b : a));

/** A measurement, written out rather than derived, so the rules are checkable. */
function measurement(over: Partial<ImageAnalysis> = {}): ImageAnalysis {
  return {
    brightness: 0.5,
    contrast: 0.16,
    warmth: 0,
    saturation: 0.2,
    hueBias: 'neutral',
    brightnessLabel: 'mid',
    contrastLabel: 'normal',
    warmthLabel: 'neutral',
    saturationLabel: 'natural',
    summary: 'Mid exposure, normal contrast, neutral cast, natural colour.',
    sceneHints: ['general photography'],
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetPreferences();
});

/**
 * The catalogue the *running editor* holds, loaded through the real reader.
 * `isCataloguePreset` is the gate that keeps history, collections and every
 * suggestion pointing at an entry that exists, so it can only be tested against
 * a library that has actually been loaded — not the fixture this file reads.
 */
beforeAll(async () => {
  resetLibraryCache();
  vi.stubGlobal(
    'fetch',
    () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve(library),
      } as unknown as Response),
  );
  await loadLibrary();
  expect(loadedLibrary()?.presets.length ?? 0).toBeGreaterThan(0);
});

afterAll(() => {
  vi.unstubAllGlobals();
  resetLibraryCache();
  resetPreferences();
});

describe('suggestions from words', () => {
  it('returns catalogue presets, each labelled as the words that earned it', () => {
    const suggestions = suggestPresets(library, { query: 'warm film', limit: 5 });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(5);
    for (const row of suggestions) {
      expect(ids.has(row.preset.id)).toBe(true);
      expect(isUsable(row.preset)).toBe(true);
      expect(row.basis).toBe('search');
      expect(row.reason).toMatch(/warm|film/);
      expect(row.traits.length).toBeGreaterThan(0);
    }
  });

  it('returns nothing for words the catalogue does not hold', () => {
    expect(suggestPresets(library, { query: 'wuggrex zzzzq' })).toEqual([]);
    expect(suggestPresets(library, { query: 'the look' })).toEqual([]);
  });

  it('says so when it settles for the closest match', () => {
    const rows = suggestPresets(library, { query: 'warm zebra' });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.reason).toMatch(/closest match/);
  });
});

describe('suggestions from measurements', () => {
  it('labels an image-derived suggestion as measurement, never as taste', () => {
    const dark = measurement({
      brightness: 0.18,
      brightnessLabel: 'dark',
      contrastLabel: 'punchy',
      contrast: 0.28,
      saturationLabel: 'muted',
      saturation: 0.12,
      sceneHints: ['night or low-light scene'],
    });
    const rows = suggestPresets(library, { analysis: dark, limit: 5 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.basis).toBe('image');
      expect(ids.has(row.preset.id)).toBe(true);
    }
    expect(rows[0].reason).toMatch(/measured|Brightness|Contrast|Colour/);
  });

  it('adapts to the photograph instead of reciting a fixed list', () => {
    const vivid = measurement({
      brightness: 0.7,
      brightnessLabel: 'bright',
      contrast: 0.25,
      contrastLabel: 'punchy',
      saturation: 0.45,
      saturationLabel: 'vivid',
      sceneHints: ['outdoor daylight'],
    });
    const dim = measurement({
      brightness: 0.2,
      brightnessLabel: 'dark',
      contrast: 0.05,
      contrastLabel: 'flat',
      saturation: 0.05,
      saturationLabel: 'desaturated',
      sceneHints: ['monochrome or near-monochrome'],
    });
    const a = suggestPresets(library, { analysis: vivid, limit: 5 }).map((row) => row.preset.id);
    const b = suggestPresets(library, { analysis: dim, limit: 5 }).map((row) => row.preset.id);
    expect(a).not.toEqual(b);
    expect(b.every((id) => ids.has(id))).toBe(true);
  });

  it('does not offer one family five times', () => {
    const rows = suggestPresets(library, { analysis: measurement(), limit: 5 });
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.preset.category, (counts.get(row.preset.category) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(counts.size).toBeGreaterThan(1);
  });
});

describe('personalised suggestions are marked as personalised', () => {
  it('raises a kept look under the user’s own basis', () => {
    const favourite = usable[3];
    toggleFavourite(favourite.id);
    const rows = suggestPresets(library, { favourites: readPreferences().favourites, limit: 5 });
    const mine = rows.find((row) => row.preset.id === favourite.id);
    expect(mine).toBeDefined();
    expect(mine?.basis).toBe('personal');
    expect(mine?.reason).toMatch(/You kept/);
    expect(mine?.reason).not.toMatch(/measured|suits your/i);
  });

  it('reports a recently applied look as history, not quality', () => {
    const used = usable[9];
    rememberRecent(used.id);
    const rows = suggestPresets(library, { recent: readPreferences().recent, limit: 5 });
    const mine = rows.find((row) => row.preset.id === used.id);
    expect(mine?.basis).toBe('personal');
    expect(mine?.reason).toMatch(/You have used/);
  });

  it('still prefers the words when both apply', () => {
    const rows = suggestPresets(library, {
      query: 'night',
      favourites: [usable[0].id],
      recent: [usable[0].id],
    });
    expect(rows.every((row) => row.basis === 'search')).toBe(true);
  });
});

describe('looks like this', () => {
  it('names real neighbours, closest first, and never itself', () => {
    const preset = byId(usable[5].id);
    const neighbours = similarPresets(library, preset, 4);
    expect(neighbours).toHaveLength(4);
    const gaps = neighbours.map((candidate) => sampleDistance(preset.adjust, candidate.adjust));
    expect(gaps.every((gap) => Number.isFinite(gap))).toBe(true);
    expect([...gaps].sort((a, b) => a - b)).toEqual(gaps);
    expect(neighbours.some((candidate) => candidate.id === preset.id)).toBe(false);
    for (const candidate of neighbours) {
      expect(ids.has(candidate.id)).toBe(true);
      expect(isUsable(candidate)).toBe(true);
    }
  });

  it('ranks on the same chart either way round, coarse or full', () => {
    // The 32×24 sample exists so that one look against the whole library takes a
    // moment instead of five seconds. It must not change the answer it claims:
    // for these looks, every neighbour the sample returns is one the full chart
    // also ranks among the closest, within 0.01 of a 255 step of its own fourth
    // nearest. Anything coarser than the full chart trades order among looks
    // that are already indistinguishable; this is what "closest" is allowed to
    // mean, so the interface says it.
    for (const preset of [usable[0], usable[5], usable[140], veryStrong, minimal]) {
      const coarse = similarPresets(library, preset, 4).map((p) => p.id);
      const exact = usable
        .filter((candidate) => candidate.id !== preset.id)
        .map((candidate) => ({ id: candidate.id, gap: lookDistance(preset, candidate) }))
        .sort((a, b) => a.gap - b.gap);
      const gapOf = new Map(exact.map((row) => [row.id, row.gap]));
      const fourth = exact[3].gap;
      expect(coarse).toHaveLength(4);
      for (const id of coarse) {
        expect(gapOf.has(id)).toBe(true);
        expect(gapOf.get(id) as number).toBeLessThanOrEqual(fourth + 0.01);
      }
    }
  }, 180_000);
});

describe('a starting intensity from measured numbers', () => {
  it('stays inside the slider and on a step the slider can show', () => {
    for (const preset of usable.slice(0, 60)) {
      const { value } = suggestIntensity(preset, measurement());
      expect(value).toBeGreaterThanOrEqual(20);
      expect(value).toBeLessThanOrEqual(100);
      expect(value % 5).toBe(0);
    }
  });

  it('asks less of a look the chart measured as doing more', () => {
    expect(suggestIntensity(veryStrong, null).value).toBeLessThan(suggestIntensity(minimal, null).value);
  });

  it('asks less when the photograph already does the same thing', () => {
    const contrasty = usable.find((preset) => (preset.adjust.contrast ?? 0) > 15) as Preset;
    const punchy = measurement({ contrastLabel: 'punchy', contrast: 0.3 });
    expect(suggestIntensity(contrasty, punchy).value).toBeLessThanOrEqual(
      suggestIntensity(contrasty, null).value,
    );
  });

  it('explains itself in numbers, not in promises', () => {
    const { reason } = suggestIntensity(veryStrong, measurement());
    expect(reason).toMatch(/measured change/);
    expect(reason).not.toMatch(/best|perfect|optimal|trained/i);
  });

  it('is a starting point: the user’s slider wins', () => {
    const preset = veryStrong;
    const suggested = suggestIntensity(preset, measurement()).value;
    const { result } = renderHook(() => {
      const edits = useAdjustments('u');
      return { edits, proposals: useProposal(edits, 'u') };
    });

    act(() => result.current.proposals.preview(preset, 'search', undefined, suggested));
    expect(result.current.proposals.proposal?.intensity).toBe(suggested);

    // A hand move after the suggestion is never overwritten by it.
    act(() => result.current.proposals.setIntensity(63));
    expect(result.current.proposals.proposal?.intensity).toBe(63);

    act(() => result.current.proposals.accept());
    expect(result.current.edits.intensity).toBe(63);

    // Applying straight away uses the suggested start, and one undo restores.
    act(() => result.current.proposals.applyNow(minimal, 35));
    expect(result.current.edits.intensity).toBe(35);
    act(() => result.current.edits.undo());
    expect(result.current.edits.intensity).toBe(63);
  });

  it('lands the blend it says it lands', () => {
    const preset = veryStrong;
    const half = Math.round(suggestIntensity(preset, null).value / 2);
    const { result } = renderHook(() => {
      const edits = useAdjustments('u');
      return { edits, proposals: useProposal(edits, 'u') };
    });
    act(() => result.current.proposals.preview(preset, 'search', undefined, half));
    const full = presetAdjustments(preset, IDENTITY);
    const moved = (Object.keys(full) as Array<keyof typeof full>).filter((k) => full[k] !== IDENTITY[k]);
    if (moved.length > 0) {
      const knob = moved[0];
      expect(result.current.proposals.stageValues[knob]).toBeCloseTo((full[knob] * half) / 100, 1);
    }
  });
});

describe('every result is a preset that exists', () => {
  it('accepts catalogue ids and refuses recipes the editor invented', () => {
    expect(isCataloguePreset(usable[0].id)).toBe(true);
    expect(isCataloguePreset('conv:12')).toBe(false);
    expect(isCataloguePreset('ai:something')).toBe(false);
    expect(isCataloguePreset('')).toBe(false);
  });

  it('lists nothing that the loaded catalogue does not hold', () => {
    const loaded = new Set((loadedLibrary()?.presets ?? []).map((preset) => preset.id));
    expect(loaded.size).toBeGreaterThan(0);
    for (const preset of usable) expect(loaded.has(preset.id)).toBe(true);

    const rows = suggestPresets(library, { query: 'cinematic sunset', limit: 5 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(loaded.has(row.preset.id)).toBe(true);
    for (const neighbour of similarPresets(library, usable[0], 4)) expect(loaded.has(neighbour.id)).toBe(true);
  });
});

describe('preferences on this device', () => {
  it('keeps one copy of a favourite for every panel', () => {
    const id = usable[2].id;
    const first = renderHook(() => usePresetLibrary().favourites);
    const second = renderHook(() => usePresetLibrary().favourites);

    act(() => {
      toggleFavourite(id);
    });
    expect(first.result.current).toEqual([id]);
    expect(second.result.current).toEqual([id]);
    expect(JSON.parse(String(window.localStorage.getItem(FAVOURITES_KEY)))).toEqual([id]);

    act(() => {
      toggleFavourite(id);
    });
    expect(first.result.current).toEqual([]);
    expect(second.result.current).toEqual([]);
  });

  it('remembers history newest-first and caps it', () => {
    for (const preset of usable.slice(0, RECENT_LIMIT + 6)) rememberRecent(preset.id);
    const recent = readPreferences().recent;
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent[0]).toBe(usable[RECENT_LIMIT + 5].id);
    // re-applying moves it to the front rather than duplicating it
    act(() => {
      rememberRecent(recent[3]);
    });
    expect(readPreferences().recent.filter((item) => item === recent[3])).toHaveLength(1);
  });

  it('collects looks by name, toggles them, and deletes the list', () => {
    const [a, b] = usable;
    expect(createCollection('Weekends')).toBe('Weekends');
    expect(createCollection('Weekends')).toBeNull();
    expect(toggleInCollection('Weekends', a.id)).toEqual([a.id]);
    expect(toggleInCollection('Weekends', b.id)).toEqual([b.id, a.id]);
    expect(toggleInCollection('Weekends', a.id)).toEqual([b.id]);
    expect(collectionNames()).toEqual(['Weekends']);

    deleteCollection('Weekends');
    expect(collectionNames()).toEqual([]);
  });

  it('refuses more collections than the rail can show', () => {
    for (let n = 0; n < COLLECTION_LIMIT; n++) expect(createCollection(`Set ${n}`)).not.toBeNull();
    expect(createCollection('One too many')).toBeNull();
  });

  it('holds style words and forgets everything on request', () => {
    rememberStyle('Cinematic sunset');
    rememberStyle('  ');
    expect(readPreferences().styles).toEqual(['Cinematic sunset']);
    toggleFavourite(usable[0].id);
    rememberRecent(usable[1].id);
    createCollection('Keep');

    clearPreferences();
    expect(preferencesSnapshot()).toEqual({ favourites: [], recent: [], collections: {}, styles: [] });
    expect(window.localStorage.getItem(FAVOURITES_KEY)).toBeNull();
  });

  it('notifies subscribers, and stops when they unsubscribe', () => {
    let seen = 0;
    const off = subscribePreferences(() => (seen += 1));
    toggleFavourite(usable[4].id);
    expect(seen).toBe(1);
    off();
    toggleFavourite(usable[5].id);
    expect(seen).toBe(1);
  });

  it('records history centrally, so a look applied from a card counts once', () => {
    const preset = usable[6];
    const { result } = renderHook(() => useAdjustments('u'));
    act(() => result.current.applyPreset(presetAdjustments(preset, IDENTITY), preset.id));
    expect(readPreferences().recent).toEqual([preset.id]);

    // A synthetic recipe is not a preset, so it does not enter the Recent list.
    act(() => result.current.applyPreset(presetAdjustments(preset, IDENTITY), 'conv:4'));
    expect(readPreferences().recent).toEqual([preset.id]);
  });
});
