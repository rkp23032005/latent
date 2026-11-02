import { useCallback, useMemo, useRef, useState } from 'react';
import {
  IDENTITY,
  NO_OFFSETS,
  clampAdjustments,
  clampToControl,
  combineLayers,
  isIdentity,
  sameAdjustments,
  scaleRecipe,
  type AdjustmentId,
  type Adjustments,
  type AdjustmentsState,
} from './image/adjustments';

type Chosen = { recipe: Adjustments; presetId: string };

/** The part of the editing state that describes the recipe, not the file. */
export type EditingSnapshot = {
  chosen: Chosen | null;
  intensity: number;
  offsets: Adjustments;
};

/**
 * What is remembered, in two layers that never overwrite each other.
 *
 * `intensity` scales the look, `offsets` is what the user turned by hand on top
 * of it. Keeping them apart is what lets the intensity slider move without
 * quietly re-basing the edits, and lets one knob snap back to the look's value.
 *
 * The url rides along so a snapshot cannot be mistaken for one of another
 * photograph's. Snapshots are a handful of numbers — no pixels, no files.
 */
type Editing = EditingSnapshot & { url: string | undefined };

const NOTHING: Editing = { url: undefined, chosen: null, intensity: 100, offsets: NO_OFFSETS };

/** Enough to walk back through a session without holding the tab hostage. */
const LIMIT = 100;
/** A drag is one decision, however many input events it fires. */
const GESTURE_MS = 700;

type History = { past: Editing[]; present: Editing; future: Editing[] };

function fresh(url: string | undefined): History {
  return { past: [], present: { ...NOTHING, url }, future: [] };
}

/**
 * Editing state tied to one source photograph, with a history of small
 * snapshots behind it.
 *
 * The url is part of the state rather than an effect: the moment the stage
 * holds a different file, the remembered knobs are no longer about it, so they
 * read as identity — and its history reads as empty — without an extra render
 * in between. Nothing here touches the photograph; this is only the recipe.
 *
 * A preset is kept as the baseline the knobs were set from, which is what makes
 * "Cinematic Amber, changed by you" an honest label instead of a guess.
 */
export function useAdjustments(sourceUrl: string | undefined): AdjustmentsState {
  const [stored, setStored] = useState<History>(() => fresh(sourceUrl));
  const history = stored.present.url === sourceUrl ? stored : fresh(sourceUrl);
  const { chosen, intensity, offsets } = history.present;

  /* Which gesture the last commit belonged to, and when. A knob dragged across
     a hundred input events should cost one press of Undo, while a second visit
     to the same knob after a pause is its own decision. */
  const gesture = useRef<{ key: string; at: number } | null>(null);

  const commit = useCallback(
    (change: (current: Editing) => Editing, key: string | null) => {
      const now = Date.now();
      const previousGesture = gesture.current;
      const merge =
        key !== null &&
        previousGesture !== null &&
        previousGesture.key === key &&
        now - previousGesture.at <= GESTURE_MS;
      gesture.current = key === null ? null : { key, at: now };

      setStored((previous) => {
        /* A change made against a photograph the history has not caught up
           with starts a clean history rather than editing the old one. */
        const base = previous.present.url === sourceUrl ? previous : fresh(sourceUrl);
        const next = change(base.present);
        if (sameEditing(base.present, next)) return base;
        if (merge && base.past.length > 0) {
          return { past: base.past, present: next, future: [] };
        }
        return {
          past: [...base.past, base.present].slice(-LIMIT),
          present: next,
          future: [],
        };
      });
    },
    [sourceUrl],
  );

  /* The look, dialled to the intensity, then whatever was turned by hand. */
  const blended = useMemo(
    () => (chosen ? scaleRecipe(chosen.recipe, intensity) : IDENTITY),
    [chosen, intensity],
  );
  const values = useMemo(() => combineLayers(blended, offsets), [blended, offsets]);
  const snapshot = useMemo<EditingSnapshot>(
    () => ({ chosen, intensity, offsets }),
    [chosen, intensity, offsets],
  );

  const set = useCallback(
    (id: AdjustmentId, value: number) => {
      commit((current) => {
        const look = current.chosen ? scaleRecipe(current.chosen.recipe, current.intensity) : IDENTITY;
        return {
          ...current,
          offsets: { ...current.offsets, [id]: offsetTo(id, value, look[id]) },
        };
      }, `knob:${id}`);
    },
    [commit],
  );

  const resetKnob = useCallback(
    (id: AdjustmentId) => {
      commit((current) => ({
        ...current,
        offsets: { ...current.offsets, [id]: 0 },
      }), null);
    },
    [commit],
  );

  const setIntensity = useCallback(
    (value: number) => {
      commit((current) => ({
        ...current,
        intensity: Math.min(100, Math.max(0, value)),
      }), 'intensity');
    },
    [commit],
  );

  const applyPreset = useCallback(
    (next: Adjustments, presetId: string) => {
      commit((current) => ({
        url: current.url,
        chosen: { recipe: next, presetId },
        intensity: 100,
        offsets: NO_OFFSETS,
      }), null);
    },
    [commit],
  );

  const applyState = useCallback(
    (next: EditingSnapshot) => {
      const safe = copySnapshot(next);
      commit((current) => ({ url: current.url, ...safe }), null);
    },
    [commit],
  );

  const reset = useCallback(
    () =>
      commit((current) => ({
        url: current.url,
        chosen: null,
        intensity: 100,
        offsets: NO_OFFSETS,
      }), null),
    [commit],
  );

  const undo = useCallback(() => {
    gesture.current = null;
    setStored((previous) => {
      const base = previous.present.url === sourceUrl ? previous : fresh(sourceUrl);
      if (base.past.length === 0) return base;
      const restored = base.past[base.past.length - 1];
      return {
        past: base.past.slice(0, -1),
        present: restored,
        future: [base.present, ...base.future],
      };
    });
  }, [sourceUrl]);

  const redo = useCallback(() => {
    gesture.current = null;
    setStored((previous) => {
      const base = previous.present.url === sourceUrl ? previous : fresh(sourceUrl);
      if (base.future.length === 0) return base;
      const [restored, ...rest] = base.future;
      return {
        past: [...base.past, base.present].slice(-LIMIT),
        present: restored,
        future: rest,
      };
    });
  }, [sourceUrl]);

  return {
    values,
    dirty: !isIdentity(values),
    activePreset: chosen?.presetId ?? null,
    modified: chosen !== null && Object.values(offsets).some((offset) => offset !== 0),
    intensity,
    snapshot,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    steps: history.past.length,
    set,
    setIntensity,
    resetKnob,
    applyPreset,
    applyState,
    reset,
    undo,
    redo,
  };
}

/**
 * A hand turn, stored as a distance from the look rather than an absolute
 * value, so intensity can move the look underneath it without the edit being
 * silently re-based. The knob lands at `look + offset`, which combineLayers
 * clamps into range — and a value already clamped never needs clamping again.
 */
function offsetTo(id: AdjustmentId, value: number, look: number): number {
  return clampToControl(id, value) - look;
}

function sameEditing(a: Editing, b: Editing): boolean {
  if (a.url !== b.url || a.intensity !== b.intensity) return false;
  if ((a.chosen === null) !== (b.chosen === null)) return false;
  if (a.chosen && b.chosen) {
    if (a.chosen.presetId !== b.chosen.presetId) return false;
    if (!sameAdjustments(a.chosen.recipe, b.chosen.recipe)) return false;
  }
  return sameAdjustments(a.offsets, b.offsets);
}

/** Stored projects are validated on the way in; clamp here anyway. */
function copySnapshot(snapshot: EditingSnapshot): EditingSnapshot {
  return {
    chosen: snapshot.chosen
      ? { presetId: snapshot.chosen.presetId, recipe: clampAdjustments(snapshot.chosen.recipe) }
      : null,
    intensity: Number.isFinite(snapshot.intensity)
      ? Math.min(100, Math.max(0, snapshot.intensity))
      : 100,
    offsets: clampAdjustments(snapshot.offsets),
  };
}
