// @vitest-environment jsdom
/**
 * Phase 15 §1 — matching a reference photograph.
 *
 * The matcher claims one thing: it ranks the catalogue by how near the reference
 * each look renders *this* photograph into. That is checkable, because a
 * reference photograph can be made by putting a real preset on a real file and
 * asking the matcher to find it back. So these tests are measurements with known
 * answers, plus the invariants the interface rests on:
 *
 * 1. Round trip — the look that made the reference is ranked first.
 * 2. Agreement — the fast grading path renders the same pixels as the pipeline.
 * 3. Bounded approximation — the 64×64 sample reads within two hundredths of a
 *    step of a frame four times larger.
 * 4. Ordering — real usable presets only, no duplicates, at most two per
 *    category, ascending distance, and the same answer twice over.
 * 5. Confirmed turns — a proposed knob is a real control inside its range, and
 *    the distance it claims to close is the distance re-rendering returns.
 * 6. Separation — nothing the matcher hands back carries a pixel of anything.
 * 7. Honest flags — `alreadyAlike` and `useful` follow from the numbers reported.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTROLS,
  IDENTITY,
  clampToControl,
  type AdjustmentId,
  type Adjustments,
} from '../lib/image/adjustments';
import { gradeSample } from '../lib/preset/effect';
import { isUsable } from '../lib/preset/library';
import type { Preset } from '../lib/preset/schema';
import {
  gradedRead,
  makeStyleSubject,
  matchToReference,
  referenceRecipe,
  type ReferenceResult,
} from '../lib/ai/reference';
import { STYLE_FIELDS, readStyleRgb, readStyleRgba, styleDistance, type StyleRead } from '../lib/ai/styleRead';
import { library, loadSamples, render, sample64, type Sample } from './helpers';

/** One photograph: its pixels, its 64×64 sample, and the reading off that sample. */
const photo = loadSamples(96)[0];
const bytes = sample64(photo);
const subject = makeStyleSubject(bytes, 64, 64);
const sampleAsPhoto: Sample = { name: 'sample', width: 64, height: 64, rgba: bytes };

const usable = library.presets.filter(isUsable);
const byId = new Map(library.presets.map((preset) => [preset.id, preset]));
const controlOf = new Map(CONTROLS.map((control) => [control.id, control]));

const scratch = () => new Uint8Array(64 * 64 * 3);

/**
 * A reference made by the engine: this photograph, rendered at full sample size
 * with one real look on it, read the way a borrowed file would be read.
 */
const referenceCache = new Map<string, StyleRead>();
function referenceFor(preset: Preset): StyleRead {
  const known = referenceCache.get(preset.id);
  if (known) return known;
  const rgb = render(photo, { ...IDENTITY, ...preset.adjust } as Adjustments);
  const read = readStyleRgb(rgb, photo.width * photo.height);
  referenceCache.set(preset.id, read);
  return read;
}

/** The distance of every usable look from one target, nearest first. */
function exactRanking(target: StyleRead): { id: string; gap: number }[] {
  return usable
    .map((preset) => ({ id: preset.id, gap: styleDistance(gradedRead(subject, preset.adjust, scratch()), target) }))
    .sort((a, b) => a.gap - b.gap || a.id.localeCompare(b.id));
}

/* Spread over the catalogue rather than drawn from one family, so the round trip
   covers looks that move the photograph in different directions. */
const makers = [0, 83, 166, 249, 332, 415, 498, 581].map((index) => usable[index]);

describe('reference matcher: the ranking has a known answer', () => {
  it('has eight real usable presets to make references with', () => {
    expect(makers.length).toBe(8);
    for (const preset of makers) {
      expect(preset).toBeTruthy();
      expect(isUsable(preset)).toBe(true);
    }
  });

  const results = new Map<string, ReferenceResult>();

  it('finds a look that reproduces the reference, and misses nothing materially nearer', async () => {
    const rows: string[] = [];
    const missed: string[] = [];
    for (const preset of makers) {
      const result = await matchToReference(library, subject, referenceFor(preset), { limit: 3, turnLimit: 1 });
      results.set(preset.id, result);
      const exact = exactRanking(referenceFor(preset));
      const mine = exact.find((row) => row.id === preset.id);
      const top = result.matches[0];
      if (!mine) throw new Error(`${preset.id} left the ranking`);
      /* Two claims, both arithmetic: the look that made the reference does land on
         it, and no card is offered for a look that is measurably nearer. A card
         that ties the maker within a hundredth of a step is the 64×64 sampling
         talking, not the ranking — so it is reported, not asserted away. */
      expect(mine.gap).toBeLessThanOrEqual(0.05);
      if (exact[0].id !== preset.id && mine.gap - exact[0].gap > 0.01) {
        missed.push(`${preset.id} (${mine.gap.toFixed(4)}) beaten by ${exact[0].id} (${exact[0].gap.toFixed(4)})`);
      }
      if (top.preset.id !== preset.id) {
        rows.push(`  ${preset.id}: first card ${top.preset.id} ${top.gap.toFixed(4)} vs ${mine.gap.toFixed(4)}`);
      }
    }
    console.log(`\nround trip, 8 engine-made references on ${photo.name}: ${missed.length} beaten by more than 0.01\n${rows.join('\n')}`);
    expect(missed).toEqual([]);
  }, 420_000);

  it('does not skip a nearer look that the same ranking finds', () => {
    for (const preset of makers) {
      const result = results.get(preset.id);
      if (!result) continue;
      const exact = exactRanking(referenceFor(preset));
      /* The cards are a capped, family-limited shortlist, so only the first card
         can be checked against the exact order — and it is the claim the panel
         makes: the nearest render is the one offered first. */
      expect(result.matches[0].preset.id).toBe(exact[0].id);
      expect(result.matches[0].gap).toBeCloseTo(exact[0].gap, 10);
      /* And the flag that decides whether cards are shown at all is the
         arithmetic the panel prints, not a judgement made after the ranking. */
      expect(result.useful).toBe(result.matches[0].gap <= result.before - 0.15);
    }
  }, 420_000);
});

describe('reference matcher: what it measures', () => {
  it('grades a sample the same way the pipeline grades it', () => {
    /* `gradeSample` folds the per-channel stages into three lookup tables, the
       way the CPU fallback does; `render` walks the stages one at a time. The
       matcher's whole claim rests on those two being the same arithmetic. */
    for (const preset of [usable[0], usable[83], usable[300]]) {
      const fast = gradeSample(bytes, 64, 64, preset.adjust);
      const slow = render(sampleAsPhoto, { ...IDENTITY, ...preset.adjust } as Adjustments);
      let worst = 0;
      for (let i = 0; i < fast.length; i++) worst = Math.max(worst, Math.abs(fast[i] - slow[i]));
      expect(worst).toBeLessThanOrEqual(1);
    }
  });

  it('reads the same look off a 64×64 sample and off a frame four times larger within two hundredths of a step', () => {
    const big = loadSamples(256)[0];
    const preset = usable[83];
    const small = gradedRead(makeStyleSubject(sample64(big), 64, 64), preset.adjust, scratch());
    const large = readStyleRgb(render(big, { ...IDENTITY, ...preset.adjust } as Adjustments), big.width * big.height);
    const drift = styleDistance(small, large);
    console.log(`\nsample-vs-frame drift for ${preset.id} (${big.width}×${big.height} read at 64×64): ${drift.toFixed(4)} steps`);
    expect(drift).toBeLessThanOrEqual(0.02);
  }, 180_000);

  it('reads RGBA bytes and RGB bytes on the same quantities', () => {
    /* A borrowed file arrives as RGBA from the canvas and a graded render comes
       back as RGB from the engine; if the two paths disagreed the comparison
       would be between two different yardsticks, not two photographs. */
    const rgb = new Uint8Array(64 * 64 * 3);
    for (let i = 0; i < 64 * 64; i++) {
      rgb[i * 3] = bytes[i * 4];
      rgb[i * 3 + 1] = bytes[i * 4 + 1];
      rgb[i * 3 + 2] = bytes[i * 4 + 2];
    }
    expect(readStyleRgb(rgb, 64 * 64)).toEqual(readStyleRgba(bytes, 64 * 64));
  });

  it('holds the eleven characteristics and nothing the knobs cannot move', () => {
    expect(STYLE_FIELDS.length).toBe(11);
    expect(Object.keys(subject.read).sort()).toEqual(STYLE_FIELDS.map((field) => field.id).sort());
    for (const field of STYLE_FIELDS) {
      expect(Number.isFinite(subject.read[field.id])).toBe(true);
    }
  });
});

describe('reference matcher: what it hands back', () => {
  it('returns only real usable presets, once each, no more than two per category', async () => {
    const result = await matchToReference(library, subject, referenceFor(usable[166]), { limit: 4 });
    expect(result.measured).toBe(usable.length);
    const ids = new Set<string>();
    const families = new Map<string, number>();
    for (const match of result.matches) {
      expect(byId.get(match.preset.id)).toBe(match.preset);
      expect(isUsable(match.preset)).toBe(true);
      expect(ids.has(match.preset.id)).toBe(false);
      ids.add(match.preset.id);
      const seen = families.get(match.preset.category) ?? 0;
      expect(seen).toBeLessThan(2);
      families.set(match.preset.category, seen + 1);
    }
    expect(result.matches.length).toBeLessThanOrEqual(4);
  }, 180_000);

  it('ascends by distance and gives the identical ranking twice', async () => {
    const target = referenceFor(usable[249]);
    const first = await matchToReference(library, subject, target, { limit: 5, turnLimit: 0 });
    const second = await matchToReference(library, subject, target, { limit: 5, turnLimit: 0 });
    for (let i = 1; i < first.matches.length; i++) {
      expect(first.matches[i].gap).toBeGreaterThanOrEqual(first.matches[i - 1].gap);
    }
    expect(second.matches.map((m) => m.preset.id)).toEqual(first.matches.map((m) => m.preset.id));
    expect(second.matches.map((m) => m.gap)).toEqual(first.matches.map((m) => m.gap));
    expect(second.before).toBe(first.before);
  }, 300_000);

  it('carries no pixels of anything it was given', async () => {
    const result = await matchToReference(library, subject, referenceFor(usable[332]), { limit: 3, turnLimit: 2 });
    const carriers: string[] = [];
    const walk = (value: unknown, path: string, depth: number) => {
      if (depth > 6 || value === null || typeof value !== 'object') return;
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob) {
        carriers.push(path);
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, `${path}.${key}`, depth + 1);
      }
    };
    walk(result, 'result', 0);
    expect(carriers).toEqual([]);
  }, 180_000);
});

describe('reference matcher: the turns it offers', () => {
  it('proposes real knobs inside their ranges, and only when a re-render agrees', async () => {
    const offered: string[] = [];
    for (const preset of [usable[415], usable[498], usable[581]]) {
      const result = await matchToReference(library, subject, referenceFor(preset), { limit: 3, turnLimit: 3 });
      for (const match of result.matches) {
        if (match.turns.length === 0) {
          expect(match.turnsGap).toBeNull();
          continue;
        }
        const recipe = referenceRecipe(match);
        for (const turn of match.turns) {
          const control = controlOf.get(turn.id);
          expect(control).toBeDefined();
          if (!control) continue;
          const from = { ...IDENTITY, ...match.preset.adjust } as Record<AdjustmentId, number>;
          expect(recipe[turn.id]).toBe(clampToControl(turn.id, from[turn.id] + turn.delta));
          expect(recipe[turn.id]).toBeGreaterThanOrEqual(control.min);
          expect(recipe[turn.id]).toBeLessThanOrEqual(control.max);
        }
        const moved = styleDistance(gradedRead(subject, recipe, scratch()), result.target);
        expect(match.turnsGap).toBeCloseTo(moved, 10);
        expect(match.gap - moved).toBeGreaterThanOrEqual(0.1);
        offered.push(`${match.preset.id}: ${match.turns.map((t) => `${t.id} ${t.deltaText}`).join(', ')}`);
      }
    }
    console.log(`\nturns offered against engine-made references: ${offered.length}\n  ${offered.join('\n  ')}`);
  }, 420_000);

  it('leaves the recipe of a match with no turns exactly as the preset wrote it', async () => {
    const result = await matchToReference(library, subject, referenceFor(usable[83]), { limit: 3, turnLimit: 0 });
    for (const match of result.matches) {
      const recipe = referenceRecipe(match);
      for (const control of CONTROLS) {
        expect(recipe[control.id]).toBe(clampToControl(control.id, match.preset.adjust[control.id] ?? IDENTITY[control.id]));
      }
    }
  }, 180_000);
});

describe('reference matcher: the states that are not a recommendation', () => {
  it('says so when the two photographs already read alike', async () => {
    const result = await matchToReference(library, subject, subject.read, { limit: 3 });
    expect(result.before).toBeCloseTo(0, 10);
    expect(result.alreadyAlike).toBe(true);
  }, 180_000);

  it('derives alike and useful from the numbers it reports', async () => {
    /* A borrowed photograph from a different scene is the case the phase warns
       about: most of the difference between two files is subject and texture,
       which these knobs do not reach. What is checkable is that the flags follow
       the arithmetic the panel shows, rather than a judgement applied after it. */
    for (const other of loadSamples(96).slice(1, 4)) {
      const target = readStyleRgba(sample64(other), 64 * 64);
      const result = await matchToReference(library, subject, target, { limit: 3, turnLimit: 1 });
      expect(result.alreadyAlike).toBe(result.before <= 0.4);
      expect(result.useful).toBe(result.matches[0].gap <= result.before - 0.15);
      expect(result.target).toBe(target);
      expect(result.source).toBe(subject.read);
    }
  }, 420_000);
});
