/**
 * Natural-language editing parser.
 *
 * Converts free-text user requests into validated editing instructions that
 * the existing engine can execute. This is a rule-based parser — no external
 * model, no network requests, no arbitrary code execution.
 *
 * ## Design rules
 * - Every output parameter is validated against the CONTROLS ranges of the
 *   editing engine before it leaves this module. Nothing out of range ever
 *   reaches the renderer, and no knob id is emitted that the engine lacks.
 * - Preset IDs are never invented here. A request that wants a *look* resolves
 *   to a family (natural / cinematic / creative) and the caller picks a real
 *   preset from the loaded library, or says the library has none.
 * - Deltas are relative by default, so a command lands on top of the current
 *   edit instead of replacing it. `resolveDeltas` does that arithmetic.
 * - Ambiguous requests produce a small set of named options; the caller
 *   presents them and waits for the user to choose one.
 * - Unsupported requests produce an explanation and, where possible, a
 *   suggestion of what is available instead.
 * - Requests aimed at one area of the photograph are applied globally and say
 *   so, because the engine has no local masks. Skin tone is the single named
 *   area with something honest to offer, and the wording points at the guard.
 */

import {
  CONTROLS,
  IDENTITY,
  clampAdjustments,
  clampToControl,
  type AdjustmentId,
  type Adjustments,
} from '../image/adjustments';
import { REGION_CAVEAT, SKIN_REGION_CAVEAT, SKIN_REGION_NOTE } from './segmentation';
import type { Preset } from '../preset/schema';

// ── Output types ─────────────────────────────────────────────────────────────

/** How a delta combines with whatever the knob already says. */
export type DeltaMode =
  /** Add the requested travel to the current value. */
  | 'delta'
  /** Park the knob at this value, however it reads now. */
  | 'set';

/** A validated move for one knob. */
export type AdjustmentDelta = {
  readonly id: AdjustmentId;
  /**
   * For `delta`: the travel requested, measured from the knob's identity.
   * For `set`: the absolute target. Already clamped to the control's range.
   */
  readonly value: number;
  readonly mode: DeltaMode;
  /** The engine's own name for this knob, so the UI never invents one. */
  readonly label: string;
};

/** One named option offered when a request is ambiguous. */
export type AmbiguityOption = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The deltas this option would apply, relative to the current edit. */
  readonly deltas: readonly AdjustmentDelta[];
  /** Preset family to use instead of raw deltas, if applicable. */
  readonly presetFamily?: 'natural' | 'cinematic' | 'creative';
};

export type ParsedInstruction =
  | {
      readonly kind: 'adjustments';
      /** Short description of what will happen. */
      readonly summary: string;
      /** The validated deltas to apply. */
      readonly deltas: readonly AdjustmentDelta[];
      /** Set when the request named one area but the change is global. */
      readonly caveat?: string;
    }
  | {
      readonly kind: 'preset';
      readonly summary: string;
      readonly presetFamily: 'natural' | 'cinematic' | 'creative';
      readonly caveat?: string;
    }
  | {
      readonly kind: 'ambiguous';
      readonly summary: string;
      /** Two or three options for the user to choose from. */
      readonly options: readonly AmbiguityOption[];
    }
  | {
      readonly kind: 'unsupported';
      readonly summary: string;
      /** What the user asked for. */
      readonly requested: string;
      /** What is available instead, if anything. */
      readonly suggestion?: string;
    };

// ── Delta builders ────────────────────────────────────────────────────────────

/** Requested travel from wherever the knob currently sits. */
function delta(id: AdjustmentId, value: number): AdjustmentDelta {
  return { id, value: clampToControl(id, value), mode: 'delta', label: labelOf(id) };
}

/** A knob parked at a stated value. */
function setTo(id: AdjustmentId, value: number): AdjustmentDelta {
  return { id, value: clampToControl(id, value), mode: 'set', label: labelOf(id) };
}

function labelOf(id: AdjustmentId): string {
  return CONTROLS.find((c) => c.id === id)?.label ?? String(id);
}

// ── Axes the engine can actually move ─────────────────────────────────────────

/**
 * One axis a request can push or pull, with the travel a full request asks
 * for. Phrase rules and the general wording fallback both go through these, so
 * "less contrast" and "reduce the contrast" cannot quietly disagree about how
 * much they mean.
 *
 * `signed` is negative when the request asks for less of the axis.
 */
type Concept = {
  readonly key: string;
  readonly more: string;
  readonly less: string;
  readonly axis: (signed: number) => readonly AdjustmentDelta[];
};

const CONCEPTS = {
  light: {
    key: 'light',
    more: 'Increase the brightness',
    less: 'Reduce the brightness',
    axis: (s) => [delta('exposure', s * 0.6), delta('brightness', s * 20)],
  },
  contrast: {
    key: 'contrast',
    more: 'Increase the contrast',
    less: 'Reduce the contrast',
    axis: (s) => [delta('contrast', s * 30)],
  },
  colour: {
    key: 'colour',
    more: 'Richer, more vivid colour',
    less: 'Quieter, more muted colour',
    axis: (s) => [delta('saturation', s * 35), delta('vibrance', s * 25)],
  },
  warm: {
    key: 'warm',
    more: 'Warm up the colour temperature',
    less: 'Cool down the colour temperature',
    axis: (s) => [delta('warmth', s * 40), delta('temperature', s * 20)],
  },
  fade: {
    key: 'fade',
    more: 'A faded, lifted-black print',
    less: 'Take the fade back out',
    // Fade only ever lifts, so less of it means parking the knob at zero.
    axis: (s) => (s < 0 ? [setTo('fade', 0)] : [delta('fade', s * 45), delta('blacks', s * 15)]),
  },
  vignette: {
    key: 'vignette',
    more: 'Darken the edges with a vignette',
    less: 'Take the vignette back off',
    axis: (s) => (s < 0 ? [setTo('vignette', 0)] : [delta('vignette', s * 50)]),
  },
  grain: {
    key: 'grain',
    more: 'Add film grain',
    less: 'Take the grain back out',
    axis: (s) => (s < 0 ? [setTo('grain', 0)] : [delta('grain', s * 50)]),
  },
  highlights: {
    key: 'highlights',
    more: 'Lift the highlights',
    less: 'Recover the highlights',
    axis: (s) => [delta('highlights', s * 40)],
  },
  shadows: {
    key: 'shadows',
    more: 'Open the shadows',
    less: 'Deepen the shadows',
    axis: (s) => [delta('shadows', s * 40)],
  },
  whites: {
    key: 'whites',
    more: 'Lift the whites',
    less: 'Pull the whites back',
    axis: (s) => [delta('whites', s * 30)],
  },
  blacks: {
    key: 'blacks',
    more: 'Lift the blacks',
    less: 'Deepen the blacks',
    axis: (s) => [delta('blacks', s * 30)],
  },
  tint: {
    key: 'tint',
    more: 'Shift the tint towards magenta',
    less: 'Shift the tint towards green',
    axis: (s) => [delta('tint', s * 30)],
  },
  toning: {
    key: 'toning',
    more: 'Add a warm split tone',
    less: 'Add a cool split tone',
    axis: (s) => [delta('toning', s * 40)],
  },
} satisfies Record<string, Concept>;

type ConceptKey = keyof typeof CONCEPTS;

// ── Wording ───────────────────────────────────────────────────────────────────

/**
 * Nouns that name an axis. Order matters: the zone nouns are listed before the
 * general ones so "brighten the shadows" is about the shadows, not exposure.
 */
const NOUN_PATTERNS: ReadonlyArray<readonly [ConceptKey, RegExp]> = [
  ['highlights', /\bhighlights?\b/],
  ['shadows', /\bshadows?\b/],
  ['whites', /\bwhites?\b/],
  ['blacks', /\bblacks?\b/],
  ['vignette', /\bvignett\w*\b/],
  ['grain', /\bgrain\w*\b/],
  ['fade', /\bfad\w*\b|\bmatte\b|\blifted.?black\w*\b/],
  ['toning', /\btoning\b|\bsplit.?ton\w*\b/],
  ['tint', /\btint\b|\bmagenta\b|\bgreenish\b/],
  ['contrast', /\bcontrast\w*\b/],
  ['colour', /\bsaturat\w*\b|\bvibranc\w*\b|\bcolou?rful\b|\bvivid\w*\b/],
  ['warm', /\bwarm\w*\b|\btemperature\b|\bheat\b/],
  ['light', /\bbright\w*\b|\blight(?:en|er)?\b|\bexpos\w*\b|\bluminos\w*\b|\bdark\w*\b|\bshadow\w*\b/],
];

/**
 * Bare object words ("the colours"). Used only when nothing more specific was
 * named, so "make the colours warmer" warms rather than saturates.
 */
const WEAK_NOUNS: ReadonlyArray<readonly [ConceptKey, RegExp]> = [
  ['colour', /\bcolou?rs?\b|\bcolors?\b/],
];

/**
 * Wording whose direction is baked into the phrase rather than carried by a
 * "more/less" word. "Flatter" wants less contrast and "deepen the shadows"
 * wants less shadow, which no general direction table would guess.
 */
const IDIOMS: ReadonlyArray<{
  readonly patterns: readonly RegExp[];
  readonly concept: ConceptKey;
  readonly sign: 1 | -1;
}> = [
  // A complaint about how the photo reads asks for the opposite of what it says,
  // so it must be settled before the plain "darker"/"brighter" readings below.
  { patterns: [/\b(?:too|very|so|a bit|a little)\s+(?:dark|dim|murky)\b/, /\bunder.?expos\w*\b/, /\btoo much shadow\b/], concept: 'light', sign: 1 },
  { patterns: [/\b(?:too|very|so)\s+(?:bright|light|blown)\b/, /\bover.?expos\w*\b/, /\bblown.?out\b/], concept: 'light', sign: -1 },
  { patterns: [/\b(?:too|a bit|a little)\s+flat\b/, /\blooks flat\b/, /\bis flat\b/], concept: 'contrast', sign: 1 },
  { patterns: [/\bdark\w*\b(?!.{0,12}(?:edges?|corners?|background|vignett\w*|shadows?|blacks?))/], concept: 'light', sign: -1 },
  {
    patterns: [/\bflat(?:ter|est)?\b/, /\bsofter\b/, /\bsoftest\b/, /\bgentle(?:r)?\b/, /\bless harsh\b/, /\bharsh.{0,8}contrast\b/],
    concept: 'contrast',
    sign: -1,
  },
  { patterns: [/\bpunch\w*\b/, /\bhit harder\b/, /\bmore impact\b/], concept: 'contrast', sign: 1 },
  {
    patterns: [/\bwash\w*\s?out\b/, /\bdrain\w*\b[^.]{0,10}colou?r/, /\bdesaturat\w*\b/, /\bmuted?\b/, /\bless colou?r\b/],
    concept: 'colour',
    sign: -1,
  },
  { patterns: [/\bmore colou?r\b/, /\bcolou?r.{0,8}richer\b/, /\bricher colou?r\b/], concept: 'colour', sign: 1 },
  {
    patterns: [/\b(?:deepen|crush|hold back|darken)\w*\b[^.]{0,14}\bshadows?\b/, /\bshadows?\s+(?:down|back)\b/],
    concept: 'shadows',
    sign: -1,
  },
  { patterns: [/\b(?:open|fill|lift|brighten|recover)\w*\b[^.]{0,14}\bshadows?\b/], concept: 'shadows', sign: 1 },
  {
    patterns: [/\b(?:recover|hold|protect|tone down|reduce|lower|calm)\w*\b[^.]{0,14}\bhighlights?\b/, /\bhighlights?\s+(?:down|back)\b/],
    concept: 'highlights',
    sign: -1,
  },
  { patterns: [/\b(?:burn|darken)\w*\b[^.]{0,12}\b(?:edges?|corners?)\b/], concept: 'vignette', sign: 1 },
  { patterns: [/\b(?:cooler?|cold|bluish|blue(?:r|y)?|teal)\b/], concept: 'warm', sign: -1 },
  { patterns: [/\b(?:warmer|warm\w*|temperature|heat|golden)\b/], concept: 'warm', sign: 1 },
];

/** Ask for less of the named axis. Any of these words settles the direction. */
const LESS_WORDS =
  /\b(?:less|reduc\w*|lower\w*|decreas\w*|drop\w*|remov\w*|delete\w*|cut|crush|tone.?down|dial.?down|pull.?back|take.?away|without|no|not|too (?:much|high|strong|intense|vivid|punchy|steep)|over.?the.?top|suppress|dim|soften|kill)\b/;

/** A request aimed at one area of the frame, which the engine cannot honour. */
const LOCAL_SCOPE =
  /\b(?:background|foreground|sky|face|faces|skin|subject|person|people|hair|eyes?|building|trees?|water|clothes|outfit)\b/;

/* The honest answer, kept in one place with the research behind it: the app has
   no mask, and the models small enough to run in a tab are not the ones that
   would give it one. */
const CAVEAT_GLOBAL_ONLY = REGION_CAVEAT;

// ── Compound looks ────────────────────────────────────────────────────────────

/** Style words that ask for several knobs at once. Not strength-scaled. */
const STYLE_RULES: ReadonlyArray<{
  readonly patterns: readonly RegExp[];
  readonly build: () => readonly AdjustmentDelta[];
  readonly summary: string;
}> = [
  {
    patterns: [/\bmoody\b/, /\bmoodi.{0,4}er\b/, /\batmospheric\b/, /\bbrooding\b/],
    build: () => [delta('contrast', 25), delta('shadows', -20), delta('vignette', 35), delta('saturation', -10)],
    summary: 'Moodier — deeper shadows, more contrast, a slight vignette',
  },
  {
    patterns: [/\bbright.{0,6}airy\b/, /\bairy\b/, /\blight.and.airy\b/],
    build: () => [delta('exposure', 0.3), delta('brightness', 15), delta('contrast', -10), delta('saturation', 5)],
    summary: 'Bright and airy — lifted exposure, softened contrast',
  },
  {
    patterns: [/\bwarm.{0,6}golden\b/, /\bgolden.{0,6}hour\b/, /\bsunset.{0,6}look\b/, /\bgolden\b/],
    build: () => [delta('warmth', 35), delta('temperature', 15), delta('saturation', 10), delta('highlights', -10)],
    summary: 'Warm golden tones — warmer temperature, lifted colour',
  },
  {
    patterns: [/\bblack.{0,6}white\b/, /\bmonochrome\b/, /\bb&w\b/, /\bdesaturate.{0,6}all\b/],
    // Tonings land after saturation in the pipeline, so a coloured cast would
    // survive a pure "no colour" instruction unless it is switched off too.
    build: () => [setTo('saturation', -100), setTo('toning', 0)],
    summary: 'Convert to black and white — colour and colour cast removed',
  },
  {
    patterns: [/\bfilm.{0,6}appear\w*/, /\bfaded.{0,6}film\b/, /\banalogue.{0,6}look\b/, /\bfilmic\b/, /\bfilm\w*\b[^.]{0,12}\blook\b/, /\blook\b[^.]{0,12}\bfilm\w*\b/],
    build: () => [delta('fade', 40), delta('contrast', -10), delta('grain', 30), delta('saturation', -15)],
    summary: 'Faded film appearance — lifted blacks, grain, quieter colour',
  },
  {
    patterns: [/\bstreet.{0,6}photo\w*/, /\bgritty\b/],
    build: () => [delta('contrast', 30), delta('saturation', -20), delta('shadows', -15), delta('grain', 20)],
    summary: 'Street look — high contrast, drained colour, gritty grain',
  },
];

/** Requests for a look that belongs to the preset library rather than to knobs. */
const PRESET_RULES: ReadonlyArray<{
  readonly patterns: readonly RegExp[];
  readonly family: 'natural' | 'cinematic' | 'creative';
  readonly summary: string;
}> = [
  {
    patterns: [/\bcinematic\b/, /\bfilm.{0,6}grade\b/, /\bmovie.{0,6}look\b/, /\bdramatic.{0,6}look\b/],
    family: 'cinematic',
    summary: 'Apply a cinematic look',
  },
  {
    patterns: [/\bnatural\b/, /\bclean\b/, /\bhonest\b/, /\brealistic\b/, /\bbalanced\b/],
    family: 'natural',
    summary: 'Apply a natural, balanced look',
  },
  {
    patterns: [/\bcreative\b/, /\bvintage\b/, /\bretro\b/, /\bdreamy\b/, /\banalogue\b/],
    family: 'creative',
    summary: 'Apply a creative or vintage look',
  },
  {
    patterns: [/\bportrait\b/],
    family: 'natural',
    summary: 'Apply a natural portrait treatment',
  },
];

// ── Requests this engine cannot perform ───────────────────────────────────────

/** Checked before anything else, so these never silently fall through. */
const UNSUPPORTED_RULES: ReadonlyArray<{
  readonly patterns: readonly RegExp[];
  readonly requested: string;
  readonly suggestion: string;
}> = [
  {
    patterns: [/\bremov\w*.{0,14}\b(?:background|object|person|tourist|car)\b/, /\b(?:cut|paint)\s?out\b/, /\beras\w*\b/],
    requested: 'Object or background removal',
    suggestion:
      'This editor adjusts tone and colour — it cannot paint something out. Try the Moody look to push a background back, or a retouching tool for removal.',
  },
  {
    patterns: [/\b(?:ai|super).?upscale\b/, /\bupscal\w*\b/, /\benlarg\w*\b/, /\bhigher resolution\b/, /\bresiz\w*\b/],
    requested: 'Upscaling or resizing',
    suggestion:
      'This engine works at the photograph’s own size. Export from the Export panel for the full resolution you have, and use a dedicated tool to enlarge it further.',
  },
  {
    patterns: [
      /\bskin\b[^.]{0,14}(?:smooth|soft|retouch|blemish|pore|clear|clean)/,
      /\b(?:smooth|soft|retouch|clear|even)\w*\b[^.]{0,14}\bskin\b/,
      /\b(?:smooth|soft)\w*\b[^.]{0,14}\bface\b/,
      /\bface\b[^.]{0,14}(?:smooth|soft|retouch)/,
      /\bskin retouch\w*\b/,
      /\bblemish\w*\b/, /\brick.?remov\w*\b/, /\brinkl\w*\b/, /\bpimple\w*\b/, /\bpore\w*\b/, /\bb.?lemish\b/,
    ],
    requested: 'Skin retouching or blemish removal',
    suggestion: SKIN_REGION_NOTE,
  },
  {
    patterns: [/\b(?:chang|swapp|replac|substitut)\w*.{0,14}\b(?:sky|background|wall|clothes|outfit|colour of)\b/, /\bsky.?replac\w*\b/],
    requested: 'Replacing part of the photograph',
    suggestion:
      'Substitution is outside this engine. A warm or cinematic grade recolours the whole frame, which is the nearest thing available.',
  },
  {
    patterns: [/\bsharp\w*\b/, /\bblur\w*\b/, /\bfocus\w*\b/, /\bbokeh\b/, /\bclarity\b/, /\bhdr\b/],
    requested: 'Sharpening, blurring or clarity',
    suggestion:
      'There is no detail or blur stage here. Contrast and the Film grain knob change how much texture reads, which is the closest effect.',
  },
  {
    patterns: [/\bcrop\w*\b/, /\baspect.?ratio\b/],
    requested: 'Cropping or an aspect ratio',
    suggestion:
      'A crop is a control on the stage, not something this engine can apply for you. Framing, under the picture, offers 1:1, 4:5, 3:2, 16:9, 2:3 and 9:16 — each measured against this file — with sliders for the size and the position of the frame.',
  },
  {
    patterns: [/\brotat\w*\b/, /\bstraighten\w*\b/, /\bperspectiv\w*\b/, /\blens.?correct\w*\b/, /\bwatermark\w*\b/, /\badd\b[^.]{0,10}\btext\b/, /\bborder\b/, /\bflip\b/],
    requested: 'Rotation, perspective or overlays',
    suggestion: 'Rotation, perspective correction, borders and text are not part of this editor. It changes tone and colour, and frames the picture with the Framing control.',
  },
  {
    patterns: [/\bdenoise\b/, /\bnoise.?reduc\w*\b/, /\breduc\w*.{0,12}\bnoise\b/, /\bgrainy\b.{0,12}(less|remove)/],
    requested: 'Noise reduction',
    suggestion:
      'Removing noise that is already in the photograph is not available. If an edit added grain, the Film grain knob can take it back to zero.',
  },
];

// ── Requests that mean more than one thing ────────────────────────────────────

const AMBIGUOUS_RULES: ReadonlyArray<{
  readonly patterns: readonly RegExp[];
  readonly summary: string;
  readonly options: readonly AmbiguityOption[];
}> = [
  {
    patterns: [/\bbetter\b/, /\bimprov\w*\b/, /\bfix\w*\b/, /\benhanc\w*\b/, /\boptimi[sz]\w*\b/, /\bmake it (?:nice|good|great)\b/],
    summary: '“Better” means different things — which direction suits this photograph?',
    options: [
      {
        id: 'natural',
        label: 'Natural',
        description: 'A balanced preset — gentle correction, honest colour',
        deltas: [],
        presetFamily: 'natural',
      },
      {
        id: 'cinematic',
        label: 'Cinematic',
        description: 'Contrast-led, filmic depth, a dramatic grade',
        deltas: [],
        presetFamily: 'cinematic',
      },
      {
        id: 'bright',
        label: 'Bright & airy',
        description: 'Lifted exposure, open shadows, a clean look',
        deltas: [...CONCEPTS.light.axis(0.45), ...CONCEPTS.contrast.axis(-0.3)],
      },
    ],
  },
  {
    patterns: [/\bpopp?\b/, /\bpoppy\b/],
    summary: '“Pop” can mean more contrast, more colour, or both — which did you have in mind?',
    options: [
      {
        id: 'contrast',
        label: 'More contrast',
        description: 'Deeper darks, brighter brights',
        deltas: [...CONCEPTS.contrast.axis(0.8), ...CONCEPTS.shadows.axis(-0.25)],
      },
      { id: 'colour', label: 'More colour', description: 'Richer, more vivid colour', deltas: CONCEPTS.colour.axis(0.7) },
      {
        id: 'both',
        label: 'Both',
        description: 'Contrast and colour together, each held back a little',
        deltas: [...CONCEPTS.contrast.axis(0.5), ...CONCEPTS.colour.axis(0.5)],
      },
    ],
  },
  {
    patterns: [/\bdramatic\b/],
    summary: '“Dramatic” can mean dark and moody, or a filmic grade — which?',
    options: [
      {
        id: 'moody',
        label: 'Dark and moody',
        description: 'Deeper shadows, more contrast, a vignette',
        deltas: [delta('contrast', 25), delta('shadows', -20), delta('vignette', 35), delta('saturation', -10)],
      },
      {
        id: 'cinematic',
        label: 'Cinematic',
        description: 'A filmic, contrast-led preset from the library',
        deltas: [],
        presetFamily: 'cinematic',
      },
    ],
  },
  {
    patterns: [/\bnice\b/, /\bpretty\b/, /\bstriking\b/, /\bspecial\b/],
    summary: '“Nice” could go a few ways — pick the feeling you want.',
    options: [
      {
        id: 'warm',
        label: 'Warm and golden',
        description: 'Warmer temperature, a little more colour',
        deltas: [...CONCEPTS.warm.axis(0.6), ...CONCEPTS.colour.axis(0.3)],
      },
      {
        id: 'cool',
        label: 'Cool and clean',
        description: 'Cooler temperature, contrast held up',
        deltas: [...CONCEPTS.warm.axis(-0.5), ...CONCEPTS.contrast.axis(0.3)],
      },
      {
        id: 'natural',
        label: 'Natural',
        description: 'A balanced preset, no strong colour statement',
        deltas: [],
        presetFamily: 'natural',
      },
    ],
  },
];

// ── Strength ──────────────────────────────────────────────────────────────────

/** How hard to push an axis: 0.4 is a nudge, 1 is a statement. */
function parseStrength(text: string): number {
  if (/\b(?:a lot|lots|loads|much more|noticeabl\w*|significant\w*|heavi\w*|strong(?:ly)?|maximum|really|maximum)\b/.test(text)) return 1;
  if (/\b(?:slight\w*|a (?:little|bit|touch)|just a|subtle|barely|small|mild|faint|little bit)\b/.test(text)) return 0.4;
  if (/\b(?:very|extremely|quite|super|incredibl\w*|huge)\b/.test(text)) return 1;
  return 0.7;
}

// ── Matching ──────────────────────────────────────────────────────────────────

/**
 * Which axes the sentence names and which way each is wanted. Idioms are read
 * first because their direction is carried by the phrase, not by a "more/less"
 * word; whatever they do not cover falls to noun + direction.
 */
function findConcepts(text: string): Array<{ readonly concept: Concept; readonly sign: 1 | -1 }> {
  const found: Array<{ concept: Concept; sign: 1 | -1 }> = [];
  const seen = new Set<ConceptKey>();
  const add = (key: ConceptKey, sign: 1 | -1) => {
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ concept: CONCEPTS[key], sign });
  };

  for (const idiom of IDIOMS) {
    if (idiom.patterns.some((p) => p.test(text))) add(idiom.concept, idiom.sign);
  }

  for (const [key, pattern] of NOUN_PATTERNS) {
    if (!pattern.test(text)) continue;
    // A zone noun outranks the general light axis: "brighten the shadows".
    if (key === 'light' && seen.size > 0) continue;
    if (seen.has(key)) continue;
    add(key, LESS_WORDS.test(text) ? -1 : 1);
  }

  // A zone noun in the sentence makes the general light reading redundant.
  if (found.length > 1 && found.some((f) => f.concept === CONCEPTS.light)) {
    if (/\b(?:highlights?|shadows?|whites?|blacks?)\b/.test(text)) {
      const withoutLight = found.filter((f) => f.concept !== CONCEPTS.light);
      if (withoutLight.length > 0) return withoutLight.slice(0, 4);
    }
  }

  if (found.length === 0) {
    for (const [key, pattern] of WEAK_NOUNS) {
      if (pattern.test(text)) add(key, LESS_WORDS.test(text) ? -1 : 1);
    }
  }

  return found.slice(0, 4);
}

/** The travel requested on every axis the sentence names. */
function buildFromWording(text: string): { readonly deltas: readonly AdjustmentDelta[]; readonly summary: string } | null {
  const hits = findConcepts(text);
  if (hits.length === 0) return null;
  const strength = parseStrength(text);
  const deltas: AdjustmentDelta[] = [];
  const parts: string[] = [];
  for (const hit of hits) {
    for (const d of hit.concept.axis(hit.sign * strength)) {
      if (deltas.some((existing) => existing.id === d.id)) continue;
      deltas.push(d);
    }
    parts.push(hit.sign > 0 ? hit.concept.more : hit.concept.less);
  }
  if (deltas.length === 0) return null;
  return { deltas, summary: parts.join(' · ') };
}

function localScopeCaveat(text: string): string | undefined {
  if (!LOCAL_SCOPE.test(text)) return undefined;
  return /\bskin\b|\bfaces?\b/.test(text) ? SKIN_REGION_CAVEAT : CAVEAT_GLOBAL_ONLY;
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseNlRequest(text: string): ParsedInstruction {
  const lower = text.toLowerCase().trim();
  if (!lower) {
    return {
      kind: 'unsupported',
      summary: 'Nothing was typed yet.',
      requested: '',
      suggestion:
        'Describe what to change and which way: “make it brighter”, “reduce the contrast slightly”, “warmer colours”, “lift the shadows”, or “cinematic look”.',
    };
  }

  // 1. Things the engine cannot do, whichever words the user chose.
  for (const rule of UNSUPPORTED_RULES) {
    if (rule.patterns.some((p) => p.test(lower))) {
      return {
        kind: 'unsupported',
        summary: `“${rule.requested}” is not available in this editor.`,
        requested: rule.requested,
        suggestion: rule.suggestion,
      };
    }
  }

  // 2. Requests with more than one honest reading.
  for (const rule of AMBIGUOUS_RULES) {
    if (rule.patterns.some((p) => p.test(lower))) {
      return { kind: 'ambiguous', summary: rule.summary, options: rule.options };
    }
  }

  // 3. Compound looks, which are more specific than any single knob.
  for (const rule of STYLE_RULES) {
    if (rule.patterns.some((p) => p.test(lower))) {
      return { kind: 'adjustments', summary: rule.summary, deltas: rule.build(), caveat: localScopeCaveat(lower) };
    }
  }

  // 4. Requests for a look that belongs to the preset library.
  for (const rule of PRESET_RULES) {
    if (rule.patterns.some((p) => p.test(lower))) {
      return { kind: 'preset', summary: rule.summary, presetFamily: rule.family, caveat: localScopeCaveat(lower) };
    }
  }

  // 5. One or more axes named in the wording, read from direction + noun.
  const built = buildFromWording(lower);
  if (built) {
    return { kind: 'adjustments', summary: built.summary, deltas: built.deltas, caveat: localScopeCaveat(lower) };
  }

  // 6. Nothing recognised.
  return {
    kind: 'unsupported',
    summary: `“${text}” wasn’t recognised as an editing command.`,
    requested: text,
    suggestion:
      'Try naming what to change and which way: “make it brighter”, “reduce the contrast slightly”, “warmer colours”, “lift the shadows”, “add film grain”, or “cinematic look”.',
  };
}

// ── Applying an instruction to the current edit ───────────────────────────────

/** One knob, with where it stands now and where the instruction would put it. */
export type ResolvedKnob = {
  readonly id: AdjustmentId;
  readonly label: string;
  readonly before: number;
  readonly after: number;
  /** The control's own formatting, so numbers read as they do in Manual Edit. */
  readonly beforeText: string;
  readonly afterText: string;
};

function formatKnob(id: AdjustmentId, value: number): string {
  return CONTROLS.find((c) => c.id === id)?.format(value) ?? String(value);
}

/**
 * Fold a request's deltas into the values already on the knobs, so a command
 * adds to the photograph instead of replacing the look that is already there.
 * Every result is clamped back into the control's range.
 */
export function resolveDeltas(current: Adjustments, deltas: readonly AdjustmentDelta[]): ResolvedKnob[] {
  return deltas.map((d) => {
    const before = clampToControl(d.id, current[d.id] ?? IDENTITY[d.id]);
    const target = d.mode === 'set' ? d.value : before + (d.value - IDENTITY[d.id]);
    const after = clampToControl(d.id, target);
    return {
      id: d.id,
      label: d.label,
      before,
      after,
      beforeText: formatKnob(d.id, before),
      afterText: formatKnob(d.id, after),
    };
  });
}

/** The absolute values a proposal must carry for these deltas to land. */
export function resolvedToAdjustments(knobs: readonly ResolvedKnob[]): Partial<Adjustments> {
  const out: Record<string, number> = {};
  for (const knob of knobs) out[knob.id] = knob.after;
  return out as Partial<Adjustments>;
}

/** The knobs that will visibly move — clamped requests can be no-ops. */
export function movingKnobs(knobs: readonly ResolvedKnob[]): ResolvedKnob[] {
  return knobs.filter((k) => k.after !== k.before);
}

/** Every knob id this parser is allowed to name, for tests and callers. */
export const SUPPORTED_KNOBS: readonly AdjustmentId[] = CONTROLS.map((c) => c.id);

// ── What an accepted instruction becomes ──────────────────────────────────────

/**
 * The recipe a conversational instruction turns into once the user accepts it.
 *
 * The proposal system already works in presets, so an instruction is carried as
 * one: `adjust` holds the absolute values the knobs reach after the deltas are
 * folded in, which is what lets the change sit on top of the look already on
 * the photograph instead of replacing it. The paperwork says plainly that this
 * recipe came from the user's own words and not from the licensed library —
 * inventing a preset name, licence or source for it would be a lie.
 */
export function conversationalPreset(
  id: string,
  summary: string,
  adjustments: Partial<Adjustments>,
): Preset {
  return {
    id,
    name: summary,
    category: 'From your words',
    description: summary,
    adjust: clampAdjustments(adjustments),
    support: 'full',
    origin: 'generated',
    source: { sourceId: 'generated', licence: 'N/A', origin: 'Conversational edit' },
    mapped: [],
    dropped: [],
    tags: [],
  };
}
