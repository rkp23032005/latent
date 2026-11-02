/**
 * The editing state, held separately from the photograph.
 *
 * Values are stored in *slider units* — the same numbers the controls show —
 * and become optical multipliers only at render time. That keeps one set of
 * parameters meaningful to the preview renderer today and to the export
 * renderer later, and means the state can be printed, compared or reset
 * without touching a single pixel.
 */

export type AdjustmentId =
  | 'exposure'
  | 'brightness'
  | 'contrast'
  | 'warmth'
  | 'saturation'
  | 'fade'
  | 'toning'
  | 'vignette'
  /* Advanced Edit. The four zone knobs are gains confined to one end of the
     tone scale, which is what Camera Raw's masked ranges do. */
  | 'highlights'
  | 'shadows'
  | 'whites'
  | 'blacks'
  | 'vibrance'
  | 'temperature'
  | 'tint'
  | 'grain';

export type Adjustments = { readonly [K in AdjustmentId]: number };

/**
 * The numbers a renderer consumes. Identity is literal: gain 1, nothing added,
 * slope 1, no channel bias, full saturation, no print effects.
 */
export type PipelineParams = {
  readonly gain: number;
  readonly add: number;
  readonly slope: number;
  readonly warmR: number;
  readonly warmB: number;
  readonly saturation: number;
  readonly fadeFloor: number;
  readonly fadeSpan: number;
  readonly toning: number;
  readonly vignette: number;
  readonly highlights: number;
  readonly shadows: number;
  readonly whites: number;
  readonly blacks: number;
  readonly vibrance: number;
  readonly tempR: number;
  readonly tempG: number;
  readonly tempB: number;
  readonly grain: number;
};

export const IDENTITY: Adjustments = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  warmth: 0,
  saturation: 0,
  fade: 0,
  toning: 0,
  vignette: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  grain: 0,
};

export type Control = {
  id: AdjustmentId;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  /** Which panel the knob belongs to, and in what order it arrives there. */
  group: 'light' | 'print' | 'zone' | 'colour' | 'effect';
  format: (value: number) => string;
};

/* The full-travel effect of each knob. A slider at its end should be a clear
   statement rather than a broken image, so the spans are conservative. */
const BRIGHTNESS_SPAN = 0.4;
const CONTRAST_SPAN = 0.5;
const WARMTH_SPAN = 0.16;
/* A faded print lifts the blacks and pulls the whites: the two ends of the
   tone scale move towards each other, so the span shrinks by both amounts. */
const FADE_FLOOR = 0.17;
const FADE_TOP = 0.1;
/* Vignetting is stated as the darkest corner, so one full step leaves 38% of
   the corner exposure. Negative values brighten the corners instead. */
const VIGNETTE_FULL = 0.62;
/* The zone knobs are exposure-like gains, so their travel is counted in stops —
   and only ever at the centre of the zone they are weighted towards. */
const HIGHLIGHTS_STOPS = 1;
const SHADOWS_STOPS = 1;
const WHITES_STOPS = 0.75;
const BLACKS_STOPS = 0.75;
/* Vibrance pushes the *muted* pixels hardest, so this is the extra saturation
   multiplier a nearly-grey pixel gets at a full setting. */
const VIBRANCE_FULL = 1;
/* A raw-style white balance has more travel than the Quick Edit bias, and the
   two axes are deliberately asymmetric: real lamps are not symmetric in blue. */
const TEMPERATURE_R = 0.2;
const TEMPERATURE_B = 0.18;
const TINT_GREEN = 0.14;
const TINT_SIDE = 0.07;
/* Grain is stated as the peak swing around the tone it lands on, so a full
   setting moves a mid-tone by roughly ±8% of the print's range. */
const GRAIN_FULL = 0.16;

function signed(value: number, digits: number): string {
  const abs = Math.abs(value).toFixed(digits);
  if (value > 0) return `+${abs}`;
  if (value < 0) return `−${abs}`;
  return digits > 0 ? `±${abs}` : '0';
}

/** Unipolar knobs: a plain number, because there is no minus to show. */
function level(value: number): string {
  return value === 0 ? '0' : String(Math.round(value));
}

export const CONTROLS: readonly Control[] = [
  {
    id: 'exposure',
    label: 'Exposure',
    hint: 'Light gathered, in stops',
    min: -2,
    max: 2,
    step: 0.05,
    group: 'light',
    format: (v) => `${signed(v, 2)} EV`,
  },
  {
    id: 'brightness',
    label: 'Brightness',
    hint: 'Overall level of the print',
    min: -100,
    max: 100,
    step: 1,
    group: 'light',
    format: (v) => signed(v, 0),
  },
  {
    id: 'contrast',
    label: 'Contrast',
    hint: 'Distance between light and dark',
    min: -100,
    max: 100,
    step: 1,
    group: 'light',
    format: (v) => signed(v, 0),
  },
  {
    id: 'warmth',
    label: 'Warmth',
    hint: 'Cool to warm balance',
    min: -100,
    max: 100,
    step: 1,
    group: 'light',
    format: (v) => signed(v, 0),
  },
  {
    id: 'saturation',
    label: 'Saturation',
    hint: 'Colour intensity',
    min: -100,
    max: 100,
    step: 1,
    group: 'light',
    format: (v) => signed(v, 0),
  },
  {
    id: 'fade',
    label: 'Fade',
    hint: 'Air in the blacks, softened whites',
    min: 0,
    max: 100,
    step: 1,
    group: 'print',
    format: level,
  },
  {
    id: 'toning',
    label: 'Toning',
    hint: 'Split tone: shadows against highlights',
    min: -100,
    max: 100,
    step: 1,
    group: 'print',
    format: (v) => signed(v, 0),
  },
  {
    id: 'highlights',
    label: 'Highlights',
    hint: 'Recover or open the bright end',
    min: -100,
    max: 100,
    step: 1,
    group: 'zone',
    format: (v) => signed(v, 0),
  },
  {
    id: 'shadows',
    label: 'Shadows',
    hint: 'Recover or deepen the dark end',
    min: -100,
    max: 100,
    step: 1,
    group: 'zone',
    format: (v) => signed(v, 0),
  },
  {
    id: 'whites',
    label: 'Whites',
    hint: 'Where the print stops',
    min: -100,
    max: 100,
    step: 1,
    group: 'zone',
    format: (v) => signed(v, 0),
  },
  {
    id: 'blacks',
    label: 'Blacks',
    hint: 'Where the print starts',
    min: -100,
    max: 100,
    step: 1,
    group: 'zone',
    format: (v) => signed(v, 0),
  },
  {
    id: 'vibrance',
    label: 'Vibrance',
    hint: 'Colour for the flat parts, gently',
    min: -100,
    max: 100,
    step: 1,
    group: 'colour',
    format: (v) => signed(v, 0),
  },
  {
    id: 'temperature',
    label: 'Temperature',
    hint: 'Daylight to tungsten, on the raw axis',
    min: -100,
    max: 100,
    step: 1,
    group: 'colour',
    format: (v) => signed(v, 0),
  },
  {
    id: 'tint',
    label: 'Tint',
    hint: 'Green to magenta, the axis Warmth lacks',
    min: -100,
    max: 100,
    step: 1,
    group: 'colour',
    format: (v) => signed(v, 0),
  },
  {
    id: 'vignette',
    label: 'Vignette',
    hint: 'Light falling away at the edges',
    min: -100,
    max: 100,
    step: 1,
    group: 'effect',
    format: (v) => signed(v, 0),
  },
  {
    id: 'grain',
    label: 'Film grain',
    hint: 'Silver halide scatter, from the same grain map',
    min: 0,
    max: 100,
    step: 1,
    group: 'effect',
    format: level,
  },
];

const CONTROL_BY_ID = new Map(CONTROLS.map((control) => [control.id, control]));

function controlFor(id: AdjustmentId): Control {
  return CONTROL_BY_ID.get(id) ?? CONTROLS[0];
}

/** Slider values only ever come from a control, but clamp anyway. */
export function clampToControl(id: AdjustmentId, value: number): number {
  const control = controlFor(id);
  if (!Number.isFinite(value)) return IDENTITY[id];
  return Math.min(control.max, Math.max(control.min, value));
}

export function toPipelineParams(a: Adjustments): PipelineParams {
  const fade = a.fade / 100;
  const t = a.temperature / 100;
  const k = a.tint / 100;
  return {
    gain: Math.pow(2, a.exposure),
    add: (a.brightness / 100) * BRIGHTNESS_SPAN,
    slope: 1 + (a.contrast / 100) * CONTRAST_SPAN,
    warmR: 1 + (a.warmth / 100) * WARMTH_SPAN,
    warmB: 1 - (a.warmth / 100) * WARMTH_SPAN,
    saturation: 1 + a.saturation / 100,
    fadeFloor: fade * FADE_FLOOR,
    fadeSpan: 1 - fade * (FADE_FLOOR + FADE_TOP),
    toning: a.toning / 100,
    vignette: (a.vignette / 100) * VIGNETTE_FULL,
    /* Each zone is a gain counted in stops, applied only where its weight says
       to — the pipeline reads these as exponents, never as multipliers. */
    highlights: (a.highlights / 100) * HIGHLIGHTS_STOPS,
    shadows: (a.shadows / 100) * SHADOWS_STOPS,
    whites: (a.whites / 100) * WHITES_STOPS,
    blacks: (a.blacks / 100) * BLACKS_STOPS,
    vibrance: (a.vibrance / 100) * VIBRANCE_FULL,
    /* Positive temperature warms, positive tint magenta: both push the two
       channels that make those colours and hold the third back. */
    tempR: 1 + t * TEMPERATURE_R + k * TINT_SIDE,
    tempG: 1 - k * TINT_GREEN,
    tempB: 1 - t * TEMPERATURE_B + k * TINT_SIDE,
    grain: (a.grain / 100) * GRAIN_FULL,
  };
}

export function isIdentity(a: Adjustments): boolean {
  return CONTROLS.every((control) => a[control.id] === IDENTITY[control.id]);
}

/** Fill a partial recipe out to all sixteen knobs, each clamped into range. */
export function clampAdjustments(source: Partial<Adjustments>): Adjustments {
  const out: Record<AdjustmentId, number> = { ...IDENTITY };
  for (const control of CONTROLS) {
    out[control.id] = clampToControl(control.id, source[control.id] ?? IDENTITY[control.id]);
  }
  return out;
}

export function sameAdjustments(a: Adjustments, b: Adjustments): boolean {
  return CONTROLS.every((control) => a[control.id] === b[control.id]);
}

/** Screen-reader text for the preview: what is currently being done to it. */
export function describeAdjustments(a: Adjustments): string {
  const active = CONTROLS.filter((control) => a[control.id] !== IDENTITY[control.id]);
  if (active.length === 0) return 'unmodified';
  return active.map((control) => `${control.label} ${control.format(a[control.id])}`).join(', ');
}

/**
 * The blend used everywhere a preset is dialled back: linear, in slider units,
 * from the untouched photograph to the recipe exactly as the preset states it.
 * So 0 is identity, 100 is the preset, and every step between is the same
 * fraction of the same distance — which is what a slider promises.
 */
export function scaleRecipe(recipe: Partial<Adjustments>, intensity: number): Adjustments {
  const t = Math.min(100, Math.max(0, intensity)) / 100;
  const out: Record<AdjustmentId, number> = { ...IDENTITY };
  for (const control of CONTROLS) {
    const target = recipe[control.id] ?? IDENTITY[control.id];
    out[control.id] = clampToControl(
      control.id,
      IDENTITY[control.id] + (target - IDENTITY[control.id]) * t,
    );
  }
  return out;
}

/**
 * Preset plus hand-turning. The two layers stay separable so a slider can be
 * moved back to the look's own value, and so intensity can change without the
 * user's edits being silently re-based.
 */
export function combineLayers(blended: Adjustments, manual: Adjustments): Adjustments {
  const out: Record<AdjustmentId, number> = { ...IDENTITY };
  for (const control of CONTROLS) {
    out[control.id] = clampToControl(control.id, blended[control.id] + manual[control.id]);
  }
  return out;
}

export const NO_OFFSETS: Adjustments = { ...IDENTITY };

export type AdjustmentsState = {
  values: Adjustments;
  dirty: boolean;
  /** The look pressed onto the photograph, if one is chosen. */
  activePreset: string | null;
  /** A preset is chosen and a knob has since been moved away from it. */
  modified: boolean;
  /** How much of the chosen look is on the photograph, 0–100. */
  intensity: number;
  /** The recipe alone, without the photograph it belongs to. */
  snapshot: {
    chosen: { recipe: Adjustments; presetId: string } | null;
    intensity: number;
    offsets: Adjustments;
  };
  canUndo: boolean;
  canRedo: boolean;
  /** How many edits can be undone, not counting the current state. */
  steps: number;
  set: (id: AdjustmentId, value: number) => void;
  setIntensity: (value: number) => void;
  /** Drop the hand turn on one knob, back to whatever the look asks for. */
  resetKnob: (id: AdjustmentId) => void;
  applyPreset: (values: Adjustments, presetId: string) => void;
  /** Put a saved recipe on the stage as one undoable step. */
  applyState: (snapshot: AdjustmentsState['snapshot']) => void;
  reset: () => void;
  undo: () => void;
  redo: () => void;
};
