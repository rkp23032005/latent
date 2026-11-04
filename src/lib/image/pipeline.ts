/**
 * The processing pipeline: one ordered list of stages, each written twice.
 *
 * Every stage carries the GLSL that the GPU runs and the JavaScript step that
 * the CPU path runs, side by side, so the two renderers cannot drift apart.
 * `buildChannelLuts` folds the stages that touch one channel at a time into
 * three 256-entry tables — which is why the fallback is a table lookup rather
 * than three `Math.pow` calls per pixel.
 *
 * Only `exposure` works on scene-linear light. The rest are display-referred:
 * they operate on the sRGB numbers the panel will actually show, which is how
 * a brightness or contrast knob behaves in a normal darkroom tool.
 *
 * The skin guard is deliberately absent from this list. It reads the untouched
 * pixel, which no stage can do once the per-channel half has been folded into
 * three tables, so it runs after the chain in each renderer instead. See
 * `skinGuard.ts`.
 */

import type { PipelineParams } from './adjustments';
import { GRAIN_SIZE, grainAt } from './grain.ts';
import { SKIN_GUARD_GLSL, SKIN_GUARD_GLSL_PRELUDE } from './skinGuard.ts';

/**
 * Where a pixel sits, for the stages that care about position.
 *
 * `u`/`v` are the place in the frame; `x`/`y` are the *output* pixel
 * coordinates, with `y` counted from the top. Grain is indexed by the second
 * pair, because that is the only pair the GPU and the fallback can agree on
 * exactly — `gl_FragCoord` gives the same integers with `y` flipped.
 */
export type Pixel = { readonly u: number; readonly v: number; readonly x: number; readonly y: number };

export const ORIGIN: Pixel = { u: 0.5, v: 0.5, x: 0, y: 0 };

export type Stage = {
  readonly id: string;
  /** False when a channel reads its neighbours, which rules out a LUT. */
  readonly perChannel: boolean;
  readonly glsl: string;
  readonly step: (c: Float32Array, p: PipelineParams, px: Pixel) => void;
};

export const MID_GREY = 0.5;
export const LUMA = [0.2126, 0.7152, 0.0722] as const;

/* The two halves of a split tone, as channel biases. A print with warm
   highlights and cool shadows is the common one, so positive toning does that
   and negative toning swaps the two. */
export const SPLIT_WARM = [0.12, 0.02, -0.13] as const;
export const SPLIT_COOL = [-0.11, -0.01, 0.14] as const;

/** The sRGB transfer function, matching the GLSL below bit for bit. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** The GLSL `smoothstep`, including its clamping, so zone weights match. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* Each zone knob is a gain in stops, applied only where its own weight says
   to. The weight reads the channel's display value, so a stage that touches
   one channel on the GPU still touches one channel in the LUT. */
const ZONES = [
  { param: 'highlights' as const, edge0: 0.4, edge1: 0.9, invert: false, uniform: 'uHighlights' },
  { param: 'shadows' as const, edge0: 0.1, edge1: 0.6, invert: true, uniform: 'uShadows' },
  { param: 'whites' as const, edge0: 0.65, edge1: 1.0, invert: false, uniform: 'uWhites' },
  { param: 'blacks' as const, edge0: 0.0, edge1: 0.35, invert: true, uniform: 'uBlacks' },
];

/* Written as `vec3(0.40)` and not `vec3(0.4)`, because a number that prints
   without a decimal point is an integer to GLSL — and integer arguments do not
   match the smoothstep overloads this stage needs. */
function zoneGlsl(z: (typeof ZONES)[number]): string {
  const ramp = `smoothstep(vec3(${z.edge0.toFixed(2)}), vec3(${z.edge1.toFixed(2)}), c)`;
  const weight = z.invert ? `1.0 - ${ramp}` : ramp;
  return `  c = linearToSrgb(srgbToLinear(c) * exp2(vec3(${z.uniform}) * (${weight})));`;
}

function zoneStep(z: (typeof ZONES)[number]): Stage['step'] {
  return (c, p) => {
    for (let i = 0; i < 3; i++) {
      const w = z.invert ? 1 - smoothstep(z.edge0, z.edge1, c[i]) : smoothstep(z.edge0, z.edge1, c[i]);
      c[i] = linearToSrgb(srgbToLinear(c[i]) * Math.pow(2, p[z.param] * w));
    }
  };
}

export const STAGES: readonly Stage[] = [
  {
    id: 'exposure',
    perChannel: true,
    glsl: '  c = linearToSrgb(srgbToLinear(c) * uGain);',
    step: (c, p) => {
      c[0] = linearToSrgb(srgbToLinear(c[0]) * p.gain);
      c[1] = linearToSrgb(srgbToLinear(c[1]) * p.gain);
      c[2] = linearToSrgb(srgbToLinear(c[2]) * p.gain);
    },
  },
  {
    id: 'brightness',
    perChannel: true,
    glsl: '  c = c + uAdd;',
    step: (c, p) => {
      c[0] += p.add;
      c[1] += p.add;
      c[2] += p.add;
    },
  },
  {
    id: 'contrast',
    perChannel: true,
    glsl: '  c = (c - MID_GREY) * uSlope + MID_GREY;',
    step: (c, p) => {
      c[0] = (c[0] - MID_GREY) * p.slope + MID_GREY;
      c[1] = (c[1] - MID_GREY) * p.slope + MID_GREY;
      c[2] = (c[2] - MID_GREY) * p.slope + MID_GREY;
    },
  },
  {
    id: 'fade',
    perChannel: true,
    glsl: '  c = c * uFadeSpan + uFadeFloor;',
    step: (c, p) => {
      c[0] = c[0] * p.fadeSpan + p.fadeFloor;
      c[1] = c[1] * p.fadeSpan + p.fadeFloor;
      c[2] = c[2] * p.fadeSpan + p.fadeFloor;
    },
  },
  {
    id: 'warmth',
    perChannel: true,
    glsl: '  c = c * vec3(uWarmR, 1.0, uWarmB);',
    step: (c, p) => {
      c[0] *= p.warmR;
      c[2] *= p.warmB;
    },
  },
  ...ZONES.map((z) => ({ id: z.param, perChannel: true, glsl: zoneGlsl(z), step: zoneStep(z) })),
  {
    /* The raw white balance axis, on top of the Quick Edit bias. Green is
       deliberately left out of Warmth's two-channel trick: this is the knob
       that adds the axis the simpler one does not have. */
    id: 'temperature',
    perChannel: true,
    glsl: '  c = c * vec3(uTempR, uTempG, uTempB);',
    step: (c, p) => {
      c[0] *= p.tempR;
      c[1] *= p.tempG;
      c[2] *= p.tempB;
    },
  },
  {
    /* Saturation that asks how saturated the pixel already is: the flat parts
       get the push, the already-bright ones are left alone, so skin does not
       turn orange while a washed-out sky wakes up. */
    id: 'vibrance',
    perChannel: false,
    glsl: `  {
    float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float l = dot(c, LUMA);
    c = l + (c - vec3(l)) * (1.0 + uVibrance * (1.0 - chroma));
  }`,
    step: (c, p) => {
      const chroma = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
      const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
      const f = 1 + p.vibrance * (1 - chroma);
      c[0] = l + (c[0] - l) * f;
      c[1] = l + (c[1] - l) * f;
      c[2] = l + (c[2] - l) * f;
    },
  },
  {
    id: 'saturation',
    perChannel: false,
    glsl: '  c = mix(vec3(dot(c, LUMA)), c, uSaturation);',
    step: (c, p) => {
      const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
      c[0] = l + p.saturation * (c[0] - l);
      c[1] = l + p.saturation * (c[1] - l);
      c[2] = l + p.saturation * (c[2] - l);
    },
  },
  {
    /* After saturation, so a toned black-and-white print keeps its colour
       even when the photograph itself has been drained of it. */
    id: 'toning',
    perChannel: false,
    glsl: `  {
    float l = dot(c, LUMA);
    float positive = step(0.0, uToning);
    vec3 inHigh = mix(vec3(${SPLIT_COOL.join(', ')}), vec3(${SPLIT_WARM.join(', ')}), positive);
    vec3 inLow = mix(vec3(${SPLIT_WARM.join(', ')}), vec3(${SPLIT_COOL.join(', ')}), positive);
    c = c * (1.0 + abs(uToning) * (inHigh * l + inLow * (1.0 - l)));
  }`,
    step: (c, p) => {
      const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
      const high = p.toning >= 0 ? SPLIT_WARM : SPLIT_COOL;
      const low = p.toning >= 0 ? SPLIT_COOL : SPLIT_WARM;
      const a = Math.abs(p.toning);
      c[0] *= 1 + a * (high[0] * l + low[0] * (1 - l));
      c[1] *= 1 + a * (high[1] * l + low[1] * (1 - l));
      c[2] *= 1 + a * (high[2] * l + low[2] * (1 - l));
    },
  },
  {
    /* Grain sits after the colour decisions and before the vignette, so the
       scatter is printed through the look rather than coloured by it. The two
       paths read the identical byte: `gl_FragCoord.x` is already x + 0.5, and
       the flip of y is the same one the framebuffer makes. */
    id: 'grain',
    perChannel: false,
    glsl: `  {
    float l = dot(c, LUMA);
    vec2 nq = mod(vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y), ${GRAIN_SIZE}.0) / ${GRAIN_SIZE}.0;
    float n = texture2D(uNoise, nq).r - 0.5;
    c += vec3(n * uGrain * (0.25 + 0.75 * (1.0 - abs(2.0 * l - 1.0))));
  }`,
    step: (c, p, px) => {
      const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
      const n = grainAt(px.x, px.y);
      const a = n * p.grain * (0.25 + 0.75 * (1 - Math.abs(2 * l - 1)));
      c[0] += a;
      c[1] += a;
      c[2] += a;
    },
  },
  {
    id: 'vignette',
    perChannel: false,
    glsl: `  {
    vec2 off = vUv - 0.5;
    c = c * (1.0 - uVignette * dot(off, off) * 2.0);
  }`,
    step: (c, p, px) => {
      const du = px.u - 0.5;
      const dv = px.v - 0.5;
      const f = 1 - p.vignette * (du * du + dv * dv) * 2;
      c[0] *= f;
      c[1] *= f;
      c[2] *= f;
    },
  },
];

/** The whole chain, in order. Used by the CPU reference and by the tests. */
export function applyPipeline(c: Float32Array, p: PipelineParams, px: Pixel = ORIGIN): void {
  for (const stage of STAGES) stage.step(c, p, px);
}

/**
 * Three tables covering the 256 possible input bytes. Feeding the same value
 * to all three channels is enough to read off each channel's own mapping,
 * because a per-channel stage never lets one channel influence another.
 *
 * The fold is only honest while every per-channel stage sits in front of every
 * cross-channel one; move a stage across that line and the fallback silently
 * reorders the chain.
 */
export function buildChannelLuts(p: PipelineParams): Float32Array {
  const luts = new Float32Array(3 * 256);
  const c = new Float32Array(3);
  for (let i = 0; i < 256; i++) {
    c[0] = c[1] = c[2] = i / 255;
    for (const stage of STAGES) {
      if (stage.perChannel) stage.step(c, p, ORIGIN);
    }
    luts[i] = c[0];
    luts[256 + i] = c[1];
    luts[512 + i] = c[2];
  }
  return luts;
}

/** The stages left over once the LUTs have done their share. */
export function applyCrossChannel(c: Float32Array, p: PipelineParams, px: Pixel = ORIGIN): void {
  for (const stage of STAGES) {
    if (!stage.perChannel) stage.step(c, p, px);
  }
}

export const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/** One uniform per parameter, so the order of stages is the only coupling. */
export const PARAM_UNIFORMS: ReadonlyArray<readonly [keyof PipelineParams, string]> = [
  ['gain', 'uGain'],
  ['add', 'uAdd'],
  ['slope', 'uSlope'],
  ['fadeFloor', 'uFadeFloor'],
  ['fadeSpan', 'uFadeSpan'],
  ['warmR', 'uWarmR'],
  ['warmB', 'uWarmB'],
  ['highlights', 'uHighlights'],
  ['shadows', 'uShadows'],
  ['whites', 'uWhites'],
  ['blacks', 'uBlacks'],
  ['tempR', 'uTempR'],
  ['tempG', 'uTempG'],
  ['tempB', 'uTempB'],
  ['vibrance', 'uVibrance'],
  ['saturation', 'uSaturation'],
  ['toning', 'uToning'],
  ['grain', 'uGrain'],
  ['vignette', 'uVignette'],
  ['skinGuard', 'uSkinGuard'],
];

/* The grain tile's size in output pixels and the position of the before/after
   divider are bound by the renderer, not by the parameter set: one is a
   texture lookup and the other is a view choice, not a grade. */

export function fragmentShader(): string {
  const uniforms = PARAM_UNIFORMS.map(([, name]) => `uniform float ${name};`).join('\n');
  const bodies = STAGES.map((stage) => stage.glsl).join('\n');
  return `
precision highp float;

varying vec2 vUv;
uniform sampler2D uImage;
uniform sampler2D uNoise;
${uniforms}
uniform float uHeight;
uniform float uSplit;

const float MID_GREY = 0.5;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float srgbToLinear(float v) {
  return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
}

vec3 srgbToLinear(vec3 c) {
  return vec3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

float linearToSrgb(float v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

vec3 linearToSrgb(vec3 c) {
  return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b));
}
${SKIN_GUARD_GLSL_PRELUDE}
void main() {
  vec4 texel = texture2D(uImage, vUv);
  /* Left of the divider the untouched photograph is shown exactly as it
     arrived — the same source, before any stage of this chain. */
  if (uSplit >= 0.0 && vUv.x < uSplit) {
    gl_FragColor = texel;
    return;
  }
  vec3 c = texel.rgb;
${bodies}
${SKIN_GUARD_GLSL}
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), texel.a);
}
`;
}
