/**
 * Skin tone preservation: a colour band, applied at the end of the render.
 *
 * The idea is small enough to state exactly. Grade the pixel as the recipe
 * says, then work out what that pixel would look like if the grade had moved
 * only its *light* and not its *colour* — and blend the two by how strongly the
 * untouched pixel reads as skin. So exposure, contrast, fade and the four zone
 * knobs keep working on skin; the colour moves — saturation, vibrance, split
 * toning and the casts they produce — are held back there.
 *
 * ## What it is not
 *
 * There is no person, no face and no body here. The weight is arithmetic on the
 * red-minus-luma and blue-minus-luma of the **original** pixel, so it protects
 * any pixel in that colour rectangle — a face, a hand, but also a wooden table,
 * a sand wall or an autumn field — and releases any pixel outside it, including
 * a face under a strong cool or green cast. `skinGuard.test.ts` measures which
 * colours are in and out rather than asserting that they are, and the panel copy
 * says the same thing in one sentence.
 *
 * ## Where it sits
 *
 * Not in `STAGES`. A stage sees one channel or one already-graded pixel, never
 * the source, and the per-channel half of the chain is folded into three lookup
 * tables — so a stage that needed the original colour would either break the
 * fold or take the fallback off its tables. This is a post-pipeline composite
 * instead, which is also the exact seam a real segmentation mask would ride on
 * (see `lib/ai/segmentation.ts` for why there is not one yet). Every renderer
 * therefore applies it as its own last step, from pixels it already has:
 * `renderer.ts` on both paths, which is the stage and — because export draws
 * through the same renderer — the printed file.
 *
 * The preset cards are drawn *without* it, and so is every measurement the
 * assistant makes of a look. The guard is not part of a look: it is a protection
 * the user sets over the result, so a card always shows what the recipe does and
 * the panel says as much.
 *
 * ## The band
 *
 * Restated from the chroma rectangle conventionally quoted for skin in 8-bit
 * YCbCr — Cb 77 to 127 and Cr 133 to 173 — in this engine's 0–1 display units.
 * The two conventions meet at the widest excursion each axis can make: with
 * `Y = 0.299R + 0.587G + 0.114B`, `(B − Y)` spans ±0.886 and `(R − Y)` ±0.701,
 * so the byte forms are `Cb = 128 + 143.3(B − Y)` and `Cr = 128 + 181.2(R − Y)`
 * and the rectangle lands at `(R − Y)` 0.0276 to 0.2484 and `(B − Y)` −0.356 to
 * −0.007. The edges ramp rather than clamp, so a pixel just outside the
 * rectangle is protected a little instead of not at all.
 *
 * It is a design choice with measured consequences, listed in
 * `skinGuard.test.ts`, not a claim about human skin: within the band sit faces
 * and hands across a wide range of complexions, and also sand, timber, brick and
 * autumn light. Outside it sit blue and green, neutral grey, white paper and any
 * pixel the cast of the light has pushed cool. The luma gate exists because a
 * near-black or near-white pixel has no colour left to protect.
 *
 * ## What the tests measured
 *
 * Four numbers worth knowing before trusting this with a face.
 *
 * — Ten complexions from very light to near-black, plus sand, timber and brick,
 * all weigh 1.000. Nine non-skin colours — sky, foliage, teal, grey concrete,
 * white paper, a saturated red, sunset and autumn orange, deep shadow — all
 * weigh 0.000. Nothing in that census sits on a ramp, which is why the band
 * looks binary until a pixel is actually near an edge.
 *
 * — The guard is not uniform in how firmly it holds. Dimming the red channel
 * until each complexion leaves the band takes it to 0.92 for the palest swatch
 * and 0.85 for the near-black one, but 0.72 for a brown mid-tone: the grip is
 * proportional to how far the colour sits from grey, so a strong cool look
 * removes the protection from pale and very dark skin first. That is a property
 * of a rectangle in colour space, and no amount of tuning a mask-free method
 * fixes it.
 *
 * — On the studio portrait, at the 64×64 yardstick every measurement here uses,
 * 2172 of 4096 pixels — 53% of the frame — are in the band. Some of that is the
 * face and hands; the rest is the warm backdrop. On a photograph that is mostly
 * warm, the guard is a whole-image saturation limiter with a colour test in
 * front of it, not a skin effect.
 *
 * — Where it does protect, it works: the protected pixels' mean chroma under a
 * heavy colour look falls from 0.329 to 0.101 while their luma is unchanged to
 * within a float, and pixels outside the band come out of the renderer bit for
 * bit as the recipe made them.
 */

export type SkinBand = {
  readonly red: readonly [number, number];
  readonly blue: readonly [number, number];
  readonly luma: readonly [number, number];
};

/** The rectangle's edges, in the 0–1 display units the pipeline works in. */
export const SKIN_BAND: SkinBand = {
  /** Red against luma: how warm the pixel is. */
  red: [0.0276, 0.2484],
  /** Blue against luma: how yellow it is — skin sits below the neutral line. */
  blue: [-0.356, -0.007],
  /** Luma: the range the colour test is allowed to speak about. */
  luma: [0.05, 0.96],
};

/** How far each chroma edge fades out, in the same units as the axis it is on. */
export const CHROMA_RAMP = 0.006;
/** The luma edges ramp wider: that axis runs 0–1, and a hard cut shows as a band. */
export const LUMA_RAMP = 0.05;

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

/** One edge: 0 before it, 1 after it, smooth across `width` centred on `at`. */
function edge(value: number, at: number, width: number): number {
  const t = Math.min(1, Math.max(0, (value - (at - width / 2)) / width));
  return t * t * (3 - 2 * t);
}

/** Between two edges, fading out by `width` past each of them. */
function between(value: number, lo: number, hi: number, width: number): number {
  return edge(value, lo, width) * (1 - edge(value, hi, width));
}

/**
 * How much of this *untouched* pixel reads as skin, 0–1.
 *
 * `red` and `blue` are the channel differences against luma, so a grey is
 * (0, 0) and falls outside both chroma axes. The three tests multiply: a pixel
 * only reaches 1 by sitting inside the rectangle and the luma gate at once.
 */
export function skinWeight(red: number, blue: number, luma: number): number {
  const warm = between(red, SKIN_BAND.red[0], SKIN_BAND.red[1], CHROMA_RAMP);
  const yellow = between(blue, SKIN_BAND.blue[0], SKIN_BAND.blue[1], CHROMA_RAMP);
  const lit = between(luma, SKIN_BAND.luma[0], SKIN_BAND.luma[1], LUMA_RAMP);
  return warm * yellow * lit;
}

/** The weight for a pixel given as three floats in 0–1 display units. */
export function skinWeightOfSource(r: number, g: number, b: number): number {
  const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  return skinWeight(r - y, b - y, y);
}

/**
 * The guard, in place.
 *
 * `graded` is the pixel that has been through the whole pipeline and is modified
 * here; `source` is the same pixel exactly as it arrived, which is why callers
 * hand over bytes they have already read rather than asking for a second grade.
 * `strength` is `PipelineParams.skinGuard`, 0–1: at 0 nothing is written.
 *
 * The preserved pixel takes the grade's luma and the original's chroma, scaled
 * by how far the grade moved the light (`follow`), so a face the recipe darkens
 * does not come back glowing. The ratio is capped either side: a shadow the
 * grade lifts by ten times should not carry ten times the colour with it.
 */
export function applySkinGuard(
  graded: Float32Array,
  source: ArrayLike<number>,
  strength: number,
): void {
  if (strength <= 0) return;
  const sr = source[0];
  const sg = source[1];
  const sb = source[2];
  const sy = LUMA_R * sr + LUMA_G * sg + LUMA_B * sb;
  const weight = strength * skinWeight(sr - sy, sb - sy, sy);
  if (weight <= 0) return;
  const gy = LUMA_R * graded[0] + LUMA_G * graded[1] + LUMA_B * graded[2];
  const follow = Math.min(4, Math.max(0.25, gy / Math.max(sy, 0.08)));
  const keep = 1 - weight;
  graded[0] = graded[0] * keep + (gy + (sr - sy) * follow) * weight;
  graded[1] = graded[1] * keep + (gy + (sg - sy) * follow) * weight;
  graded[2] = graded[2] * keep + (gy + (sb - sy) * follow) * weight;
}

/**
 * The same arithmetic for the graphics card, kept beside the JavaScript so the
 * two can be read against each other. `texel` is the untouched pixel and `c`
 * the graded one, which is exactly the pair `applySkinGuard` takes; the luma
 * gate uses its own edge width, so it is a separate helper.
 */
export const SKIN_GUARD_GLSL = `  if (uSkinGuard > 0.0) {
    float sy = dot(texel.rgb, SKIN_LUMA);
    float sr = texel.r - sy;
    float sb = texel.b - sy;
    float warm = skinChromaEdge(sr, ${SKIN_BAND.red[0]}) * (1.0 - skinChromaEdge(sr, ${SKIN_BAND.red[1]}));
    float yellow = skinChromaEdge(sb, ${SKIN_BAND.blue[0]}) * (1.0 - skinChromaEdge(sb, ${SKIN_BAND.blue[1]}));
    float lit = skinLumaEdge(sy, ${SKIN_BAND.luma[0]}) * (1.0 - skinLumaEdge(sy, ${SKIN_BAND.luma[1]}));
    float w = uSkinGuard * warm * yellow * lit;
    if (w > 0.0) {
      float gy = dot(c, SKIN_LUMA);
      float follow = clamp(gy / max(sy, 0.08), 0.25, 4.0);
      vec3 held = vec3(gy) + (texel.rgb - vec3(sy)) * follow;
      c = mix(c, held, w);
    }
  }`;

export const SKIN_GUARD_GLSL_PRELUDE = `
const vec3 SKIN_LUMA = vec3(${LUMA_R}, ${LUMA_G}, ${LUMA_B});

float skinChromaEdge(float value, float at) {
  float t = clamp((value - (at - ${CHROMA_RAMP / 2})) / ${CHROMA_RAMP}, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float skinLumaEdge(float value, float at) {
  float t = clamp((value - (at - ${LUMA_RAMP / 2})) / ${LUMA_RAMP}, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
`;
