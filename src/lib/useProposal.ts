/**
 * A proposed look that is being looked at but has not been accepted.
 *
 * The proposal lives beside the editing history, not in it. Until the user
 * accepts, nothing here touches `useAdjustments`: the stage is simply handed
 * different numbers to draw, so rejecting is a matter of forgetting them and
 * the current edit, its history and its redo stack are exactly as they were.
 *
 * Accepting is a single `applyPreset` call, i.e. one undoable step that puts
 * the previous recipe (look, intensity and manual offsets) on the undo stack.
 * The look arrives at the proposal's intensity, and the manual controls keep
 * working on top of it as they do for any preset.
 *
 * A proposal belongs to one photograph; it reads as absent for any other.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  IDENTITY,
  applyPresetPreserving,
  combineLayers,
  scaleRecipe,
  type Adjustments,
  type AdjustmentsState,
} from './image/adjustments';
import { presetAdjustments, type Preset } from './preset/schema';

export type ProposalSource = 'rules' | 'search';

export type Proposal = {
  readonly preset: Preset;
  /** 0–100. How much of the look is being shown. */
  readonly intensity: number;
  /** Where the suggestion came from, for honest labelling. */
  readonly source: ProposalSource;
  /** Optional style name, e.g. "Cinematic". */
  readonly label?: string;
};

type Stored = (Proposal & { url: string }) | null;

export type ProposalApi = {
  proposal: Proposal | null;
  /** What the stage should draw: the proposal when there is one, else the edit. */
  stageValues: Adjustments;
  /**
   * Show a look on the stage. `intensity` is where the blend starts — callers
   * that know the photograph pass the suggestion from `suggestIntensity`, and a
   * caller that does not still gets the look exactly as written.
   */
  preview: (preset: Preset, source?: ProposalSource, label?: string, intensity?: number) => void;
  setIntensity: (value: number) => void;
  /** Commit the proposal as one undoable step. */
  accept: () => void;
  /** Forget the proposal. The current edit is untouched. */
  reject: () => void;
  /**
   * Apply a look straight away (the Apply button). If it is the look being
   * previewed it lands at the previewed intensity; otherwise at `intensity`,
   * which callers take from `suggestIntensity`, or at full strength.
   */
  applyNow: (preset: Preset, intensity?: number) => void;
};

export function useProposal(edits: AdjustmentsState, url: string | undefined): ProposalApi {
  const [stored, setStored] = useState<Stored>(null);
  const proposal: Proposal | null = stored && stored.url === url ? stored : null;

  const preview = useCallback(
    (preset: Preset, source: ProposalSource = 'rules', label?: string, intensity?: number) => {
      if (!url) return;
      const start = Number.isFinite(intensity) ? Math.min(100, Math.max(0, Math.round(intensity as number))) : 100;
      setStored({ url, preset, intensity: start, source, label });
    },
    [url],
  );

  const setIntensity = useCallback(
    (value: number) => {
      const next = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 100));
      setStored((current) => (current ? { ...current, intensity: next } : current));
    },
    [],
  );

  const reject = useCallback(() => setStored(null), []);

  const commit = useCallback(
    (preset: Preset, intensity: number) => {
      applyPresetPreserving(
        presetAdjustments(preset, IDENTITY),
        preset.id,
        edits.applyPreset,
        intensity,
      );
      setStored(null);
    },
    [edits.applyPreset],
  );

  const accept = useCallback(() => {
    if (proposal) commit(proposal.preset, proposal.intensity);
  }, [proposal, commit]);

  const applyNow = useCallback(
    (preset: Preset, intensity?: number) => {
      const same = proposal !== null && proposal.preset.id === preset.id;
      const start = Number.isFinite(intensity) ? Math.min(100, Math.max(0, Math.round(intensity as number))) : 100;
      commit(preset, same ? proposal.intensity : start);
    },
    [proposal, commit],
  );

  const stageValues = useMemo(
    () =>
      proposal
        ? combineLayers(
            scaleRecipe(presetAdjustments(proposal.preset, IDENTITY), proposal.intensity),
            IDENTITY,
          )
        : edits.values,
    [proposal, edits.values],
  );

  return { proposal, stageValues, preview, setIntensity, accept, reject, applyNow };
}
