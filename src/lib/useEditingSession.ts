/**
 * The shared editing session for Phase 9.
 *
 * Composes usePhotoLoader and useAdjustments into one object that all three
 * editing modes — AI Edit, Presets, Manual Edit — read from and write to.
 * Switching modes does not reset the photograph or discard adjustments because
 * both hooks are owned here, above the mode tabs.
 *
 * ## What this adds over calling the two hooks separately
 *
 * - A single `EditingSession` type that names every piece of shared state.
 * - AI suggestion storage: suggestions are held here and never touch the
 *   pipeline until the user explicitly accepts one.
 * - `acceptSuggestion` / `dismissSuggestion` — the only two ways a suggestion
 *   enters or leaves the pipeline.
 * - `applyLook` — wraps applyPresetPreserving so the Editor does not need to
 *   import the helper directly.
 *
 * ## What this does NOT do
 *
 * - It does not generate AI suggestions. That is the responsibility of
 *   whatever AI integration is added in a later phase. This hook only stores
 *   and applies them.
 * - It does not change the pipeline order. The canonical order is documented
 *   in adjustments.ts (PIPELINE_ORDER) and implemented in pipeline.ts.
 * - It does not redesign the UI.
 */

import { useCallback, useState } from 'react';
import { IDENTITY, applyPresetPreserving, type AiSuggestion, type Adjustments } from './image/adjustments';
import { presetAdjustments, type Preset } from './preset/schema';
import { useAdjustments, type EditingSnapshot } from './useAdjustments';
import { useProposal, type ProposalApi } from './useProposal';
import { usePhotoLoader, type WorkspaceStatus } from './usePhotoLoader';
import type { Photo, PhotoError } from './photoStore';
import type { AdjustmentsState } from './image/adjustments';

/** The three editing modes the session supports. */
export type EditMode = 'ai' | 'presets' | 'manual';

/**
 * The complete shared editing state.
 *
 * All three modes read from this object. Writing always goes through the
 * methods below — never by mutating fields directly.
 */
export type EditingSession = {
  // ── Photo ──────────────────────────────────────────────────────────────────
  /** The original photograph. Null until a file is loaded. */
  photo: Photo | null;
  status: WorkspaceStatus;
  error: PhotoError | null;
  load: (file: File) => void;
  dismissError: () => void;

  // ── Adjustments (delegated to useAdjustments) ──────────────────────────────
  /** The combined (preset + manual) adjustments, ready for the renderer. */
  edits: AdjustmentsState;

  // ── Mode ───────────────────────────────────────────────────────────────────
  mode: EditMode;
  setMode: (mode: EditMode) => void;

  // ── AI suggestions ─────────────────────────────────────────────────────────
  /** Pending suggestions from the AI layer. Not yet applied to the pipeline. */
  suggestions: readonly AiSuggestion[];
  /**
   * Store suggestions produced by the AI layer. Replaces any previous list.
   * Does not apply them — the user must call acceptSuggestion.
   */
  setSuggestions: (suggestions: AiSuggestion[]) => void;
  /**
   * Accept a suggestion: apply its recipe as manual offsets on top of the
   * current preset (or as a standalone recipe if no preset is active), then
   * remove it from the pending list. The action is undoable.
   */
  acceptSuggestion: (id: string) => void;
  /** Remove a suggestion without applying it. */
  dismissSuggestion: (id: string) => void;

  // ── Preset helpers ─────────────────────────────────────────────────────────
  /**
   * Apply a preset look. The current state is pushed onto the undo stack
   * first, so the previous recipe (including any manual offsets) is one
   * Undo step away. Manual offsets are cleared because they were relative
   * to the old preset baseline.
   */
  applyLook: (preset: Preset) => void;

  // ── Proposals (preview before apply) ───────────────────────────────────────
  /**
   * A look being previewed. It is drawn on the stage but is NOT in the editing
   * history: reject drops it, accept commits it as one undoable step.
   */
  proposals: ProposalApi;
  /** Bumped by the "Enhance My Photo" toolbar action; the AI panel runs on change. */
  enhanceRequest: number;
  requestEnhance: () => void;
  /** Undo/redo that first drops any pending proposal. */
  undo: () => void;
  redo: () => void;

  // ── Snapshot (for ProjectsPanel / save-restore) ────────────────────────────
  snapshot: EditingSnapshot;
};

export function useEditingSession(): EditingSession {
  const photoLoader = usePhotoLoader();
  const edits = useAdjustments(photoLoader.photo?.url);

  const proposals = useProposal(edits, photoLoader.photo?.url);
  const { reject: rejectProposal } = proposals;
  const [mode, setModeState] = useState<EditMode>('presets');
  const [enhanceRequest, setEnhanceRequest] = useState(0);

  /* A pending proposal belongs to the AI panel. Leaving it (to Presets or
     Manual Edit) is a rejection: the edit on the stage stays exactly as it was. */
  const setMode = useCallback(
    (next: EditMode) => {
      if (next !== 'ai') rejectProposal();
      setModeState(next);
    },
    [rejectProposal],
  );

  const requestEnhance = useCallback(() => {
    setModeState('ai');
    setEnhanceRequest((n) => n + 1);
  }, []);

  const { undo: undoEdit, redo: redoEdit } = edits;
  const undo = useCallback(() => {
    rejectProposal();
    undoEdit();
  }, [rejectProposal, undoEdit]);
  const redo = useCallback(() => {
    rejectProposal();
    redoEdit();
  }, [rejectProposal, redoEdit]);
  const [suggestions, setSuggestionsState] = useState<AiSuggestion[]>([]);

  const setSuggestions = useCallback((next: AiSuggestion[]) => {
    setSuggestionsState(next);
  }, []);

  const acceptSuggestion = useCallback(
    (id: string) => {
      const suggestion = suggestions.find((s) => s.id === id);
      if (!suggestion) return;
      // Apply the suggestion recipe as manual offsets via applyPreset so it
      // lands as a named, undoable step. We treat it as a preset with the
      // suggestion's label as the id so the history is readable.
      const full: Adjustments = { ...IDENTITY, ...suggestion.recipe };
      edits.applyPreset(full, `ai:${id}`);
      setSuggestionsState((prev) => prev.filter((s) => s.id !== id));
    },
    [suggestions, edits],
  );

  const dismissSuggestion = useCallback((id: string) => {
    setSuggestionsState((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const applyLook = useCallback(
    (preset: Preset) => {
      rejectProposal();
      applyPresetPreserving(
        presetAdjustments(preset, IDENTITY),
        preset.id,
        edits.applyPreset,
      );
    },
    [edits.applyPreset, rejectProposal],
  );

  return {
    photo: photoLoader.photo,
    status: photoLoader.status,
    error: photoLoader.error,
    load: photoLoader.load,
    dismissError: photoLoader.dismissError,
    edits,
    mode,
    setMode,
    suggestions,
    setSuggestions,
    acceptSuggestion,
    dismissSuggestion,
    applyLook,
    proposals,
    enhanceRequest,
    requestEnhance,
    undo,
    redo,
    snapshot: edits.snapshot,
  };
}
