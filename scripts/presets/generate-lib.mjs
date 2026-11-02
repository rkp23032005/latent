/**
 * Shared machinery for the generated preset library.
 *
 * Two jobs: measure what a recipe really does, and turn a set of knob numbers
 * into plain editorial English. The measurement comes from the app's own
 * engine — `toPipelineParams` and `applyPipeline` — over the same fixed test
 * chart the browser uses, so a number written into `generated.json` is the
 * number the editor would show.
 *
 * `src/lib/preset/effect.ts` is the contract for those numbers and this script
 * uses it whenever the module loads — which generate.mjs arranges at startup.
 * The local copy below exists because effect.ts builds its chart at import
 * time: if that ever throws again (`PATCHES[Math.floor(t * 8)]` runs off the end
 * in the chart's last column unless the index is clamped), the build still has
 * the same chart and the same pipeline to measure against. The check script
 * proves the two agree byte for byte while both are available.
 */

import { CONTROLS, IDENTITY, clampToControl, toPipelineParams } from '../../src/lib/image/adjustments.ts';
import { applyPipeline } from '../../src/lib/image/pipeline.ts';

/** Every gate in the build, in one place so the summary can quote them. */
export const MIN_EFFECT = 2.0;
export const MIN_DISTANCE = 1.5;

export const KNOBS = CONTROLS.map((control) => control.id);

const CONTROL_BY_ID = new Map(CONTROLS.map((control) => [control.id, control]));

/* ------------------------------------------------------------------ *
 * The chart and the render, exactly as effect.ts states them.
 * ------------------------------------------------------------------ */

const PATCHES = [
  [232, 199, 172],
  [196, 214, 232],
  [74, 108, 66],
  [178, 62, 58],
  [64, 66, 70],
  [212, 176, 74],
  [30, 34, 40],
  [246, 246, 244],
];

export function makeEngineChart(width = 96, height = 64) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const t = x / (width - 1);
      const s = y / (height - 1);
      rgb[i] = Math.round(255 * (0.06 + 0.88 * t));
      rgb[i + 1] = Math.round(255 * (0.06 + 0.88 * (1 - t) * 0.4 + 0.5 * s));
      rgb[i + 2] = Math.round(255 * (0.1 + 0.75 * s));
      if (s > 0.72) {
        /* Clamped: `Math.floor(t * 8)` is 8 in the chart's last column. */
        const patch = Math.min(PATCHES.length - 1, Math.floor(t * PATCHES.length));
        rgb[i] = PATCHES[patch][0];
        rgb[i + 1] = PATCHES[patch][1];
        rgb[i + 2] = PATCHES[patch][2];
      }
    }
  }
  return { width, height, rgb };
}

const CHART = makeEngineChart();
const PIXEL = new Float32Array(3);

let renderInto = (adjust) => {
  const params = toPipelineParams({ ...IDENTITY, ...adjust });
  const out = new Uint8Array(CHART.rgb.length);
  for (let y = 0; y < CHART.height; y++) {
    for (let x = 0; x < CHART.width; x++) {
      const i = (y * CHART.width + x) * 3;
      PIXEL[0] = CHART.rgb[i] / 255;
      PIXEL[1] = CHART.rgb[i + 1] / 255;
      PIXEL[2] = CHART.rgb[i + 2] / 255;
      applyPipeline(PIXEL, params, {
        u: (x + 0.5) / CHART.width,
        v: (y + 0.5) / CHART.height,
        x,
        y,
      });
      out[i] = Math.max(0, Math.min(255, Math.round(PIXEL[0] * 255)));
      out[i + 1] = Math.max(0, Math.min(255, Math.round(PIXEL[1] * 255)));
      out[i + 2] = Math.max(0, Math.min(255, Math.round(PIXEL[2] * 255)));
    }
  }
  return out;
};

export let metricsSource = 'local copy of the engine chart (effect.ts was not importable)';

/**
 * Adopt the official chart renderer so the numbers in the build are the ones
 * the shipped module produces. Called from generate.mjs when the import works.
 */
export function useOfficialEffectModule(effect) {
  renderInto = (adjust) => effect.renderChart(adjust);
  metricsSource = 'src/lib/preset/effect.ts (official effectOf/distanceOf chart)';
}

/* ------------------------------------------------------------------ *
 * Signatures, quantisation, recipes.
 * ------------------------------------------------------------------ */

export function signatureOf(adjust) {
  return JSON.stringify(
    Object.entries({ ...IDENTITY, ...adjust }).sort(([x], [y]) => (x < y ? -1 : 1)),
  );
}

/** Slider values that the controls can actually represent, clamped and stepped. */
export function quantize(id, value) {
  const control = CONTROL_BY_ID.get(id);
  const stepped = Math.round(value / control.step) * control.step;
  /* Kill the binary noise a step of 0.05 leaves behind before clamping. */
  return clampToControl(id, Math.round(stepped * 1000) / 1000);
}

/**
 * The smallest move each knob is worth writing down. A preset that sets
 * warmth +1 is not asking for anything a photographer can see, so it is left
 * out of the recipe rather than described as if it were a decision.
 *
 * Every knob the engine owns is listed: an unlisted one would have no floor, so
 * a single-step import would be kept and counted as a choice.
 */
const VISIBLE = {
  exposure: 0.05,
  brightness: 3,
  contrast: 3,
  warmth: 4,
  saturation: 4,
  fade: 3,
  toning: 6,
  vignette: 4,
  highlights: 3,
  shadows: 3,
  whites: 3,
  blacks: 3,
  vibrance: 4,
  temperature: 3,
  tint: 3,
  grain: 3,
};

/** A whole editing state, with the knobs a preset never mentions left at zero. */
export function normalizeRecipe(values) {
  const adjust = {};
  for (const id of KNOBS) {
    const value = quantize(id, values[id] ?? IDENTITY[id]);
    if (value === IDENTITY[id]) continue;
    if (Math.abs(value) < VISIBLE[id]) continue;
    adjust[id] = value;
  }
  return adjust;
}

/** A knob's value as a share of its own full travel — how loud it is. */
export function travel(id, value) {
  const control = CONTROL_BY_ID.get(id);
  return Math.abs(value) / Math.max(Math.abs(control.min), Math.abs(control.max));
}


/* ------------------------------------------------------------------ *
 * Memoised measurement.
 * ------------------------------------------------------------------ */

const bytesBySignature = new Map();

export function bytesOf(adjust) {
  const key = signatureOf(adjust);
  let bytes = bytesBySignature.get(key);
  if (!bytes) {
    bytes = renderInto(adjust);
    bytesBySignature.set(key, bytes);
  }
  return bytes;
}

const BASE_BYTES = bytesOf({});

function meanAbsDifference(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += Math.abs(left[i] - right[i]);
  return sum / left.length;
}

/** Mean absolute change per channel, 0–255, against the untouched chart. */
export function effectOf(adjust) {
  return meanAbsDifference(bytesOf(adjust), BASE_BYTES);
}

/** How far apart two recipes look. */
export function distanceOf(a, b) {
  return meanAbsDifference(bytesOf(a), bytesOf(b));
}

/**
 * The same test, but it stops as soon as the pair is clearly far apart — the
 * build runs this against every accepted preset, so the early exit matters.
 */
export function isAtLeast(thisMany, a, b) {
  const left = bytesOf(a);
  const right = bytesOf(b);
  let sum = 0;
  const stop = thisMany * left.length;
  for (let i = 0; i < left.length; i++) {
    sum += Math.abs(left[i] - right[i]);
    if (sum >= stop) return true;
  }
  return sum / left.length >= thisMany;
}

/* ------------------------------------------------------------------ *
 * Deterministic randomness: a fixed seed, hashed per candidate, so a
 * recipe's jitter never depends on what order the loop happened to run in.
 * ------------------------------------------------------------------ */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashToSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------ *
 * English.
 * ------------------------------------------------------------------ */

function plus(value, digits = 0) {
  const abs = Math.abs(value).toFixed(digits);
  return value > 0 ? `+${abs}` : `−${abs}`;
}

function stopPhrase(ev) {
  if (ev <= 0.16) return 'a fraction of a stop';
  if (ev <= 0.42) return 'about a third of a stop';
  if (ev <= 0.75) return 'two thirds of a stop';
  if (ev <= 1.1) return 'roughly a stop';
  if (ev <= 1.45) return 'a stop and a half';
  return 'two stops or close to it';
}

/**
 * Plain English for what the recipe does to the picture: how much light, how
 * far apart its ends are, which way the balance leans, how much air is left in
 * the print. One phrase per knob the preset actually moves.
 */
function phraseFor(id, a) {
  switch (id) {
    case 'exposure':
      return a.exposure > 0
        ? `opens the light by ${stopPhrase(a.exposure)} (${plus(a.exposure, 2)} EV)`
        : `holds the light back by ${stopPhrase(-a.exposure)} (${plus(a.exposure, 2)} EV)`;
    case 'brightness':
      return `${a.brightness > 0 ? 'lifts' : 'drops'} the level of the whole print (${plus(a.brightness)})`;
    case 'contrast':
      return a.contrast > 0
        ? `tightens the distance between light and dark (${plus(a.contrast)})`
        : `relaxes the distance between light and dark (${plus(a.contrast)})`;
    case 'warmth':
      return a.warmth > 0
        ? `leans the balance warm, reds up and blues down (${plus(a.warmth)})`
        : `leans the balance cool, blues up and reds down (${plus(a.warmth)})`;
    case 'saturation':
      if (a.saturation <= -95) return 'drains the colour to grey';
      if (a.saturation < 0) return `quiets the colour (${plus(a.saturation)})`;
      if (a.saturation > 18) return `charges the colour up (${plus(a.saturation)})`;
      return `lifts the colour a little (${plus(a.saturation)})`;
    case 'fade':
      return a.fade >= 40
        ? `opens the blacks wide and pulls the whites back (fade ${Math.round(a.fade)})`
        : `lifts the blacks and softens the whites (fade ${Math.round(a.fade)})`;
    case 'toning':
      return `${Math.abs(a.toning) >= 40 ? 'splits the tone hard' : 'splits the tone'}, ${
        a.toning > 0 ? 'warm highlights over cool shadows' : 'cool highlights over warm shadows'
      } (${plus(a.toning)})`;
    case 'vignette':
      return a.vignette >= 40
        ? `closes hard on the corners (vignette ${Math.round(a.vignette)})`
        : `lets the corners fall away (vignette ${Math.round(a.vignette)})`;
    default:
      return null;
  }
}

/* The order a photographer reads an edit in: light, then colour, then print. */
const DESC_ORDER = ['exposure', 'brightness', 'contrast', 'warmth', 'saturation', 'fade', 'toning', 'vignette'];

function sentence(phrases) {
  const head = phrases.slice(0, -1).join(', ');
  const joined = phrases.length === 1 ? phrases[0] : `${head} and ${phrases[phrases.length - 1]}`;
  return joined.replace(/^([a-z])/, (_, c) => c.toUpperCase()) + '.';
}

/**
 * What each knob is *about*, in the same optical words the control hints use.
 * The opening line of a description names the two loudest knobs, so it can
 * never claim a shape the finished numbers do not have.
 */
const SUBJECT = {
  exposure: 'how much light is gathered',
  brightness: 'the level of the whole print',
  contrast: 'the distance between light and dark',
  warmth: 'the warm-to-cool balance',
  saturation: 'how much colour survives',
  fade: 'air in the blacks',
  toning: 'the split tone between shadows and highlights',
  vignette: 'the fall-off at the edges',
};

/* The family, stated as a fact about the frame — no film stock, no camera, no
   profile, nothing these knobs cannot deliver. */
const FAMILY = {
  Cinematic: 'A cinematic frame',
  Warm: 'A warm-balance frame',
  Cool: 'A cool-balance frame',
  Vintage: 'An aged-print frame',
  'Film-inspired': 'A print-like frame, built from this engine’s own knobs and no film stock',
  Portrait: 'A portrait frame',
  Travel: 'A travel frame',
  Landscape: 'A landscape frame',
  Natural: 'A restrained frame',
  Moody: 'A low-key frame',
  Dreamy: 'A soft frame',
  Editorial: 'A graphic, print-ready frame',
  'Bright and airy': 'A bright, airy frame',
  'Street photography': 'A street frame',
  'Night photography': 'A night frame',
  'Black and white': 'A black-and-white print',
  'Faded film': 'A faded print',
  'Social media photography': 'A small-screen frame',
};

/**
 * The card text: the family and the two loudest moves it is built on, then
 * exactly what these numbers do, clause by clause, to the picture.
 */
export function descriptionFor(category, adjust) {
  const a = { ...IDENTITY, ...adjust };
  const moved = DESC_ORDER.filter((id) => a[id] !== 0);
  const family = FAMILY[category] ?? `A ${category.toLowerCase()} frame`;
  if (moved.length === 0) return `${family}, with nothing for the engine to change.`;

  const loudest = [...moved].sort((x, y) => travel(y, a[y]) - travel(x, a[x])).slice(0, 2);
  const lead = `${family} built mainly on ${loudest.map((id) => SUBJECT[id]).join(' and ')}.`;

  const tone = moved.filter((id) => ['exposure', 'brightness', 'contrast'].includes(id)).map((id) => phraseFor(id, a));
  const colour = moved.filter((id) => ['warmth', 'saturation'].includes(id)).map((id) => phraseFor(id, a));
  const print = moved.filter((id) => ['fade', 'toning', 'vignette'].includes(id)).map((id) => phraseFor(id, a));
  const measured = [tone, colour, print].filter((list) => list.length > 0).map(sentence).join(' ');
  return `${lead} ${measured}`;
}

/**
 * What each knob of this recipe was asked to do, one honest line per knob the
 * preset actually sets. Generated presets are written for this engine, so the
 * arrow points from our own control to our own control — no invented source
 * vocabulary, no claim of a mapping that did not happen.
 */
const MAPPED_NOTE = {
  exposure: 'exposure (gain on scene-linear light, in stops)',
  brightness: 'brightness (one additive level across the print)',
  contrast: 'contrast (slope about mid grey)',
  warmth: 'warmth (one red/blue gain bias)',
  saturation: 'saturation (mix toward and away from luma)',
  fade: 'fade (blacks lifted, whites pulled in together)',
  toning: 'toning (one split-tone axis about luma)',
  vignette: 'vignette (one radial corner amount)',
  highlights: 'highlights (a gain weighted to the bright end)',
  shadows: 'shadows (a gain weighted to the dark end)',
  whites: 'whites (a gain weighted to where the print stops)',
  blacks: 'blacks (a gain weighted to where the print starts)',
  vibrance: 'vibrance (saturation scaled by how saturated the pixel already is)',
  temperature: 'temperature (red/blue gains on the white balance stage)',
  tint: 'tint (green/magenta gains on the white balance stage)',
  grain: 'grain (one amount, scattered from the shared grain map)',
};

export function mappedFor(adjust) {
  return KNOBS.filter((id) => adjust[id] !== undefined).map((id) => `${id} → ${MAPPED_NOTE[id]}`);
}

/**
 * Only where the recipe genuinely asks for something these knobs cannot
 * give it. Anything else stays silent rather than padding the card.
 */
export function limitationFor(adjust) {
  const a = { ...IDENTITY, ...adjust };
  if (a.saturation <= -95) {
    return 'Grey is a flat desaturation — no per-hue channel mixer, so reds and blues fall to the same luminance.';
  }
  if (a.saturation <= -80) {
    return 'Near-grey by heavy desaturation only; a little colour still survives in the most saturated patches.';
  }
  if (a.exposure >= 1.2 && a.fade <= 6) {
    return 'With this much gain and almost no fade the top of the scale flattens: highlights block up rather than roll off.';
  }
  if (a.exposure <= -1.2 && a.fade <= 6) {
    return 'With this much loss and almost no fade the bottom of the scale flattens: shadows block up rather than roll off.';
  }
  if (a.contrast >= 80) {
    return 'Contrast this steep is one straight slope; both ends of the scale clip before the middle does.';
  }
  return undefined;
}

export function kebab(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const ROMAN = ['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

export function ordinalLabel(count) {
  return ROMAN[count] ?? String(count);
}

