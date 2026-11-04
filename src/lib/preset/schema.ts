/**
 * What a preset is, and how honestly we describe what survives the import.
 *
 * A preset is a recipe for the sixteen knobs of the editing engine, plus the
 * paperwork that came with it: where it was found, what it may be used for, and
 * which of the original settings this engine cannot actually perform. The
 * paperwork is not decoration. A Lightroom preset that leans on a camera
 * profile, per-hue HSL sliders and a tone curve is *not* the same picture once
 * those are gone, so the card says which parts arrived.
 */

import type { Adjustments } from '../image/adjustments';

/** Whether this engine can do what the source asked for. */
export type SupportLevel =
  /** Every setting in the source is representable here. */
  | 'full'
  /** The recipe runs, but some settings had no engine equivalent. */
  | 'partial'
  /** Read and understood, and deliberately not offered: nothing usable inside. */
  | 'unsupported'
  /** Rejected before it became a preset. */
  | 'invalid';

export type PresetOrigin = 'imported' | 'generated';

export type PresetSource = {
  /** Registry id of the source this preset came from, or 'generated'. */
  readonly sourceId: string;
  /** SPDX id, as verified when the source was accepted. */
  readonly licence: string;
  /** Where the file came from, in words the user can act on. */
  readonly origin: string;
  /** Path inside the upstream repository. */
  readonly file?: string;
  /** Notice the licence requires us to show. */
  readonly attribution?: string;
};

export type Preset = {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  /** Slider units. Absent means identity, so a preset never stores zeroes. */
  readonly adjust: Partial<Adjustments>;
  readonly support: SupportLevel;
  readonly origin: PresetOrigin;
  readonly source: PresetSource;
  /** Settings that became knob values, in the words the source used. */
  readonly mapped: readonly string[];
  /** Settings this engine cannot perform, with the reason. */
  readonly dropped: readonly string[];
  /** One line the user reads to know what they are not getting. */
  readonly limitation?: string;
  readonly tags: readonly string[];
  /** Mean absolute change, 0–255, measured by the engine on the sample chart. */
  readonly effect?: number;
};

export type SourceRecord = {
  readonly sourceId: string;
  readonly repository: string;
  readonly licence: string;
  readonly licenceFile: string;
  readonly attribution: string;
  readonly verdict: 'imported' | 'rejected';
  readonly reason: string;
  readonly formats: readonly string[];
  readonly filesFound: number;
  readonly presetsKept: number;
  readonly presetsDropped: number;
};

export type PresetLibrary = {
  readonly version: number;
  readonly builtAt: string;
  /** Photograph the catalogue thumbnails are rendered from. */
  readonly sample: string;
  readonly presets: readonly Preset[];
  readonly sources: readonly SourceRecord[];
  readonly counts: Readonly<Record<SupportLevel, number>>;
};

/** A preset's knobs, filled out to a whole editing state. */
export function presetAdjustments(preset: Preset, identity: Adjustments): Adjustments {
  return { ...identity, ...preset.adjust };
}

/** Cards are sorted and filtered by this, so it lives next to the type. */
export const SUPPORT_LABEL: Record<SupportLevel, string> = {
  full: 'Fully supported',
  partial: 'Partially supported',
  unsupported: 'Not supported here',
  invalid: 'Rejected',
};
