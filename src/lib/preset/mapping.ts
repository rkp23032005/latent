/**
 * Reading a Lightroom / Camera Raw XMP preset and saying, without flattery,
 * which parts of it this engine can actually do.
 *
 * The shape of these files is stable: one `<rdf:Description>` carrying every
 * setting as a `crs:` attribute, then a `crs:Look` block naming a camera profile
 * and a few `crs:ToneCurve*` sequences. That is a small, well-behaved dialect, so
 * the reader walks the document with patterns rather than pulling in an XML
 * library the editor does not otherwise need.
 *
 * A setting counts as lost only when its value is not neutral — `Clarity2012="0"`
 * asks for nothing, so dropping it costs nothing and is not reported.
 */

import { clampToControl, type AdjustmentId, type Adjustments } from '../image/adjustments.ts';

export type XmpAttributes = Record<string, string>;

export type XmpReading = {
  readonly attributes: XmpAttributes;
  readonly name: string;
  readonly group: string;
  /** The Adobe profile the preset is built against, if it names one. */
  readonly profile: string | null;
  /** True when a tone curve actually bends something. */
  readonly curved: boolean;
  readonly grayscale: boolean;
  readonly monochrome: boolean;
};

export type MappedSetting = {
  readonly knob: AdjustmentId;
  readonly from: string;
  readonly note: string;
};

export type XmpMap = {
  readonly adjust: Partial<Adjustments>;
  readonly mapped: readonly MappedSetting[];
  readonly dropped: readonly string[];
  readonly limitations: readonly string[];
};

/* Metadata and capability flags describe the file, not the picture. */
const NOT_A_SETTING = new Set([
  'PresetType',
  'Cluster',
  'UUID',
  'Name',
  'Group',
  'SupportsAmount',
  'SupportsColor',
  'SupportsMonochrome',
  'SupportsHighDynamicRange',
  'SupportsNormalDynamicRange',
  'SupportsSceneReferred',
  'SupportsOutputReferred',
  'RequiresRenditionBehavior',
  'HasSettings',
  'ProcessVersion',
  'Version',
  'Amount',
  'Treatment',
  'WhiteBalance',
  'ConvertToGrayscale',
  'Look',
]);

/** What it means when a setting from this family cannot be kept. */
const FAMILY: ReadonlyArray<{ readonly test: RegExp; readonly reason: string }> = [
  { test: /^Grain(?!Amount)/, reason: 'grain size, roughness and colouring (this engine has one amount)' },
  { test: /^(Texture|Clarity2012|Dehaze)$/, reason: 'local contrast and haze removal' },
  {
    test: /^(Sharpness|Sharpen|LuminanceSmoothing|LuminanceNoiseReduction|ColorNoiseReduction|AutoLateralCA|Defringe)/,
    reason: 'capture sharpening and noise reduction',
  },
  {
    test: /^(Hue|Saturation|Luminance)Adjustment|^GrayMixer|^(Red|Orange|Yellow|Green|Aqua|Blue|Purple|Magenta)(Hue|Saturation|Luminance)$/,
    reason: 'per-hue colour edits and channel mixers',
  },
  { test: /^ColorGrade/, reason: 'colour grading beyond one warm/cool split-tone axis' },
  {
    test: /^PostCropVignette(Midpoint|Feather|Roundness|Style|HighlightContrast)$|^Vignette(Midpoint|Feather|Roundness|Style)$/,
    reason: 'vignette shape controls (this engine has one amount)',
  },
  {
    test: /^(Parametric|Perspective|Upright|LensProfile|LensManualDistortion)/,
    reason: 'parametric curves, lens and geometry correction',
  },
  { test: /^ShadowTint$/, reason: 'a colour balance control with no equivalent here' },
];

/** Neutral is the value that asks for nothing. */
function isNeutral(name: string, value: number): boolean {
  if (name === 'Exposure2012') return Math.abs(value) < 0.01;
  return value === 0;
}

function num(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The red–blue component of a colour-grading hue: negative is cool, +1 warm. */
function warmOf(hueDeg: number, sat: number): number {
  if (sat === 0) return 0;
  const h = ((hueDeg % 360) + 360) % 360;
  const c = sat / 100;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const sector = Math.min(5, Math.floor(h / 60));
  const rgb: readonly [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, , b] = rgb[sector];
  return r - b;
}

export function readXmp(text: string): XmpReading | null {
  const open = text.indexOf('<rdf:Description');
  if (open < 0) return null;
  const end = text.indexOf('>', open);
  if (end < 0) return null;

  const attributes: XmpAttributes = {};
  for (const match of text.slice(open, end).matchAll(/\bcrs:(\w+)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  if (Object.keys(attributes).length === 0) return null;

  const look = /<crs:Look>[\s\S]*?\bcrs:Name="([^"]*)"/.exec(text);
  const profile = look ? look[1].trim() : null;

  let curved = false;
  for (const match of text.matchAll(/<crs:(ToneCurvePV2012\w*)>([\s\S]*?)<\/crs:\1>/g)) {
    for (const point of match[2].matchAll(/<rdf:li>([^<]*)<\/rdf:li>/g)) {
      const parts = point[1].split(',').map((bit) => Number.parseFloat(bit));
      if (parts.some((n) => !Number.isFinite(n))) continue;
      if (Math.abs(parts[0] - parts[1]) > 0.5) curved = true;
    }
  }

  return {
    attributes,
    name: attributes.Name ?? '',
    group: attributes.Group ?? '',
    profile,
    curved,
    grayscale: /^(?:true|1)$/i.test(attributes.ConvertToGrayscale ?? ''),
    monochrome: /^monochrome$/i.test(attributes.Treatment ?? ''),
  };
}

/**
 * The mapping itself. Two rules keep it honest: a knob is only written when the
 * file really asked for it, and everything the file asked for that cannot be
 * kept is written down rather than quietly dropped.
 */
export function mapXmp(reading: XmpReading): XmpMap {
  const a = reading.attributes;
  const adjust: { [K in AdjustmentId]?: number } = {};
  const mapped: MappedSetting[] = [];
  const consumed = new Set<string>();
  const lost = new Set<string>();
  const limitations: string[] = [];

  const put = (
    knob: AdjustmentId,
    value: number,
    from: string,
    note: string,
    sources: readonly string[],
  ) => {
    sources.forEach((name) => consumed.add(name));
    const clamped = clampToControl(knob, Math.round(value));
    if (clamped === 0) return;
    adjust[knob] = clamped;
    mapped.push({ knob, from, note });
  };

  if (a.Exposure2012 !== undefined && !isNeutral('Exposure2012', num(a.Exposure2012))) {
    put(
      'exposure',
      num(a.Exposure2012),
      'Exposure2012',
      `${num(a.Exposure2012).toFixed(2)} EV, applied on scene-linear light`,
      ['Exposure2012'],
    );
  }

  if (a.Contrast2012 !== undefined && !isNeutral('Contrast2012', num(a.Contrast2012))) {
    put(
      'contrast',
      num(a.Contrast2012),
      'Contrast2012',
      'a curve in Camera Raw, one slope about mid grey here',
      ['Contrast2012'],
    );
  }

  if (a.Saturation !== undefined && num(a.Saturation) !== 0) {
    put('saturation', num(a.Saturation), 'Saturation', 'every pixel by the same amount', ['Saturation']);
  } else {
    consumed.add('Saturation');
  }

  /* Its own knob now, so the protection it asks for — the flat parts of the
     picture get the push, the already-strong ones do not — is really there. */
  if (a.Vibrance !== undefined && num(a.Vibrance) !== 0) {
    put('vibrance', num(a.Vibrance), 'Vibrance', 'muted colours pushed hardest, bright ones left alone', [
      'Vibrance',
    ]);
  } else {
    consumed.add('Vibrance');
  }

  if (a.Tint !== undefined && num(a.Tint) !== 0) {
    put('tint', num(a.Tint), 'Tint', 'the green–magenta axis, on the same white balance stage', ['Tint']);
  } else {
    consumed.add('Tint');
  }

  if ((a.WhiteBalance ?? '') === 'Custom' && a.Temperature !== undefined) {
    const kelvin = num(a.Temperature);
    consumed.add('Temperature');
    if (kelvin > 0) {
      put(
        'temperature',
        (kelvin - 6500) / 30,
        'Temperature',
        'a red/blue bias on the white balance stage',
        ['Temperature'],
      );
      limitations.push(
        `Temperature ${kelvin.toFixed(0)} K is read against a 6500 K neutral, not against this file's own white balance.`,
      );
    }
  }

  /* The four masked ranges now have four knobs of their own, so a preset that
     lifts shadows and pulls highlights gets both, separately, instead of one
     compromise fade. */
  const ZONE_SETTINGS: ReadonlyArray<readonly [string, AdjustmentId, string]> = [
    ['Highlights2012', 'highlights', 'bright end of the tone scale only'],
    ['Shadows2012', 'shadows', 'dark end of the tone scale only'],
    ['Whites2012', 'whites', 'where the print stops'],
    ['Blacks2012', 'blacks', 'where the print starts'],
  ];
  for (const [name, knob, what] of ZONE_SETTINGS) {
    if (a[name] === undefined) continue;
    if (num(a[name]) === 0) {
      consumed.add(name);
      continue;
    }
    put(knob, num(a[name]), name, `a masked range, weighted to the ${what}`, [name]);
  }

  const hi = warmOf(num(a.ColorGradeHighlightHue), num(a.ColorGradeHighlightSat));
  const sh = warmOf(num(a.ColorGradeShadowHue), num(a.ColorGradeShadowSat));
  if (hi !== 0 || sh !== 0) {
    for (const name of ['ColorGradeHighlightHue', 'ColorGradeHighlightSat', 'ColorGradeShadowHue', 'ColorGradeShadowSat']) {
      consumed.add(name);
    }
    put(
      'toning',
      (hi - sh) * 160,
      'ColorGrade shadow/highlight tint',
      'four grading wheels reduced to one split-tone axis',
      [],
    );
    limitations.push('Colour grading keeps only the warm/cool difference between highlights and shadows.');
  }

  /* Both spellings of the amount, and either direction: in Camera Raw a
     negative value darkens the corners, which is the positive end of this
     knob. A positive one brightens them, which the old mapping threw away. */
  const vignetting = -(num(a.PostCropVignetteAmount) || num(a.VignetteAmount));
  consumed.add('PostCropVignetteAmount');
  consumed.add('VignetteAmount');
  if (vignetting !== 0) {
    put(
      'vignette',
      vignetting,
      'PostCropVignetteAmount',
      'one amount, in either direction, with no midpoint, feather or roundness',
      [],
    );
  }

  if (a.GrainAmount !== undefined && num(a.GrainAmount) !== 0) {
    put('grain', num(a.GrainAmount), 'GrainAmount', 'one amount, scattered over a fixed grain map', [
      'GrainAmount',
    ]);
    limitations.push('Grain keeps its amount only: size, roughness and colouring are fixed here.');
  }

  if (reading.grayscale || reading.monochrome) {
    adjust.saturation = -100;
    mapped.push({
      knob: 'saturation',
      from: reading.grayscale ? 'ConvertToGrayscale' : 'Treatment=Monochrome',
      note: 'drained to grey by the engine itself',
    });
    if (Object.keys(a).some((key) => /^GrayMixer/.test(key))) {
      limitations.push('Monochrome is a flat desaturation; the file’s channel mixer weights are not applied.');
    }
  }

  for (const [name, value] of Object.entries(a)) {
    if (NOT_A_SETTING.has(name) || consumed.has(name)) continue;
    if (isNeutral(name, num(value))) continue;
    const family = FAMILY.find((entry) => entry.test.test(name));
    lost.add(family ? `${name}: ${family.reason}` : `${name}: no equivalent in this engine`);
  }

  if (reading.curved) lost.add('ToneCurvePV2012: a tone curve with control points');
  if (reading.profile) {
    lost.add(`Look: the "${reading.profile}" camera profile this preset was graded against`);
    limitations.push(`Graded against the ${reading.profile} profile, which this engine does not have.`);
  }

  return { adjust, mapped, dropped: groupByReason(lost), limitations: [...new Set(limitations)] };
}

/**
 * Eight channel-mixer sliders are one thing the file asked for, not eight
 * sentences. Names stay listed — the count is the evidence — but a family that
 * failed for one reason is reported once.
 */
function groupByReason(lost: Set<string>): string[] {
  const groups = new Map<string, string[]>();
  for (const entry of lost) {
    const colon = entry.indexOf(':');
    const name = colon > 0 ? entry.slice(0, colon).trim() : entry;
    const reason = colon > 0 ? entry.slice(colon + 1).trim() : '';
    const list = groups.get(reason) ?? [];
    list.push(name);
    groups.set(reason, list);
  }
  return [...groups]
    .map(([reason, names]) => {
      const sorted = names.sort((x, y) => x.localeCompare(y));
      const who =
        sorted.length > 3
          ? `${sorted.slice(0, 3).join(', ')} +${sorted.length - 3} more`
          : sorted.join(', ');
      return `${who}: ${reason}`;
    })
    .sort((x, y) => x.localeCompare(y));
}

/** One sentence the user reads instead of a list of attribute names. */
export function summarizeDropped(dropped: readonly string[]): string {
  if (dropped.length === 0) return 'Nothing was left behind.';
  const families = new Set(
    dropped.map((entry) => {
      const colon = entry.indexOf(':');
      return colon > 0 ? entry.slice(colon + 1).trim() : entry;
    }),
  );
  const list = [...families];
  if (list.length === 1) return `Not carried over: ${list[0]}.`;
  return `Not carried over: ${list.slice(0, 3).join('; ')}${list.length > 3 ? '; and more' : ''}.`;
}
