/**
 * AI Photo Assistant panel.
 *
 * Four sections:
 *
 * 1. Enhance My Photo — an explicit action: three visually distinct options
 *    (Natural, Cinematic, Creative) adapted to the current photograph.
 *    Automated rules, not an AI model; says so clearly.
 *
 * 2. Conversational Edit — natural-language commands translated by a local
 *    rule-based parser into validated adjustment instructions. No external
 *    model, no network requests. Ambiguous requests offer choices; unsupported
 *    requests explain the limitation.
 *
 * 3. Style Search — a free-text query that suggests real presets from the
 *    library. Chips for common styles. Each card is labelled with the basis it
 *    sits on — the words typed, the numbers measured on this file, or the looks
 *    the user keeps — so a personal preference is never shown as a verdict.
 *
 * 4. Match a Reference Photograph — a second file is measured, the catalogue is
 *    rendered onto the user's own photograph, and the looks are ranked by how
 *    near the reference each render lands. Local only, and the reference's
 *    pixels never enter the edit. See `ReferencePanel.tsx`.
 *
 * Every suggestion shows:
 * - The real preset name and category
 * - A live thumbnail rendered by the existing engine
 * - What the look does, read off its own recipe
 * - A short explanation of why it was suggested, and on what basis
 * - A Preview button (shows on the stage at a measured starting intensity; the
 *   edit is not changed)
 * - An Apply button (one undoable step in the editing history)
 *
 * The analysis is honest about what was measured vs what was inferred.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { ConversationalEdit } from './ConversationalEdit';
import { EnhancePanel } from './EnhancePanel';
import { Icon } from './Icon';
import { Progress } from './Progress';
import { ReferencePanel } from './ReferencePanel';
import type { Photo } from '../lib/photoStore';
import type { Preset } from '../lib/preset/schema';
import type { PresetLibrary } from '../lib/preset/schema';
import { usePresetLibrary } from '../lib/preset/usePresetLibrary';
import { coverSource, queueThumb } from '../lib/preset/thumb';
import type { ImageAnalysis } from '../lib/ai/imageAnalysis';
import { analysePhotoOnce } from '../lib/ai/useImageAnalysis';
import { generateOptions, type EnhanceOption } from '../lib/ai/enhance';
import { suggestIntensity } from '../lib/ai/intensity';
import { suggestPresets, type Suggestion, type SuggestionBasis } from '../lib/ai/recommender';
import type { Adjustments } from '../lib/image/adjustments';

// ── Conversational suggestion chips ─────────────────────────────────────────

const QUERY_CHIPS = [
  'Cinematic sunset',
  'Warm film look',
  'Natural portrait',
  'Black and white',
  'Moody night photography',
  'Bright travel photo',
  'Faded vintage colours',
  'Street photography',
] as const;

// ── Types ────────────────────────────────────────────────────────────────────

type AssistantState =
  | { phase: 'idle' }
  | { phase: 'analysing' }
  | { phase: 'ready'; analysis: ImageAnalysis; suggestions: Suggestion[]; query: string }
  | { phase: 'error'; message: string };

/** The user's own marks, read from the shared store when a list is built. */
type Personal = {
  readonly favourites: readonly string[];
  readonly recent: readonly string[];
  readonly styles: readonly string[];
};

/** How a suggestion came about, in the words the card shows. */
const BASIS_LABEL: Record<SuggestionBasis, string> = {
  search: 'Your words',
  image: 'Measured on this photograph',
  personal: 'From what you keep',
};

type AiAssistantProps = {
  photo: Photo | null;
  /**
   * Commit a look. `intensity` is the measured starting strength; omitting it
   * applies the look exactly as written.
   */
  onApply: (preset: Preset, intensity?: number) => void;
  onPreview: (preset: Preset, source: 'rules' | 'search', label?: string, intensity?: number) => void;
  /**
   * Preview an adjustment-based proposal (from the conversational editor or the
   * reference matcher). Creates a synthetic preset from the adjustments and
   * previews it. `origin` names where the proposal came from in the bar above
   * the stage, so a matched reference is not labelled as the user's words.
   */
  onPreviewAdjustments: (adjustments: Partial<Adjustments>, summary: string, origin?: string) => void;
  /** Accept the current proposal (conversational or preset). */
  onAcceptProposal: () => void;
  /** Reject the current proposal. */
  onRejectProposal: () => void;
  /** The id of the currently active preset, so we can mark it as applied. */
  activePresetId?: string | null;
  /**
   * The knobs as they stand now — the applied look plus any hand turns. A
   * conversational request is folded into these, so it adds to the photograph
   * instead of replacing the edit that is already on it.
   */
  currentAdjustments: Adjustments;
  /** The id of the look being previewed (not yet accepted), if any. */
  previewingId: string | null;
  /** True when any proposal is being previewed. */
  isPreviewing: boolean;
  /** Bumped by the toolbar's Enhance action. */
  enhanceRequest: number;
  /** Current intensity of the applied look, 0–100. */
  intensity: number;
  /** Called when the user moves the intensity slider. */
  onIntensity: (value: number) => void;
};

// ── Main component ───────────────────────────────────────────────────────────

export function AiAssistant({
  photo,
  onApply,
  onPreview,
  onPreviewAdjustments,
  onAcceptProposal,
  onRejectProposal,
  activePresetId,
  currentAdjustments,
  previewingId,
  isPreviewing,
  enhanceRequest,
  intensity,
  onIntensity,
}: AiAssistantProps) {
  const {
    library,
    status: libStatus,
    error: libError,
    retry,
    favourites,
    recent,
    styles,
    recallStyle,
  } = usePresetLibrary();
  const [state, setState] = useState<AssistantState>({ phase: 'idle' });
  const [query, setQuery] = useState('');
  const [enhanceOptions, setEnhanceOptions] = useState<EnhanceOption[]>([]);
  const lastPhotoUrl = useRef<string | null>(null);

  const runAnalysis = useCallback(
    async (currentPhoto: Photo, currentLibrary: PresetLibrary, queryText: string, personal: Personal) => {
      setState({ phase: 'analysing' });
      try {
        const analysis = await analysePhotoOnce(currentPhoto);
        const suggestions = suggestPresets(currentLibrary, {
          query: queryText,
          analysis,
          favourites: personal.favourites,
          recent: personal.recent,
          styles: personal.styles,
        });
        const options = generateOptions(currentLibrary, analysis);
        setEnhanceOptions(options);
        setState({ phase: 'ready', analysis, suggestions, query: queryText });
      } catch (err) {
        setState({
          phase: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'The photograph could not be analysed. Try a different file.',
        });
      }
    },
    [],
  );

  /* The marks are read when a suggestion list is built, not stored in this
     component: one copy of them lives in the preferences store. */
  const personal = useMemo(() => ({ favourites, recent, styles }), [favourites, recent, styles]);

  // Measurements are per photograph, so asking again does not decode it twice.
  useEffect(() => {
    if (!photo || !library) return;
    if (photo.url === lastPhotoUrl.current) return;
    lastPhotoUrl.current = photo.url;
    setQuery('');
    void runAnalysis(photo, library, '', personal);
  }, [photo, library, runAnalysis, personal]);

  const handleQuery = useCallback(
    (q: string) => {
      if (!photo || !library) return;
      setQuery(q);
      if (q.trim()) recallStyle(q);
      void runAnalysis(photo, library, q, personal);
    },
    [photo, library, runAnalysis, personal, recallStyle],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      handleQuery(query);
    },
    [query, handleQuery],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <section className="rail rail--looks ai-assistant" aria-labelledby="ai-title">
      <div className="rail__head">
        <h2 className="caps rail__head-title" id="ai-title">
          AI Edit
        </h2>
        {state.phase === 'ready' && (
          <span className="meta meta--micro looks__count">
            {state.suggestions.length} style suggestions
          </span>
        )}
      </div>

      {/* Library not ready */}
      {libStatus === 'loading' && (
        <div className="looks__state" role="status">
          <Progress label="Loading preset library" />
          <p className="body-muted">Loading the preset catalogue…</p>
        </div>
      )}
      {libStatus === 'error' && (
        <div className="looks__state looks__state--bad" role="alert">
          <Icon name="close" size={16} />
          <p className="body-muted">{libError ?? 'The preset catalogue could not be loaded.'}</p>
          <Button variant="ghost" size="sm" onClick={retry} iconLeft="undo">
            Try again
          </Button>
        </div>
      )}

      {/* ── One-tap enhance ─────────────────────────────────────────────── */}
      {libStatus === 'ready' && (
        <>
          <div className="enhance__section-head">
            <Icon name="sliders" size={14} />
            <span className="caps enhance__section-title">Enhance My Photo</span>
          </div>
          <EnhancePanel
            photo={photo}
            library={library}
            activePresetId={activePresetId ?? null}
            intensity={intensity}
            previewingId={previewingId}
            enhanceRequest={enhanceRequest}
            onApply={(preset, _label, intensity) => onApply(preset, intensity)}
            onPreview={(preset, label, intensity) => onPreview(preset, 'rules', label, intensity)}
            onIntensity={onIntensity}
          />
          <div className="enhance__divider" role="separator" aria-hidden="true" />

          {/* ── Conversational Edit ──────────────────────────────────────── */}
          <div className="enhance__section-head">
            <Icon name="sliders" size={14} />
            <span className="caps enhance__section-title">Edit by Description</span>
          </div>
          {photo ? (
            <ConversationalEdit
              enhanceOptions={enhanceOptions}
              currentAdjustments={currentAdjustments}
              onPreviewAdjustments={onPreviewAdjustments}
              onPreviewPreset={(preset, label) => onPreview(preset, 'rules', label)}
              onAccept={onAcceptProposal}
              onReject={onRejectProposal}
              isPreviewing={isPreviewing}
              hasPhoto={!!photo}
            />
          ) : (
            <div className="enhance__empty">
              <Icon name="image" size={16} />
              <p className="body-muted">Load a photograph to use conversational editing.</p>
            </div>
          )}

          <div className="enhance__divider" role="separator" aria-hidden="true" />
          <span className="caps enhance__section-title enhance__section-title--query">Style Search</span>
        </>
      )}

      {/* Photo loaded — show style-search query and recommendations */}
      {libStatus === 'ready' && photo && (
        <>
          {/* Conversational query */}
          <form className="ai-assistant__query" onSubmit={handleSubmit} aria-label="Ask the assistant">
            <label className="looks__search" style={{ flex: '1 1 auto' }}>
              <span className="meta meta--micro">Ask for a style</span>
              <input
                type="search"
                value={query}
                placeholder="cinematic, warm portrait, black and white…"
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Describe the style you want"
              />
            </label>
            <Button variant="secondary" size="sm" type="submit" disabled={state.phase === 'analysing'}>
              {state.phase === 'analysing' ? 'Analysing…' : 'Suggest'}
            </Button>
          </form>

          <div className="ai-assistant__chips" role="group" aria-label="Quick style suggestions">
            {QUERY_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                className={['chip', query === chip && 'is-active'].filter(Boolean).join(' ')}
                onClick={() => handleQuery(chip)}
                disabled={state.phase === 'analysing'}
              >
                {chip}
              </button>
            ))}
          </div>

          {/* Analysis state */}
          {state.phase === 'analysing' && (
            <div className="looks__state" role="status">
              <Progress label="Analysing photograph" />
              <p className="body-muted">Measuring brightness, contrast and colour…</p>
            </div>
          )}

          {state.phase === 'error' && (
            <div className="looks__state looks__state--bad" role="alert">
              <Icon name="close" size={16} />
              <p className="body-muted">{state.message}</p>
              <Button
                variant="ghost"
                size="sm"
                iconLeft="undo"
                onClick={() => library && void runAnalysis(photo, library, query, personal)}
              >
                Try again
              </Button>
            </div>
          )}

          {state.phase === 'ready' && (
            <>
              {/* Analysis summary */}
              <div className="ai-assistant__analysis">
                <p className="meta meta--micro ai-assistant__analysis-label">
                  <Icon name="sliders" size={12} />
                  Measured characteristics
                </p>
                <p className="ai-assistant__summary">{state.analysis.summary}</p>
                {state.analysis.sceneHints.length > 0 && (
                  <p className="meta meta--micro ai-assistant__hints">
                    Likely scene (heuristic):{' '}
                    {state.analysis.sceneHints.join(' · ')}
                  </p>
                )}
                <p className="meta meta--micro ai-assistant__disclaimer">
                  These are pixel measurements, not AI predictions. Scene hints are heuristic
                  guesses based on colour and brightness patterns.
                </p>
              </div>

              {/* Recommendation cards */}
              {state.suggestions.length === 0 ? (
                <p className="looks__state body-muted" role="status">
                  {state.query.trim()
                    ? `No preset in the catalogue is described as “${state.query.trim()}”. Try other words, or browse the looks.`
                    : 'Nothing on this photograph measures as a good match for the looks available. Try a different file, or browse the looks.'}
                </p>
              ) : (
                <ul className="ai-assistant__recs" aria-label="Suggested presets">
                  {state.suggestions.map((rec) => (
                    <RecommendationCard
                      key={rec.preset.id}
                      rec={rec}
                      sourceUrl={photo.url}
                      startIntensity={suggestIntensity(rec.preset, state.analysis).value}
                      isApplied={activePresetId === rec.preset.id && previewingId === null}
                      isPreviewing={previewingId === rec.preset.id}
                      onApply={onApply}
                      onPreview={(preset, intensity) => onPreview(preset, 'search', undefined, intensity)}
                    />
                  ))}
                </ul>
              )}

              <p className="meta meta--micro ai-assistant__footer">
                Each card says which basis it is on. “Your words” and “Measured on this
                photograph” are arithmetic over catalogue metadata and pixel numbers; “From what
                you keep” is only your own history and is not a claim about this file. No
                model was trained, nothing left the browser, and every preset named here exists
                in the library. Preview changes only the stage; Apply is one undoable step.
              </p>
            </>
          )}

          <div className="enhance__divider" role="separator" aria-hidden="true" />

          {/* ── Reference photograph ────────────────────────────────────── */}
          <ReferencePanel
            photo={photo}
            library={library}
            analysis={state.phase === 'ready' ? state.analysis : null}
            activePresetId={activePresetId ?? null}
            previewingId={previewingId}
            onApply={(preset, intensity) => onApply(preset, intensity)}
            onPreview={(preset, intensity) => onPreview(preset, 'search', undefined, intensity)}
            onPreviewRecipe={(values, summary) =>
              onPreviewAdjustments(values, summary, 'Reference match')
            }
          />
        </>
      )}
    </section>
  );
}

// ── Recommendation card ──────────────────────────────────────────────────────

type RecCardProps = {
  rec: Suggestion;
  sourceUrl: string;
  /** The intensity this look is previewed at, from the measurements. */
  startIntensity: number;
  isApplied: boolean;
  isPreviewing: boolean;
  onApply: (preset: Preset, intensity: number) => void;
  onPreview: (preset: Preset, intensity: number) => void;
};

const RecommendationCard = memo(function RecommendationCard({
  rec,
  sourceUrl,
  startIntensity,
  isApplied,
  isPreviewing,
  onApply,
  onPreview,
}: RecCardProps) {
  const { preset, reason, basis, traits } = rec;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    const node = canvas.current;
    if (!node || !sourceUrl) return;
    let alive = true;

    const watch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        watch.disconnect();
        coverSource(sourceUrl).then(
          (bitmap) => {
            if (!alive) return;
            queueThumb(node, bitmap, preset, sourceUrl, (ok) => {
              if (!alive) return;
              if (ok) setPainted(true);
            });
          },
          () => { /* thumbnail unavailable — card still works */ },
        );
      },
      { rootMargin: '120px' },
    );
    watch.observe(node);
    return () => {
      alive = false;
      watch.disconnect();
    };
  }, [preset, sourceUrl]);

  return (
    <li className={['ai-rec', isApplied && 'ai-rec--applied', isPreviewing && 'ai-rec--previewing'].filter(Boolean).join(' ')}>
      {/* Thumbnail */}
      <div className="ai-rec__thumb-wrap">
        <canvas ref={canvas} className="ai-rec__thumb" aria-hidden="true" />
        {!painted && <span className="pcard__veil" aria-hidden="true" />}
      </div>

      {/* Info */}
      <div className="ai-rec__body">
        <div className="ai-rec__head">
          <span className="ai-rec__name">{preset.name}</span>
          <span className="meta meta--micro ai-rec__cat">
            {isApplied ? <span className="ai-rec__applied-badge">Applied</span> : isPreviewing ? <span className="ai-rec__applied-badge">Previewing</span> : preset.category}
          </span>
        </div>
        <p className="meta meta--micro ai-rec__basis">
          <span className="tag">{BASIS_LABEL[basis]}</span>
          {traits && <span className="ai-rec__traits">{traits}</span>}
        </p>
        <p className="meta meta--micro ai-rec__reason">{reason}</p>

        <div className="ai-rec__actions">
          <Button
            variant="ghost"
            size="sm"
            iconLeft="eye"
            onClick={() => onPreview(preset, startIntensity)}
            title={`Preview ${preset.name} on the stage at ${startIntensity}% — your edit is not changed`}
          >
            Preview {startIntensity}%
          </Button>
          <Button
            variant={isApplied ? 'primary' : 'secondary'}
            size="sm"
            iconLeft="check"
            onClick={() => onApply(preset, startIntensity)}
            title={`Apply ${preset.name} at ${startIntensity}% — one undoable step`}
          >
            {isApplied ? 'Applied' : 'Apply'}
          </Button>
        </div>
      </div>
    </li>
  );
});
