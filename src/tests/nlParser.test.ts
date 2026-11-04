import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_KNOBS,
  movingKnobs,
  parseNlRequest,
  resolveDeltas,
  resolvedToAdjustments,
} from '../lib/ai/nlParser';
import { CONTROLS, IDENTITY } from '../lib/image/adjustments';
import type { Adjustments } from '../lib/image/adjustments';

// ── Helpers ──────────────────────────────────────────────────────────────────

function controlRange(id: string) {
  const c = CONTROLS.find((ctrl) => ctrl.id === id);
  if (!c) throw new Error(`Unknown control: ${id}`);
  return { min: c.min, max: c.max };
}

function assertAllClamped(result: ReturnType<typeof parseNlRequest>) {
  if (result.kind !== 'adjustments') return;
  for (const d of result.deltas) {
    const { min, max } = controlRange(d.id);
    expect(d.value, `${d.id} must be >= ${min}`).toBeGreaterThanOrEqual(min);
    expect(d.value, `${d.id} must be <= ${max}`).toBeLessThanOrEqual(max);
  }
}

const valueOf = (r: ReturnType<typeof parseNlRequest>, id: string) => {
  if (r.kind !== 'adjustments') throw new Error(`expected adjustments, got ${r.kind}`);
  const d = r.deltas.find((x) => x.id === id);
  if (!d) throw new Error(`no delta for ${id}`);
  return d.value;
};

// ── Supported direct adjustments ─────────────────────────────────────────────

describe('parseNlRequest: direct adjustments', () => {
  it('brighter → exposure + brightness deltas, all clamped', () => {
    const r = parseNlRequest('Make this image brighter');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.some((d) => d.id === 'exposure')).toBe(true);
    expect(r.deltas.some((d) => d.id === 'brightness')).toBe(true);
    expect(r.deltas.find((d) => d.id === 'exposure')!.value).toBeGreaterThan(0);
  });

  it('darker → negative exposure delta', () => {
    const r = parseNlRequest('Make it darker');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((d) => d.id === 'exposure')!.value).toBeLessThan(0);
  });

  it('warmer colours → positive warmth and temperature', () => {
    const r = parseNlRequest('Make the colours warmer');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((d) => d.id === 'warmth')!.value).toBeGreaterThan(0);
  });

  it('less saturated → negative saturation delta', () => {
    const r = parseNlRequest('Make it less saturated');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((d) => d.id === 'saturation')!.value).toBeLessThan(0);
  });

  it('reduce contrast slightly → small negative contrast delta', () => {
    const r = parseNlRequest('Reduce the contrast slightly');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    const contrastDelta = r.deltas.find((d) => d.id === 'contrast')!;
    expect(contrastDelta.value).toBeLessThan(0);
    // "slightly" should produce a smaller magnitude than the default
    const rDefault = parseNlRequest('Reduce the contrast');
    if (rDefault.kind !== 'adjustments') return;
    const defaultDelta = rDefault.deltas.find((d) => d.id === 'contrast')!;
    expect(Math.abs(contrastDelta.value)).toBeLessThan(Math.abs(defaultDelta.value));
  });

  it('vignette → positive vignette delta', () => {
    const r = parseNlRequest('Add a vignette');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((d) => d.id === 'vignette')!.value).toBeGreaterThan(0);
  });

  it('remove vignette → vignette value of 0', () => {
    const r = parseNlRequest('Remove the vignette');
    expect(r.kind).toBe('adjustments');
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((d) => d.id === 'vignette')!.value).toBe(0);
  });

  it('lift shadows → positive shadows delta', () => {
    const r = parseNlRequest('Lift the shadows');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((d) => d.id === 'shadows')!.value).toBeGreaterThan(0);
  });
});

// ── Compound style requests ───────────────────────────────────────────────────

describe('parseNlRequest: compound style requests', () => {
  it('moody → contrast up, shadows down, vignette, saturation down', () => {
    const r = parseNlRequest('Make the background moodier');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((d) => d.id === 'contrast')!.value).toBeGreaterThan(0);
    expect(r.deltas.find((d) => d.id === 'shadows')!.value).toBeLessThan(0);
    expect(r.deltas.find((d) => d.id === 'vignette')!.value).toBeGreaterThan(0);
  });

  it('faded film appearance → fade + grain + reduced saturation', () => {
    const r = parseNlRequest('Create a faded film appearance');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((d) => d.id === 'fade')!.value).toBeGreaterThan(0);
    expect(r.deltas.find((d) => d.id === 'grain')!.value).toBeGreaterThan(0);
  });

  it('black and white → saturation −100', () => {
    const r = parseNlRequest('Black and white');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((d) => d.id === 'saturation')!.value).toBe(-100);
  });

  it('warm golden → positive warmth and temperature', () => {
    const r = parseNlRequest('Give it a warm golden look');
    expect(r.kind).toBe('adjustments');
    assertAllClamped(r);
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((d) => d.id === 'warmth')!.value).toBeGreaterThan(0);
  });
});

// ── Preset family requests ────────────────────────────────────────────────────

describe('parseNlRequest: preset family requests', () => {
  it('cinematic look → preset family cinematic', () => {
    const r = parseNlRequest('Give it a cinematic look');
    expect(r.kind).toBe('preset');
    if (r.kind !== 'preset') return;
    expect(r.presetFamily).toBe('cinematic');
  });

  it('natural portrait treatment → preset family natural', () => {
    const r = parseNlRequest('Suggest a natural portrait treatment');
    expect(r.kind).toBe('preset');
    if (r.kind !== 'preset') return;
    expect(r.presetFamily).toBe('natural');
  });

  it('vintage → preset family creative', () => {
    const r = parseNlRequest('Give it a vintage look');
    expect(r.kind).toBe('preset');
    if (r.kind !== 'preset') return;
    expect(r.presetFamily).toBe('creative');
  });
});

// ── Ambiguous requests ────────────────────────────────────────────────────────

describe('parseNlRequest: ambiguous requests', () => {
  it('"make it better" → ambiguous with 2–3 options', () => {
    const r = parseNlRequest('Make it better');
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    expect(r.options.length).toBeGreaterThanOrEqual(2);
    expect(r.options.length).toBeLessThanOrEqual(3);
    // Each option must have a label and description
    for (const opt of r.options) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.description.length).toBeGreaterThan(0);
    }
  });

  it('"improve" → ambiguous', () => {
    const r = parseNlRequest('Improve this photo');
    expect(r.kind).toBe('ambiguous');
  });

  it('"dramatic" → ambiguous with moody and cinematic options', () => {
    const r = parseNlRequest('Make it dramatic');
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    const ids = r.options.map((o) => o.id);
    expect(ids).toContain('moody');
    expect(ids).toContain('cinematic');
  });

  it('"more pop" → ambiguous with contrast and colour options', () => {
    const r = parseNlRequest('Give it more pop');
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    const ids = r.options.map((o) => o.id);
    expect(ids).toContain('contrast');
    expect(ids).toContain('colour');
  });

  it('ambiguity options carry deltas that are all within control ranges', () => {
    for (const phrase of ['Make it better', 'Give it more pop', 'Make it dramatic', 'Make it nice']) {
      const r = parseNlRequest(phrase);
      expect(r.kind, phrase).toBe('ambiguous');
      if (r.kind !== 'ambiguous') continue;
      for (const opt of r.options) {
        for (const d of opt.deltas) {
          const { min, max } = controlRange(d.id);
          expect(d.value, `${phrase} / ${opt.id} / ${d.id}`).toBeGreaterThanOrEqual(min);
          expect(d.value, `${phrase} / ${opt.id} / ${d.id}`).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it('every ambiguity option names a real knob or a real preset family', () => {
    const r = parseNlRequest('Make it better');
    if (r.kind !== 'ambiguous') return;
    for (const opt of r.options) {
      const usesPreset = opt.presetFamily !== undefined;
      const usesKnobs = opt.deltas.length > 0;
      // An option has to do something, and only with things the engine has.
      expect(usesPreset || usesKnobs, opt.id).toBe(true);
      for (const d of opt.deltas) expect(SUPPORTED_KNOBS).toContain(d.id);
    }
  });
});

// ── Unsupported requests ──────────────────────────────────────────────────────

describe('parseNlRequest: unsupported requests', () => {
  it('object removal → unsupported with suggestion', () => {
    const r = parseNlRequest('Remove the background');
    expect(r.kind).toBe('unsupported');
    if (r.kind !== 'unsupported') return;
    expect(r.suggestion).toBeTruthy();
  });

  it('sharpening → unsupported', () => {
    const r = parseNlRequest('Sharpen the image');
    expect(r.kind).toBe('unsupported');
  });

  it('crop → unsupported', () => {
    const r = parseNlRequest('Crop the photo');
    expect(r.kind).toBe('unsupported');
    /* The engine cannot perform a crop, but the stage can: the reply points at
       the control that exists rather than claiming the editor has none. */
    if (r.kind !== 'unsupported') return;
    expect(r.requested).toMatch(/crop/i);
    expect(r.suggestion).toMatch(/Framing/);
    expect(r.suggestion).toMatch(/1:1/);
  });

  it('rotation and overlays stay unsupported, and do not mention cropping', () => {
    for (const phrase of ['Rotate the photo 90 degrees', 'Add a border', 'Straighten the horizon']) {
      const r = parseNlRequest(phrase);
      expect(r.kind, phrase).toBe('unsupported');
    }
  });

  it('skin retouching → unsupported with suggestion', () => {
    const r = parseNlRequest('Smooth the skin');
    expect(r.kind).toBe('unsupported');
    if (r.kind !== 'unsupported') return;
    expect(r.suggestion).toBeTruthy();
  });

  it('sky replacement → unsupported', () => {
    const r = parseNlRequest('Change the sky');
    expect(r.kind).toBe('unsupported');
  });

  it('completely unrecognised text → unsupported with suggestion', () => {
    const r = parseNlRequest('xyzzy frobnicate the quux');
    expect(r.kind).toBe('unsupported');
    if (r.kind !== 'unsupported') return;
    expect(r.suggestion).toBeTruthy();
  });

  it('empty string → unsupported', () => {
    const r = parseNlRequest('');
    expect(r.kind).toBe('unsupported');
  });
});

// ── All adjustment values are always within control ranges ───────────────────

describe('parseNlRequest: all outputs are within control ranges', () => {
  const COMMANDS = [
    'Make it brighter',
    'Make it darker',
    'More contrast',
    'Less contrast',
    'Warmer colours',
    'Cooler tones',
    'More saturated',
    'Less saturated',
    'Add a vignette',
    'Add film grain',
    'Lift the shadows',
    'Recover highlights',
    'Moody',
    'Bright and airy',
    'Faded film appearance',
    'Black and white',
    'Street photography look',
  ];

  for (const cmd of COMMANDS) {
    it(`"${cmd}" produces clamped values`, () => {
      const r = parseNlRequest(cmd);
      assertAllClamped(r);
    });
  }
});

// ── The commands the interface offers ─────────────────────────────────────────

describe('parseNlRequest: the example requests the panel promises', () => {
  const EXAMPLES: Array<readonly [string, unknown]> = [
    ['Make this image brighter', 'adjustments'],
    ['Give it a cinematic look', 'preset'],
    ['Make the colours warmer', 'adjustments'],
    ['Reduce the contrast slightly', 'adjustments'],
    ['Create a faded film appearance', 'adjustments'],
    ['Make the background moodier', 'adjustments'],
    ['Suggest a natural portrait treatment', 'preset'],
    ['Make it less saturated', 'adjustments'],
  ];

  for (const [phrase, kind] of EXAMPLES) {
    it(`“${phrase}” is understood, not refused`, () => {
      const r = parseNlRequest(phrase);
      expect(r.kind).toBe(kind);
      expect(r.summary.length).toBeGreaterThan(0);
    });
  }

  it('the quick-access chips all do something', () => {
    for (const chip of [
      'Make it brighter',
      'Warmer colours',
      'More contrast',
      'Less saturated',
      'Cinematic look',
      'Faded film',
      'Moody',
      'Black and white',
    ]) {
      const r = parseNlRequest(chip);
      expect(r.kind === 'adjustments' || r.kind === 'preset', chip).toBe(true);
    }
  });
});

// ── Which way round ───────────────────────────────────────────────────────────

describe('parseNlRequest: direction is read the right way round', () => {
  const POLARITY: Array<readonly [string, string, (v: number) => boolean]> = [
    ['Make it darker', 'exposure', (v) => v < 0],
    ['it is too dark', 'exposure', (v) => v > 0],
    ['the sky is too bright', 'exposure', (v) => v < 0],
    ['Recover the highlights', 'highlights', (v) => v < 0],
    ['Brighten the highlights', 'highlights', (v) => v > 0],
    ['Deepen the shadows', 'shadows', (v) => v < 0],
    ['Lift the shadows', 'shadows', (v) => v > 0],
    ['crush the blacks', 'blacks', (v) => v < 0],
    ['make it flatter', 'contrast', (v) => v < 0],
    ['more punch', 'contrast', (v) => v > 0],
    ['over the top saturation', 'saturation', (v) => v < 0],
    ['increase the saturation', 'saturation', (v) => v > 0],
    ['make the colours cooler', 'warmth', (v) => v < 0],
    ['warmer', 'warmth', (v) => v > 0],
  ];

  for (const [phrase, id, test] of POLARITY) {
    it(`“${phrase}” moves ${id} the way it says`, () => {
      const r = parseNlRequest(phrase);
      expect(r.kind, phrase).toBe('adjustments');
      expect(test(valueOf(r, id)), `${phrase} → ${valueOf(r, id)}`).toBe(true);
    });
  }

  it('“remove the vignette” parks the knob at zero rather than pushing it negative', () => {
    const r = parseNlRequest('Remove the vignette');
    expect(r.kind).toBe('adjustments');
    if (r.kind !== 'adjustments') return;
    const d = r.deltas.find((x) => x.id === 'vignette')!;
    expect(d.value).toBe(0);
    expect(d.mode).toBe('set');
  });

  it('“add a vignette” asks for travel instead of an absolute value', () => {
    const r = parseNlRequest('Add a vignette');
    if (r.kind !== 'adjustments') return;
    expect(r.deltas.find((x) => x.id === 'vignette')!.mode).toBe('delta');
  });

  it('qualifiers scale the travel: slightly < plain < a lot', () => {
    const slight = valueOf(parseNlRequest('Increase the contrast slightly'), 'contrast');
    const plain = valueOf(parseNlRequest('Increase the contrast'), 'contrast');
    const lots = valueOf(parseNlRequest('Increase the contrast a lot'), 'contrast');
    expect(slight).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(slight);
    expect(lots).toBeGreaterThan(plain);
  });

  it('a sentence naming two axes moves both', () => {
    const r = parseNlRequest('make it darker and warmer');
    expect(r.kind).toBe('adjustments');
    if (r.kind !== 'adjustments') return;
    expect(valueOf(r, 'exposure')).toBeLessThan(0);
    expect(valueOf(r, 'warmth')).toBeGreaterThan(0);
  });
});

// ── Nothing invented ──────────────────────────────────────────────────────────

describe('parseNlRequest: nothing outside the engine is ever emitted', () => {
  const CORPUS = [
    'Make this image brighter', 'Give it a cinematic look', 'Make the colours warmer',
    'Reduce the contrast slightly', 'Create a faded film appearance', 'Make the background moodier',
    'Suggest a natural portrait treatment', 'Make it less saturated', 'Make it better',
    'Remove the background', 'Remove the vignette', 'no vignette please', 'less grain',
    'remove the grain', 'Smooth the skin', 'Sharpen the image', 'Crop the photo',
    'Change the sky', 'Denoise it', 'Upscale this', 'Lift the shadows', 'Deepen the shadows',
    'Recover the highlights', 'Make it darker', 'Add a vignette', 'Give it more pop',
    'Make it dramatic', 'warmer', 'cooler tones', 'increase the saturation a lot',
    'lower the contrast', 'boost the colour', 'make it flatter', 'more punch',
    'a bit more warmth', 'tone down the highlights', 'add some film grain', 'black and white',
    'vintage look', 'bright and airy', 'street photography look', 'nice', 'increase exposure',
    'too dark', 'very dark and moody', 'add warmth and lift the shadows', 'make the sky bluer',
    'soften the contrast', 'make it darker and warmer', 'warm up the skin tones',
    'make the whole frame brighter', 'brighten the image', 'add some contrast', 'raise the blacks',
    'crush the blacks', 'give it a matte look', 'less fade', 'dramatic landscape',
    'make the eyes brighter', 'make it look like film', 'push the colour harder',
    'xyzzy frobnicate the quux', 'hello there', 'i like photography',
  ];

  for (const phrase of CORPUS) {
    it(`“${phrase}” only ever names real knobs, in range`, () => {
      const r = parseNlRequest(phrase);
      if (r.kind === 'adjustments') {
        expect(r.deltas.length, phrase).toBeGreaterThan(0);
        for (const d of r.deltas) {
          expect(SUPPORTED_KNOBS, `${phrase} → ${d.id}`).toContain(d.id);
          const { min, max } = controlRange(d.id);
          expect(d.value, `${phrase} ${d.id}`).toBeGreaterThanOrEqual(min);
          expect(d.value, `${phrase} ${d.id}`).toBeLessThanOrEqual(max);
          expect(['delta', 'set'], phrase).toContain(d.mode);
        }
      } else if (r.kind === 'preset') {
        expect(['natural', 'cinematic', 'creative'], phrase).toContain(r.presetFamily);
      } else if (r.kind === 'ambiguous') {
        expect(r.options.length, phrase).toBeGreaterThanOrEqual(2);
        expect(r.options.length, phrase).toBeLessThanOrEqual(3);
      } else {
        expect(r.summary.length, phrase).toBeGreaterThan(0);
      }
    });
  }

  it('an unsupported request says what is missing and offers a way round it', () => {
    for (const phrase of ['Sharpen the image', 'Crop the photo', 'Remove the person in the background']) {
      const r = parseNlRequest(phrase);
      expect(r.kind, phrase).toBe('unsupported');
      if (r.kind !== 'unsupported') continue;
      expect(r.suggestion, phrase).toBeTruthy();
      expect(r.requested, phrase).toBeTruthy();
    }
  });
});

// ── Landing on top of the current edit ────────────────────────────────────────

describe('resolveDeltas: a command adds to the edit that is already there', () => {
  const at = (over: Partial<Adjustments>): Adjustments => ({ ...IDENTITY, ...over });

  it('a request read from an untouched photo matches the raw delta', () => {
    const r = parseNlRequest('Make it brighter');
    if (r.kind !== 'adjustments') return;
    const knobs = resolveDeltas(IDENTITY, r.deltas);
    expect(knobs.every((k) => k.before === IDENTITY[k.id])).toBe(true);
  });

  it('with a look already applied, the same request lands above it', () => {
    const r = parseNlRequest('Make it brighter');
    if (r.kind !== 'adjustments') return;
    const current = at({ exposure: 0.5, contrast: 20, vignette: 40 });
    const knobs = resolveDeltas(current, r.deltas);
    const exposure = knobs.find((k) => k.id === 'exposure')!;
    const requested = r.deltas.find((d) => d.id === 'exposure')!.value;
    expect(exposure.before).toBe(0.5);
    // 0.5 plus the same travel the request asked for, not the travel alone.
    expect(exposure.after).toBeCloseTo(0.5 + requested, 5);
    // Untouched knobs are not offered for change at all.
    expect(knobs.some((k) => k.id === 'vignette')).toBe(false);
  });

  it('a “set” delta wins over whatever the knob said before', () => {
    const r = parseNlRequest('Remove the vignette');
    if (r.kind !== 'adjustments') return;
    const [knob] = resolveDeltas(at({ vignette: 40 }), r.deltas);
    expect(knob.before).toBe(40);
    expect(knob.after).toBe(0);
  });

  it('results are clamped into the control range, never beyond it', () => {
    const r = parseNlRequest('Make it brighter');
    if (r.kind !== 'adjustments') return;
    const near = at({ exposure: 1.9, brightness: 95 });
    for (const k of resolveDeltas(near, r.deltas)) {
      const { min, max } = controlRange(k.id);
      expect(k.after).toBeLessThanOrEqual(max);
      expect(k.after).toBeGreaterThanOrEqual(min);
    }
  });

  it('a request against a knob already at its limit moves nothing', () => {
    const r = parseNlRequest('Make it brighter');
    if (r.kind !== 'adjustments') return;
    const ceiling = at({ exposure: 2, brightness: 100 });
    expect(movingKnobs(resolveDeltas(ceiling, r.deltas))).toHaveLength(0);
  });

  it('resolved values are the absolute recipe a proposal has to carry', () => {
    const r = parseNlRequest('Reduce the contrast slightly');
    if (r.kind !== 'adjustments') return;
    const current = at({ contrast: 20 });
    const merged = resolvedToAdjustments(resolveDeltas(current, r.deltas));
    const { min, max } = controlRange('contrast');
    expect(merged.contrast).toBeGreaterThanOrEqual(min);
    expect(merged.contrast).toBeLessThanOrEqual(max);
    expect(merged.contrast!).toBeLessThan(20);
    // Only the knobs the request names appear; the rest of the edit is left alone.
    expect(Object.keys(merged)).toEqual(['contrast']);
  });

  it('every knob the parser can name is one the engine actually draws', () => {
    expect(SUPPORTED_KNOBS).toEqual(CONTROLS.map((c) => c.id));
  });
});

// ── Honest about scope ────────────────────────────────────────────────────────

describe('parseNlRequest: local-scope wording is applied globally and says so', () => {
  it('naming one area adds a caveat explaining the engine has no masks', () => {
    const r = parseNlRequest('Make the background moodier');
    expect(r.kind).toBe('adjustments');
    if (r.kind !== 'adjustments') return;
    expect(r.caveat).toBeTruthy();
    expect(r.caveat).toMatch(/mask/i);
  });

  it('a look request aimed at one area is caveated too', () => {
    const r = parseNlRequest('a cinematic sky');
    expect(r.kind).toBe('preset');
    if (r.kind !== 'preset') return;
    expect(r.caveat).toBeTruthy();
  });

  it('a plain whole-image request gets no caveat', () => {
    const r = parseNlRequest('Make it brighter');
    if (r.kind !== 'adjustments') return;
    expect(r.caveat).toBeUndefined();
  });
});
