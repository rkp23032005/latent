// @vitest-environment jsdom
/**
 * The skin guard — Phase 15 §3.
 *
 * Three things are tested here, and the third is the one that matters most.
 *
 * 1. The band is arithmetic, and its consequences are listed rather than
 *    described: which colours are protected, which are released, and what the
 *    guard does to a pixel it has decided about.
 * 2. The guard keeps the grade's light and damps only its colour, is exactly a
 *    no-op when there is no grade to damp, and is a no-op off.
 * 3. It is *not* a face detector, and the test proves the failure as well as the
 *    success: a cast strong enough to move a face out of the rectangle releases
 *    it, and the guard goes quiet. The panel says the same thing.
 *
 * Nothing here measures a model, because there is no model: see
 * `lib/ai/segmentation.ts` for what was looked for and not taken.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  clampAdjustments,
  toPipelineParams,
  type Adjustments,
} from '../lib/image/adjustments';
import {
  PARAM_UNIFORMS,
  STAGES,
  applyPipeline,
  buildChannelLuts,
  fragmentShader,
} from '../lib/image/pipeline';
import {
  CHROMA_RAMP,
  SKIN_BAND,
  applySkinGuard,
  skinWeight,
  skinWeightOfSource,
} from '../lib/image/skinGuard';
import { gradeSample } from '../lib/preset/effect';
import { useAdjustments } from '../lib/useAdjustments';
import { loadSamples, sample64 } from './helpers';

type Swatch = { readonly name: string; readonly rgb: readonly [number, number, number] };

/**
 * Complexions across the range, as 0–1 display values. These are colours, chosen
 * to sit at both ends and the middle of the tone scale — not diagnoses of anyone,
 * and not a claim that this list covers the world.
 */
const COMPLEXIONS: readonly Swatch[] = [
  { name: 'very light', rgb: [0.96, 0.86, 0.8] },
  { name: 'light', rgb: [0.91, 0.76, 0.65] },
  { name: 'fair warm', rgb: [0.87, 0.7, 0.58] },
  { name: 'medium', rgb: [0.82, 0.64, 0.51] },
  { name: 'olive', rgb: [0.72, 0.55, 0.4] },
  { name: 'tan', rgb: [0.64, 0.46, 0.32] },
  { name: 'brown', rgb: [0.55, 0.38, 0.27] },
  { name: 'deep brown', rgb: [0.4, 0.27, 0.2] },
  { name: 'very deep', rgb: [0.28, 0.18, 0.13] },
  { name: 'near-black', rgb: [0.16, 0.1, 0.08] },
];

/** Colours that are not skin, including several that photograph warm. */
const OTHERS: readonly Swatch[] = [
  { name: 'blue sky', rgb: [0.4, 0.6, 0.85] },
  { name: 'deep shadow', rgb: [0.12, 0.16, 0.22] },
  { name: 'foliage', rgb: [0.25, 0.5, 0.2] },
  { name: 'grey concrete', rgb: [0.6, 0.6, 0.6] },
  { name: 'white paper', rgb: [0.95, 0.95, 0.93] },
  { name: 'teal wall', rgb: [0.2, 0.5, 0.5] },
  { name: 'saturated red', rgb: [0.9, 0.08, 0.06] },
  { name: 'autumn orange', rgb: [0.8, 0.4, 0.1] },
  { name: 'sunset yellow', rgb: [0.95, 0.75, 0.25] },
];

/** Warm things in a room that are not skin — protected, and said so out loud. */
const WARM_NEIGHBOURS: readonly Swatch[] = [
  { name: 'sand', rgb: [0.8, 0.72, 0.55] },
  { name: 'timber', rgb: [0.45, 0.3, 0.2] },
  { name: 'brick', rgb: [0.55, 0.25, 0.2] },
];

const weight = (s: Swatch) => {
  const [r, g, b] = s.rgb;
  return skinWeightOfSource(r, g, b);
};

/** A cast, applied as a channel gain — the arithmetic of a white balance wrong. */
function cast(s: Swatch, warm: number, cool: number): Swatch {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    name: s.name,
    rgb: [clamp(s.rgb[0] * warm), clamp(s.rgb[1]), clamp(s.rgb[2] * cool)],
  };
}

function chroma(rgb: readonly number[]): number {
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
}

function luma(rgb: readonly number[]): number {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

/** Grade a sample the way the fallback renderer does, then lay the guard over it. */
function renderWithGuard(rgba: Uint8Array, width: number, height: number, values: Adjustments, guard: number) {
  const graded = gradeSample(rgba, width, height, values);
  const params = toPipelineParams(values, guard);
  const pixel = new Float32Array(3);
  const source = new Float32Array(3);
  const out = new Uint8Array(graded.length);
  for (let i = 0, o = 0; i < graded.length; i += 3, o += 4) {
    pixel[0] = graded[i] / 255;
    pixel[1] = graded[i + 1] / 255;
    pixel[2] = graded[i + 2] / 255;
    source[0] = rgba[o] / 255;
    source[1] = rgba[o + 1] / 255;
    source[2] = rgba[o + 2] / 255;
    applySkinGuard(pixel, source, params.skinGuard);
    for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.max(0, Math.round(pixel[c] * 255)));
  }
  return out;
}

describe('the band: what it takes in', () => {
  it('protects every complexion on the list, and no non-skin colour', () => {
    const rows = [...COMPLEXIONS, ...WARM_NEIGHBOURS, ...OTHERS].map((s) => ({
      name: s.name,
      weight: weight(s),
    }));
    const table = rows.map((r) => `  ${r.name.padEnd(18)} ${r.weight.toFixed(4)}`).join('\n');
    console.log(`\nband census, Cb 77–127 / Cr 133–173 restated in display units\n${table}`);

    /* Every swatch here sits clear of both ramps, so the census comes out flat at
       one and zero. The ramping itself is the next test but one. */
    for (const row of rows.filter((r) => COMPLEXIONS.some((s) => s.name === r.name))) {
      expect(row.weight, row.name).toBeGreaterThan(0.99);
    }
    for (const row of rows.filter((r) => OTHERS.some((s) => s.name === r.name))) {
      expect(row.weight, row.name).toBeLessThan(0.01);
    }
  });

  it('counts the warm neighbours it will also protect, and says which they are', () => {
    /* The panel copy claims sand, timber and brick fall inside the band. If one
       of these ever stopped doing so, the copy would be the thing to change. */
    const inside = WARM_NEIGHBOURS.filter((s) => weight(s) > 0.99).map((s) => s.name);
    expect(inside).toEqual(['sand', 'timber', 'brick']);
  });

  it('gates on luma, because a black or a white pixel has no colour to protect', () => {
    const black = [0.02, 0.013, 0.01];
    const white = [0.995, 0.99, 0.985];
    expect(skinWeightOfSource(...(black as [number, number, number]))).toBe(0);
    expect(skinWeightOfSource(...(white as [number, number, number]))).toBe(0);
    /* The same hue, lit: inside the gate. */
    expect(skinWeightOfSource(0.55, 0.38, 0.27)).toBeGreaterThan(0.9);
  });

  it('ramps rather than clips at an edge', () => {
    const [lo] = SKIN_BAND.red;
    expect(skinWeight(lo - CHROMA_RAMP, -0.1, 0.5)).toBe(0);
    expect(skinWeight(lo, -0.1, 0.5)).toBeGreaterThan(0.4);
    expect(skinWeight(lo, -0.1, 0.5)).toBeLessThan(0.6);
    expect(skinWeight(lo + CHROMA_RAMP, -0.1, 0.5)).toBeGreaterThan(0.9);
  });
});

describe('the band: what it gives up', () => {
  it('lets go of the least saturated complexions at the mildest cast', () => {
    /* The band is a rectangle in colour, and a cool light shrinks a pixel's
       distance from neutral. The measured gain at which each complexion leaves is
       the honest version of "protection is not uniform across tones": it is a
       question of how far the colour sits from grey, not of who is in the frame.
       The red channel is dimmed rather than the blue raised so that no swatch is
       clamped on the way and the arithmetic stays comparable. */
    const releases = COMPLEXIONS.map((s) => {
      for (let gain = 1; gain >= 0.4; gain -= 0.01) {
        if (weight(cast(s, gain, 1)) < 0.5) return { name: s.name, at: Number(gain.toFixed(2)) };
      }
      return { name: s.name, at: 0.4 };
    });
    console.log(
      `\nred gain at which each complexion falls out of the band:\n${releases
        .map((r) => `  ${r.name.padEnd(14)} ${r.at.toFixed(2)}`)
        .join('\n')}`,
    );

    /* Every one of them does leave — a cast big enough moves any colour out — and
       none of them needs a cast bigger than two thirds of the red channel. */
    for (const r of releases) {
      expect(r.at, r.name).toBeLessThan(1);
      expect(r.at, r.name).toBeGreaterThan(0.4);
    }
    const at = (name: string) => releases.find((r) => r.name === name)!.at;
    /* The palest and the darkest — the two with the least colour in them — go
       first; the mid-range tones with the widest chroma hold on longest. */
    expect(at('very light')).toBeCloseTo(0.92, 2);
    expect(at('near-black')).toBeCloseTo(0.85, 2);
    expect(at('very deep')).toBeCloseTo(0.75, 2);
    expect(at('brown')).toBeCloseTo(0.72, 2);
    expect(at('brown')).toBeLessThan(at('very light'));
    expect(at('tan')).toBeLessThan(at('light'));
    /* And no complexion is protected past a cast of 0.70: a look that strong has
       moved the whole face somewhere else, and the guard stops pretending. */
    expect(Math.min(...releases.map((r) => r.at))).toBeGreaterThan(0.7);
  });

  it('keeps working under a mild cast in either direction', () => {
    for (const s of [COMPLEXIONS[4], COMPLEXIONS[8]]) {
      expect(weight(cast(s, 1.05, 0.97))).toBeGreaterThan(0.4);
      expect(weight(cast(s, 0.97, 1.05))).toBeGreaterThan(0.2);
    }
  });
});

describe('the guard on a pixel', () => {
  const recipe = clampAdjustments({ saturation: 80, toning: 60, contrast: 30, exposure: 0.2 });

  it('writes nothing at all when there is no look to hold back', () => {
    for (const s of COMPLEXIONS) {
      const graded = new Float32Array(s.rgb);
      /* What the store can hold, read back — a float32 cannot keep 0.96. */
      const asStored = Array.from(graded);
      applySkinGuard(graded, s.rgb, 1);
      for (let c = 0; c < 3; c++) {
        expect(graded[c], `${s.name} channel ${c}`).toBeCloseTo(asStored[c], 6);
      }
    }
  });

  it('is off at strength 0', () => {
    const source = COMPLEXIONS[6].rgb;
    const before = new Float32Array(source);
    applyPipeline(before, toPipelineParams(recipe));
    const after = new Float32Array(before);
    applySkinGuard(after, source, 0);
    expect(Array.from(after)).toEqual(Array.from(before));
  });

  it('keeps the grade’s light exactly and takes back its colour', () => {
    const params = toPipelineParams(recipe, 100);
    for (const s of COMPLEXIONS) {
      const graded = new Float32Array(s.rgb);
      applyPipeline(graded, params);
      const gradedLuma = luma(graded);
      applySkinGuard(graded, s.rgb, params.skinGuard);
      /* Luma is preserved by construction: the guard moves a pixel along its
         chroma axes and never off the luma plane. */
      expect(Math.abs(luma(graded) - gradedLuma)).toBeLessThan(1e-6);
      /* And at full strength the colour is the original's, carried with the
         light the recipe gave it. */
      const ratio = chroma(graded) / Math.max(1e-6, chroma(s.rgb));
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(4.1);
    }
  });

  it('is a straight line in strength, and lands on the held pixel at 100', () => {
    /* `mix(graded, held, strength × weight)` is linear by construction, which is
       what makes a 0–100 slider behave like a slider: twice the number is twice
       the hold-back, and the end of the track is the held pixel itself. */
    const source = COMPLEXIONS[3].rgb;
    const base = new Float32Array(source);
    applyPipeline(base, toPipelineParams(recipe));
    const full = new Float32Array(source);
    applyPipeline(full, toPipelineParams(recipe));
    applySkinGuard(full, source, 1);

    const shift = (px: Float32Array) =>
      Math.abs(px[0] - base[0]) + Math.abs(px[1] - base[1]) + Math.abs(px[2] - base[2]);

    const at = (level: number) => {
      const px = new Float32Array(source);
      applyPipeline(px, toPipelineParams(recipe));
      applySkinGuard(px, source, level / 100);
      return px;
    };

    expect(shift(at(0))).toBe(0);
    const fullShift = shift(at(100));
    expect(fullShift).toBeGreaterThan(0.05);
    for (const level of [25, 50, 75]) {
      const measured = shift(at(level));
      expect(measured).toBeGreaterThan(0);
      /* The one place a fraction of a promise would be caught. */
      expect(measured).toBeCloseTo((fullShift * level) / 100, 6);
    }
    const last = at(100);
    for (let c = 0; c < 3; c++) expect(last[c]).toBe(full[c]);
  });

  it('leaves a pixel outside the band exactly as the recipe made it', () => {
    for (const s of OTHERS) {
      const withGuard = new Float32Array(s.rgb);
      applyPipeline(withGuard, toPipelineParams(recipe, 100));
      const without = new Float32Array(s.rgb);
      applyPipeline(without, toPipelineParams(recipe, 0));
      expect(Array.from(withGuard)).toEqual(Array.from(without));
    }
  });
});

describe('the guard on a photograph', () => {
  const portrait = loadSamples(96).find((s) => s.name === 'portrait-studio');
  const hands = loadSamples(96).find((s) => s.name === 'stilllife-hands');
  const recipe = clampAdjustments({ saturation: 90, vibrance: 60, toning: 70, contrast: 25 });

  it('does something measurable on the two photographs with people in them', () => {
    for (const sample of [portrait, hands]) {
      expect(sample, 'sample missing').toBeTruthy();
      const rgba = sample64(sample!);
      const off = renderWithGuard(rgba, 64, 64, recipe, 0);
      const on = renderWithGuard(rgba, 64, 64, recipe, 100);
      let changed = 0;
      let total = 0;
      for (let i = 0; i < off.length; i += 3) {
        const moved = Math.abs(off[i] - on[i]) + Math.abs(off[i + 1] - on[i + 1]) + Math.abs(off[i + 2] - on[i + 2]);
        if (moved > 0) changed++;
        total++;
      }
      const share = changed / total;
      console.log(
        `\n${sample!.name}: ${changed}/${total} of 4096 pixels changed by the guard (${(share * 100).toFixed(1)}%)`,
      );
      expect(share).toBeGreaterThan(0.02);
      expect(share).toBeLessThan(0.98);
    }
  });

  it('damps the colour move on the pixels it protects and nowhere else', () => {
    const sample = portrait!;
    const rgba = sample64(sample);
    const off = renderWithGuard(rgba, 64, 64, recipe, 100);
    const plain = renderWithGuard(rgba, 64, 64, recipe, 0);
    const source = renderWithGuard(rgba, 64, 64, IDENTITY, 0);

    let protectedCount = 0;
    let protectedChroma = 0;
    let protectedPlain = 0;
    for (let i = 0, o = 0; i < plain.length; i += 3, o += 4) {
      const w = skinWeightOfSource(rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255);
      if (w < 0.5) continue;
      protectedCount++;
      protectedChroma += chroma([off[i] / 255, off[i + 1] / 255, off[i + 2] / 255]);
      protectedPlain += chroma([plain[i] / 255, plain[i + 1] / 255, plain[i + 2] / 255]);
    }
    console.log(
      `\n${sample.name}: ${protectedCount} protected pixels, mean chroma ${(protectedChroma / Math.max(1, protectedCount)).toFixed(4)} against ${(protectedPlain / Math.max(1, protectedCount)).toFixed(4)} unguarded`,
    );
    expect(protectedCount).toBeGreaterThan(200);
    expect(protectedChroma).toBeLessThan(protectedPlain);
    /* Where the guard is not, the recipe is untouched. */
    let outsideDiff = 0;
    for (let i = 0, o = 0; i < plain.length; i += 3, o += 4) {
      const w = skinWeightOfSource(rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255);
      if (w > 0.02) continue;
      outsideDiff += Math.abs(off[i] - plain[i]) + Math.abs(off[i + 1] - plain[i + 1]) + Math.abs(off[i + 2] - plain[i + 2]);
    }
    expect(outsideDiff).toBe(0);
    /* And the light still arrives: the mean luma of the protected pixels moves by
       about as much as it does everywhere, because the guard keeps luma. */
    const meanLuma = (buf: Uint8Array) => {
      let sum = 0;
      for (let i = 0; i < buf.length; i += 3) sum += luma([buf[i] / 255, buf[i + 1] / 255, buf[i + 2] / 255]);
      return sum / (buf.length / 3);
    };
    expect(Math.abs(meanLuma(off) - meanLuma(plain))).toBeLessThan(0.02);
    expect(meanLuma(plain)).not.toBeCloseTo(meanLuma(source), 3);
  });
});

describe('the guard in the engine', () => {
  it('is one uniform, applied after every stage on both paths', () => {
    const names = PARAM_UNIFORMS.map(([, name]) => name);
    expect(names).toContain('uSkinGuard');
    expect(new Set(names).size).toBe(names.length);
    const shader = fragmentShader();
    const body = shader.slice(shader.indexOf('void main()'));
    const lastStage = body.indexOf(STAGES[STAGES.length - 1].glsl.trim().split('\n')[0]);
    const guardAt = body.indexOf('uSkinGuard > 0.0');
    expect(guardAt).toBeGreaterThan(lastStage);
    expect(guardAt).toBeLessThan(body.indexOf('gl_FragColor = vec4(clamp('));
  });

  it('never reaches the lookup tables, so the fold stays honest', () => {
    const values = clampAdjustments({ exposure: 0.4, contrast: 20, warmth: 30 });
    const a = buildChannelLuts(toPipelineParams(values, 0));
    const b = buildChannelLuts(toPipelineParams(values, 100));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(toPipelineParams(values, 100).skinGuard).toBe(1);
    expect(toPipelineParams(values, -20).skinGuard).toBe(0);
    expect(toPipelineParams(values, 1000).skinGuard).toBe(1);
    expect(toPipelineParams(values).skinGuard).toBe(0);
  });

  it('states its numbers in the shader in a form GLSL reads as a float', () => {
    /* A literal that prints without a decimal point is an integer to GLSL, and
       an integer argument does not match the float overloads. */
    const shader = fragmentShader();
    const floats = shader.match(/(?:SKIN_\w+|skinChromaEdge\(value, -?\d[\d.]*)\s*=\s*(-?[\d.]+)/g) ?? [];
    const integerShaped = floats.filter((line) => /\d$/.test(line) && !line.includes('.'));
    expect(integerShaped).toEqual([]);
    for (const value of [...SKIN_BAND.red, ...SKIN_BAND.blue, ...SKIN_BAND.luma]) {
      expect(shader).toContain(String(value));
    }
  });
});

describe('the guard in the session', () => {
  it('is one undoable gesture that survives a new look and dies with Reset all', () => {
    const { result } = renderHook(() => useAdjustments('u'));
    const recipe = clampAdjustments({ saturation: 40 });

    expect(result.current.skinGuard).toBe(0);
    act(() => result.current.setSkinGuard(60));
    expect(result.current.skinGuard).toBe(60);
    /* A guard with nothing underneath it is not an edit: the photograph is
       still the photograph, and the header is allowed to say so. */
    expect(result.current.dirty).toBe(false);

    act(() => result.current.applyPreset(recipe, 'look-a'));
    expect(result.current.skinGuard).toBe(60);
    expect(result.current.snapshot.skinGuard).toBe(60);

    act(() => result.current.setSkinGuard(20));
    /* One step for the guard, one for the look, one for this second turn. */
    expect(result.current.steps).toBe(3);
    act(() => result.current.undo());
    expect(result.current.skinGuard).toBe(60);
    act(() => result.current.redo());
    expect(result.current.skinGuard).toBe(20);

    /* A project saved before the guard existed restores as though it were off. */
    act(() =>
      result.current.applyState({
        chosen: { recipe, presetId: 'look-b' },
        intensity: 50,
        offsets: { ...IDENTITY },
        skinGuard: undefined as unknown as number,
      }),
    );
    expect(result.current.skinGuard).toBe(0);
    expect(result.current.values.saturation).toBe(20);

    act(() => result.current.setSkinGuard(75));
    act(() => result.current.reset());
    expect(result.current.skinGuard).toBe(0);
    expect(result.current.values.saturation).toBe(0);
  });

  it('counts a drag as one step, the way a knob does', () => {
    const { result } = renderHook(() => useAdjustments('u'));
    act(() => result.current.applyPreset(clampAdjustments({ contrast: 10 }), 'look-a'));
    for (const level of [10, 20, 30, 40, 50]) {
      act(() => result.current.setSkinGuard(level));
    }
    /* The look itself is a step, so the drag lands on top of it as one more. */
    expect(result.current.steps).toBe(2);
    expect(result.current.skinGuard).toBe(50);
  });
});
