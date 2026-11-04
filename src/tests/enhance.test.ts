import { describe, expect, it } from 'vitest';
import { IDENTITY, scaleRecipe } from '../lib/image/adjustments';
import { MIN_DISTINCT, generateOptions, lookDistance } from '../lib/ai/enhance';
import { presetAdjustments } from '../lib/preset/schema';
import { analyseSample, library, loadSamples, meanAbsDiff, original, render } from './helpers';

const samples = loadSamples(96);

describe('Enhance: options for different photographs', () => {
  const rows = samples.map((s) => {
    const analysis = analyseSample(s);
    return { s, analysis, options: generateOptions(library, analysis) };
  });

  it('has real photographs to test with', () => {
    expect(samples.length).toBeGreaterThanOrEqual(8);
  });

  for (const { s, analysis, options } of rows) {
    describe(s.name, () => {
      it('offers Natural, Cinematic and Creative as three different real presets', () => {
        expect(options.map((o) => o.kind)).toEqual(['natural', 'cinematic', 'creative']);
        expect(new Set(options.map((o) => o.preset.id)).size).toBe(3);
        for (const o of options) {
          expect(library.presets.some((p) => p.id === o.preset.id)).toBe(true);
          expect(['full', 'partial']).toContain(o.preset.support);
          expect(o.basis).toBe('rules');
          expect(o.explanation.length).toBeGreaterThan(10);
          expect(o.changes).not.toBe('No knob changes');
        }
      });

      it('keeps the looks visibly different from each other and from the original', () => {
        for (let i = 0; i < 3; i++) {
          const fromOriginal = meanAbsDiff(original(s), render(s, presetAdjustments(options[i].preset, IDENTITY)));
          expect(fromOriginal, `${options[i].label} vs original`).toBeGreaterThan(1);
          for (let j = i + 1; j < 3; j++) {
            const onChart = lookDistance(options[i].preset, options[j].preset);
            const onPhoto = meanAbsDiff(
              render(s, presetAdjustments(options[i].preset, IDENTITY)),
              render(s, presetAdjustments(options[j].preset, IDENTITY)),
            );
            expect(onChart, `${options[i].label}/${options[j].label} chart`).toBeGreaterThanOrEqual(MIN_DISTINCT);
            expect(onPhoto, `${options[i].label}/${options[j].label} photo`).toBeGreaterThan(2);
          }
        }
      });

      it('Natural stays subtle', () => {
        expect(options[0].preset.effect ?? 0).toBeLessThanOrEqual(25);
      });

      it('has intensity 0 = untouched, 100 = the preset, and monotone growth between', () => {
        for (const o of options) {
          const recipe = presetAdjustments(o.preset, IDENTITY);
          const base = original(s);
          // 0: the recipe collapses to identity exactly, and renders the photograph unchanged.
          expect(scaleRecipe(recipe, 0)).toEqual(IDENTITY);
          expect(meanAbsDiff(base, render(s, scaleRecipe(recipe, 0)))).toBeLessThan(0.01);
          // 100: exactly the preset as written.
          expect(render(s, scaleRecipe(recipe, 100))).toEqual(render(s, recipe));
          // Between: the effect on the picture never shrinks as intensity grows.
          let last = -1;
          for (let t = 0; t <= 100; t += 10) {
            const d = meanAbsDiff(base, render(s, scaleRecipe(recipe, t)));
            expect(d, `${o.label} @${t}`).toBeGreaterThanOrEqual(last - 0.05);
            last = d;
          }
          expect(last).toBeGreaterThan(1);
        }
      });

      it(`(report) ${analysis.brightnessLabel}/${analysis.contrastLabel}/${analysis.warmthLabel}/${analysis.saturationLabel}`, () => {
        console.log(
          `${s.name.padEnd(20)} ${analysis.brightnessLabel.padEnd(8)} ${analysis.contrastLabel.padEnd(7)} ` +
            options.map((o) => `${o.label}: ${o.preset.name}`).join(' | '),
        );
      });
    });
  }

  it('adapts: not every photograph gets the same three looks', () => {
    const naturals = new Set(rows.map((r) => r.options[0].preset.id));
    const cinematics = new Set(rows.map((r) => r.options[1].preset.id));
    const creatives = new Set(rows.map((r) => r.options[2].preset.id));
    console.log('distinct Natural/Cinematic/Creative picks:', naturals.size, cinematics.size, creatives.size);
    expect(naturals.size).toBeGreaterThan(2);
    expect(cinematics.size).toBeGreaterThan(2);
    expect(creatives.size).toBeGreaterThan(1);
  });

  it('Natural corrects in the right direction for the darkest and brightest photographs', () => {
    const sorted = [...rows].sort((a, b) => a.analysis.brightness - b.analysis.brightness);
    const dark = sorted[0];
    const bright = sorted[sorted.length - 1];
    const lift = (p: (typeof rows)[number]) => {
      const r = presetAdjustments(p.options[0].preset, IDENTITY);
      return r.exposure * 50 + r.brightness + 0.5 * r.shadows + 0.3 * r.blacks;
    };
    console.log('darkest', dark.s.name, dark.analysis.brightness.toFixed(2), 'lift', lift(dark).toFixed(1));
    console.log('brightest', bright.s.name, bright.analysis.brightness.toFixed(2), 'lift', lift(bright).toFixed(1));
    expect(lift(dark)).toBeGreaterThanOrEqual(lift(bright));
  });

  it('returns fewer options rather than inventing any when the library is empty', () => {
    expect(generateOptions({ ...library, presets: [] }, rows[0].analysis)).toEqual([]);
  });
});
