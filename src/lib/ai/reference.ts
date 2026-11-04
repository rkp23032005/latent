/**
 * Matching a reference photograph to the looks this engine already has.
 *
 * Someone brings in a print they like and asks for that. The honest answer here
 * is a search, not a clone: measure the reference in the eleven quantities
 * `styleRead.ts` defines, run every real look in the catalogue over the
 * photograph being edited, read the result the same way, and rank the looks by
 * how far their result still sits from the reference.
 *
 * ## Why the ranking is a measurement and not a guess
 * The engine already renders pixels without a browser, and the photograph is
 * already reduced to a 64×64 sample for its measurements. So the answer to "what
 * would this look do to *my* file" is obtained by doing it, on that sample, and
 * reading the pixels back — the same pipeline the CPU fallback and the thumbnail
 * cards use, through `gradeSample`. Nothing is added, blended or extrapolated
 * between the two photographs; a distance here is between two renders of one
 * file and one measurement of another.
 *
 * ## The approximation, which is one thing and not several
 * A look is graded at 64×64 rather than at full resolution. The ends of the tone
 * scale are read from 64 bins. Both are sampling, not modelling: the same
 * rendering that scores the candidate also produces the photograph's own
 * baseline, so there is no extrapolation between the two files at all. The
 * drift that remains is measured — `reference.test.ts` reads one look off a
 * 64×64 sample and off the 256-edge frame it came from and finds 0.011 of a step
 * between them, against a unit of about 0.05, and holds the bound at 0.02. What
 * the method cannot know is anything the eleven quantities do not hold —
 * texture, subject, region boundaries — so it is a statement about tone and
 * colour, and the interface says so rather than promising the reference back.
 *
 * ## Evidence that the ranking points at the right thing
 * The test can know an answer here, because a reference photograph can be made
 * by putting a real preset on a real file and asking the matcher to find it back.
 * Eight looks were tried that way, on one photograph. Every one of them lands
 * its own render 0.019–0.034 steps from the reference it made — the residue of
 * grading the sample instead of the whole frame, since the answer is not 0.00 —
 * and none of the 663 is nearer by more than 0.01. Seven were offered as the
 * first card. The eighth was offered second, behind another look whose render
 * measures 0.006 steps closer: two prints that this yardstick cannot tell apart,
 * not a look the ranking lost.
 *
 * ## What is never done
 * The reference is read for numbers and then forgotten. Its pixels are not
 * blended, sampled, cloned, transferred or composited into the edit, and nothing
 * leaves the browser: no service is asked, no key is used, and the file never
 * enters the photograph list the stage can draw from. `matchToReference` takes
 * `StyleRead` values and a sample of the *user's own* file — there is no path
 * from this code to a reference bitmap even by accident.
 *
 * ## Cost
 * 663 usable looks × 4,096 pixels through the CPU fallback's own loop, plus one
 * style read each: measured at 0.89 ms per look, so a ranking pass runs 0.9–1.4 s
 * in the test suite — the wider end is a pass that also works the residual turns
 * out — and it is only paid when the user asks. It is sliced with a yield to the
 * browser every 40 looks so the panel repaints between chunks rather than
 * freezing.
 */

import {
  CONTROLS,
  IDENTITY,
  clampToControl,
  type AdjustmentId,
  type Adjustments,
  type Control,
} from '../image/adjustments';
import { gradeSample } from '../preset/effect';
import { isUsable } from '../preset/library';
import type { Preset, PresetLibrary } from '../preset/schema';
import {
  STYLE_FIELDS,
  readStyleRgb,
  readStyleRgba,
  styleDistance,
  styleGaps,
  styleSteps,
  subtractStyle,
  type StyleFieldId,
  type StyleGap,
  type StyleRead,
} from './styleRead';

/**
 * The photograph being matched: its sample, and the reading taken from it.
 *
 * Both are needed because every candidate is graded *on the sample* — the
 * baseline read alone would put us back to arithmetic between unlike pictures.
 */
export type StyleSubject = {
  readonly rgba: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  readonly read: StyleRead;
};

export function makeStyleSubject(rgba: ArrayLike<number>, width: number, height: number): StyleSubject {
  return { rgba, width, height, read: readStyleRgba(rgba, width * height) };
}

/** The reading after one look, taken from the engine's own render of the sample. */
export function gradedRead(subject: StyleSubject, adjust: Partial<Adjustments>, out: Uint8Array): StyleRead {
  gradeSample(subject.rgba, subject.width, subject.height, adjust, out);
  return readStyleRgb(out, subject.width * subject.height);
}

// ── Knob sensitivities, measured where the knob actually sits ────────────────

/* A probe big enough to read above the sample's rounding, small enough to stay
   near the value being nudged. Slider knobs are probed at 15 units; exposure is
   already in stops, so it is probed at a fifth of one. */
const PROBE: Partial<Record<AdjustmentId, number>> = { exposure: 0.2 };
const DEFAULT_PROBE = 15;

function probeOf(control: Control): number {
  return PROBE[control.id] ?? Math.max(DEFAULT_PROBE, control.step * 5);
}

/**
 * How much each knob moves each characteristic, measured on this photograph with
 * this look already on it.
 *
 * It has to be measured there rather than in the abstract, because the looks on
 * offer are not neutral: one already at saturation −60 has nowhere left to go,
 * and a probe from identity would tell the descent it could still pull colour
 * out. Each probe grades the sample once, so this runs for the handful of matches
 * shown, not for the whole catalogue.
 */
function sensitivitiesAround(
  subject: StyleSubject,
  recipe: Adjustments,
  base: StyleRead,
  scratch: Uint8Array,
): Map<AdjustmentId, { control: Control; vector: StyleRead }> {
  const out = new Map<AdjustmentId, { control: Control; vector: StyleRead }>();
  for (const control of CONTROLS) {
    const current = recipe[control.id];
    const magnitude = probeOf(control);
    const forward = clampToControl(control.id, current + magnitude) - current;
    const move = forward !== 0 ? forward : clampToControl(control.id, current - magnitude) - current;
    if (move === 0) continue;
    const probed = gradedRead(subject, { ...recipe, [control.id]: current + move }, scratch);
    const per = {} as Record<StyleFieldId, number>;
    for (const field of STYLE_FIELDS) per[field.id] = (probed[field.id] - base[field.id]) / move;
    out.set(control.id, { control, vector: per as StyleRead });
  }
  return out;
}

/** The moves a descent is allowed to consider: round numbers a slider can hold. */
function candidatesFor(control: Control, current: number): number[] {
  const coarse = control.id === 'exposure' ? 0.1 : Math.max(5, Math.round(control.step * 5));
  const out: number[] = [];
  for (const size of [coarse, coarse * 2, coarse * 3]) {
    for (const sign of [1, -1]) {
      const delta = size * sign;
      if (clampToControl(control.id, current + delta) !== current + delta) continue;
      out.push(delta);
    }
  }
  return out;
}

// ── The search ───────────────────────────────────────────────────────────────

export type ReferenceTurn = {
  readonly id: AdjustmentId;
  readonly label: string;
  /** Slider units, signed: the move on top of the look's own value. */
  readonly delta: number;
  /** The move in the words the knob shows, e.g. `+15` or `−0.20 EV`. */
  readonly deltaText: string;
  /** The absolute slider value the move lands on, likewise. */
  readonly valueText: string;
};

export type ReferenceMatch = {
  readonly preset: Preset;
  /** How far the rendered photograph still reads from the reference, in clear steps. */
  readonly gap: number;
  /** What the engine's render of this photograph reads as, with the look on it. */
  readonly predicted: StyleRead;
  /** What is still missing after the look, largest first. */
  readonly gaps: readonly StyleGap[];
  /** Supported knobs that measurably close the rest, or empty. */
  readonly turns: readonly ReferenceTurn[];
  /** The distance with those turns on, when re-rendering confirmed them. */
  readonly turnsGap: number | null;
};

export type ReferenceResult = {
  /** The two photographs, before anything is done. */
  readonly before: number;
  readonly source: StyleRead;
  readonly target: StyleRead;
  /** True when the reference and the photograph already read alike. */
  readonly alreadyAlike: boolean;
  /** False when no look measured better than leaving the file alone. */
  readonly useful: boolean;
  readonly measured: number;
  readonly matches: readonly ReferenceMatch[];
};

export type ReferenceOptions = {
  /** Cards to return. */
  readonly limit?: number;
  /** Cards to work the residual turns out for. */
  readonly turnLimit?: number;
};

const ALIKE_STEPS = 0.4;
const USEFUL_MARGIN = 0.15;
const MIN_GAIN = 0.1;
const MAX_TURNS = 3;
/* One look is a quarter of a 60 Hz frame's budget, so the panel repaints between
   chunks instead of freezing for the whole catalogue. */
const YIELD_EVERY = 40;

/* A task boundary rather than a timer. `setTimeout(0)` is clamped to a
   millisecond in a foreground tab and to whole seconds in a background one, so
   a hidden tab would stretch this pass out for no reason; a message-channel
   task is the same device the UI scheduler uses to let the browser paint
   between chunks of work. */
let boundary: MessageChannel | null = null;

function yieldToBrowser(): Promise<void> {
  const channel = (boundary ??= new MessageChannel());
  return new Promise((resolve) => {
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

/**
 * The moves that close the rest of the gap, offered only if a re-render agrees.
 *
 * The descent is greedy over the measured sensitivities, then the whole combined
 * recipe — the look plus every proposed turn — is graded again and read again. If
 * that render does not improve the distance by `MIN_GAIN` steps, nothing is
 * returned: a proposal the engine cannot confirm is worse than no proposal,
 * because it teaches the user to distrust the number.
 */
function verifiedTurns(
  subject: StyleSubject,
  preset: Preset,
  target: StyleRead,
  gapBefore: number,
  predicted: StyleRead,
  scratch: Uint8Array,
): { turns: readonly ReferenceTurn[]; gap: number } | null {
  const recipe = { ...IDENTITY, ...preset.adjust } as Adjustments;
  const sens = sensitivitiesAround(subject, recipe, predicted, scratch);
  const values = { ...recipe } as Record<AdjustmentId, number>;
  let residual = subtractStyle(target, predicted);
  const used = new Set<AdjustmentId>();
  const turns: ReferenceTurn[] = [];

  for (let round = 0; round < MAX_TURNS; round++) {
    let best: { id: AdjustmentId; delta: number; cost: number } | null = null;
    for (const [id, { control, vector }] of sens) {
      if (used.has(id)) continue;
      for (const delta of candidatesFor(control, values[id])) {
        const moved = { ...residual } as Record<StyleFieldId, number>;
        for (const field of STYLE_FIELDS) moved[field.id] = residual[field.id] - delta * vector[field.id];
        const cost = styleSteps(moved as StyleRead);
        if (best === null || cost < best.cost) best = { id, delta, cost };
      }
    }
    if (!best) break;
    /* Each step must pay for a third of the overall margin, so three small moves
       cannot add up to a proposal that was never worth making. */
    if (styleSteps(residual) - best.cost < MIN_GAIN / MAX_TURNS) break;
    const entry = sens.get(best.id);
    if (!entry) break;
    values[best.id] = clampToControl(best.id, values[best.id] + best.delta);
    used.add(best.id);
    turns.push({
      id: best.id,
      label: entry.control.label,
      delta: best.delta,
      deltaText: entry.control.format(best.delta),
      valueText: entry.control.format(values[best.id]),
    });
    const moved = { ...residual } as Record<StyleFieldId, number>;
    for (const field of STYLE_FIELDS) moved[field.id] = residual[field.id] - best.delta * entry.vector[field.id];
    residual = moved as StyleRead;
  }

  if (turns.length === 0) return null;

  const combined = { ...IDENTITY } as Record<AdjustmentId, number>;
  for (const control of CONTROLS) {
    if (values[control.id] !== IDENTITY[control.id]) combined[control.id] = values[control.id];
  }
  const gap = styleDistance(gradedRead(subject, combined as Partial<Adjustments>, scratch), target);
  if (gapBefore - gap < MIN_GAIN) return null;
  return { turns, gap };
}

/**
 * Rank the catalogue by how near the reference it renders this photograph.
 *
 * `subject` is the file being edited; `target` is the reference's reading,
 * produced by `readStyleRgba` on its 64×64 sample and nothing else. There is no
 * blob, bitmap or url in this signature, which is what keeps "the reference is
 * only ever measured" a property of the code rather than a promise in prose.
 */
export async function matchToReference(
  library: PresetLibrary,
  subject: StyleSubject,
  target: StyleRead,
  options: ReferenceOptions = {},
): Promise<ReferenceResult> {
  const limit = Math.max(1, options.limit ?? 4);
  const turnLimit = Math.max(0, options.turnLimit ?? Math.min(2, limit));
  const before = styleDistance(subject.read, target);
  const pool = library.presets.filter(isUsable);
  const scratch = new Uint8Array(subject.width * subject.height * 3);

  const rows: { preset: Preset; predicted: StyleRead; gap: number }[] = [];
  for (let i = 0; i < pool.length; i++) {
    const preset = pool[i];
    const predicted = gradedRead(subject, preset.adjust, scratch);
    rows.push({ preset, predicted, gap: styleDistance(predicted, target) });
    if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToBrowser();
  }
  rows.sort((a, b) => a.gap - b.gap || a.preset.id.localeCompare(b.preset.id));

  /* Two cards from one family is enough for a choice; five is five variants of
     the same answer. The cap matches the recommender's. */
  const shortlist: typeof rows = [];
  const perCategory = new Map<string, number>();
  for (const row of rows) {
    if (shortlist.length >= limit) break;
    const seen = perCategory.get(row.preset.category) ?? 0;
    if (seen >= 2) continue;
    perCategory.set(row.preset.category, seen + 1);
    shortlist.push(row);
  }

  const matches: ReferenceMatch[] = [];
  for (let i = 0; i < shortlist.length; i++) {
    const row = shortlist[i];
    let turns: readonly ReferenceTurn[] = [];
    let turnsGap: number | null = null;
    if (i < turnLimit) {
      const found = verifiedTurns(subject, row.preset, target, row.gap, row.predicted, scratch);
      if (found) {
        turns = found.turns;
        turnsGap = found.gap;
      }
    }
    matches.push({
      preset: row.preset,
      gap: row.gap,
      predicted: row.predicted,
      gaps: styleGaps(row.predicted, target),
      turns,
      turnsGap,
    });
    await yieldToBrowser();
  }

  return {
    before,
    source: subject.read,
    target,
    alreadyAlike: before <= ALIKE_STEPS,
    useful: matches.length > 0 && matches[0].gap <= before - USEFUL_MARGIN,
    measured: pool.length,
    matches,
  };
}

/**
 * The whole edit a match proposes: the look's own recipe with the confirmed
 * turns folded in, as absolute slider values.
 *
 * It comes back as a full `Adjustments` rather than a delta so the caller can
 * hand it to the same preview path a preset takes, and so accepting it is one
 * undoable step instead of a look plus two hidden adjustments.
 */
export function referenceRecipe(match: ReferenceMatch): Adjustments {
  const recipe = { ...IDENTITY, ...match.preset.adjust } as Record<AdjustmentId, number>;
  for (const turn of match.turns) recipe[turn.id] = clampToControl(turn.id, recipe[turn.id] + turn.delta);
  return recipe as Adjustments;
}
