/**
 * Enhance My Photo.
 *
 * Nothing runs until the user asks. The button measures the photograph with the
 * local pixel analysis, then offers three looks — Natural, Cinematic, Creative —
 * each a real preset chosen by fixed scoring rules. This is NOT an AI model and
 * the panel says so: it states "automated rules" wherever it describes the
 * source of a suggestion.
 *
 * ## Preview vs Apply
 * Preview only changes what the stage draws (see useProposal); the current edit
 * and its history are untouched until the user accepts. Reject, switching mode,
 * undo or redo all drop the preview. Apply commits one undoable step, at the
 * intensity the look was being previewed at.
 *
 * ## Intensity
 * Each card states the strength its blend starts at, from the rules in
 * `ai/intensity.ts` — the preset's measured effect on the test chart plus the
 * photograph's own numbers. It is a starting point, not a verdict: the slider in
 * the stage's proposal bar (previewing) or here (applied) always sets the value
 * by hand, and a hand-set value is never overwritten.
 *
 * While a look is previewed the strength slider lives in the stage's proposal
 * bar. Once a look is applied, the slider here drives the shared edit intensity
 * (scaleRecipe: linear, in slider units; 0 is the untouched photograph).
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { Progress } from './Progress';
import type { Photo } from '../lib/photoStore';
import type { Preset } from '../lib/preset/schema';
import type { PresetLibrary } from '../lib/preset/schema';
import { coverSource, queueThumb } from '../lib/preset/thumb';
import { analysePhoto, type ImageAnalysis } from '../lib/ai/imageAnalysis';
import { suggestIntensity, type IntensitySuggestion } from '../lib/ai/intensity';
import { generateOptions, type EnhanceOption } from '../lib/ai/enhance';

// ── Types ────────────────────────────────────────────────────────────────────

type EnhanceState =
  | { phase: 'idle' }
  | { phase: 'analysing' }
  | { phase: 'ready'; options: EnhanceOption[]; analysis: ImageAnalysis }
  | { phase: 'error'; message: string };

export type EnhancePanelProps = {
  photo: Photo | null;
  library: PresetLibrary | null;
  /** The look committed to the edit, if any. */
  activePresetId: string | null;
  /** Intensity of the committed look. */
  intensity: number;
  /** The look being previewed but not yet accepted, if any. */
  previewingId: string | null;
  /** Increments each time the toolbar's Enhance action is used. */
  enhanceRequest: number;
  onApply: (preset: Preset, label: string, intensity?: number) => void;
  onPreview: (preset: Preset, label: string, intensity?: number) => void;
  onIntensity: (value: number) => void;
};

// ── Main component ───────────────────────────────────────────────────────────

export function EnhancePanel({
  photo,
  library,
  activePresetId,
  intensity,
  previewingId,
  enhanceRequest,
  onApply,
  onPreview,
  onIntensity,
}: EnhancePanelProps) {
  const [state, setState] = useState<EnhanceState>({ phase: 'idle' });
  const photoUrl = photo?.url ?? null;
  const handledRequest = useRef(0);
  /** Guards against a slow analysis of a photograph that has since been replaced. */
  const runId = useRef(0);

  const run = useCallback(async (currentPhoto: Photo, currentLibrary: PresetLibrary) => {
    const id = ++runId.current;
    setState({ phase: 'analysing' });
    try {
      const analysis = await analysePhoto(currentPhoto);
      if (id !== runId.current) return;
      const options = generateOptions(currentLibrary, analysis);
      setState({ phase: 'ready', options, analysis });
    } catch (err) {
      if (id !== runId.current) return;
      setState({
        phase: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'The photograph could not be analysed. Try a different file.',
      });
    }
  }, []);

  /* Results belong to one photograph; a new file starts from the button again. */
  useEffect(() => {
    runId.current += 1;
    setState({ phase: 'idle' });
  }, [photoUrl]);

  /* The toolbar's Enhance action is the same request as pressing the button. */
  useEffect(() => {
    if (enhanceRequest === handledRequest.current) return;
    if (!photo || !library) return;
    handledRequest.current = enhanceRequest;
    void run(photo, library);
  }, [enhanceRequest, photo, library, run]);

  const appliedOption =
    state.phase === 'ready'
      ? (state.options.find((o) => o.preset.id === activePresetId) ?? null)
      : null;

  // ── No photo ──────────────────────────────────────────────────────────────

  if (!photo) {
    return (
      <div className="enhance__empty">
        <Icon name="image" size={20} />
        <p className="body-muted">
          Load a photograph, then ask for a recommendation. Three looks are suggested for it.
        </p>
      </div>
    );
  }

  // ── Idle: the explicit action ───────────────────────────────────────────

  if (state.phase === 'idle') {
    return (
      <div className="enhance enhance--idle">
        <Button
          variant="primary"
          size="md"
          iconLeft="sliders"
          onClick={() => library && void run(photo, library)}
          disabled={!library}
        >
          Enhance My Photo
        </Button>
        <p className="meta meta--micro enhance__note">
          Measures this photograph, then suggests three looks from the preset library. The
          suggestions come from fixed automated rules — not an AI model — and run entirely in
          your browser. Nothing changes until you accept one.
        </p>
      </div>
    );
  }

  // ── Analysing ─────────────────────────────────────────────────────────────

  if (state.phase === 'analysing') {
    return (
      <div className="looks__state" role="status">
        <Progress label="Analysing photograph" />
        <p className="body-muted">Measuring brightness, contrast and colour…</p>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────

  if (state.phase === 'error') {
    return (
      <div className="looks__state looks__state--bad" role="alert">
        <Icon name="close" size={16} />
        <p className="body-muted">{state.message}</p>
        <Button
          variant="ghost"
          size="sm"
          iconLeft="undo"
          onClick={() => library && void run(photo, library)}
        >
          Try again
        </Button>
      </div>
    );
  }

  // ── Ready ─────────────────────────────────────────────────────────────────

  const { options, analysis } = state;
  const appliedStart = appliedOption ? suggestIntensity(appliedOption.preset, analysis) : null;

  if (options.length === 0) {
    return (
      <div className="looks__state" role="status">
        <p className="body-muted">
          No usable presets were available to build suggestions from. Your photograph is
          unchanged.
        </p>
      </div>
    );
  }

  return (
    <div className="enhance">
      <div className="enhance__head">
        <p className="meta meta--micro enhance__label">
          <Icon name="sliders" size={12} />
          Automated rules · not an AI model
        </p>
        <Button
          variant="ghost"
          size="sm"
          iconLeft="undo"
          onClick={() => library && void run(photo, library)}
          title="Measure the photograph again"
        >
          Re-analyse
        </Button>
      </div>
      <p className="meta meta--micro enhance__measured">{analysis.summary}</p>

      <ul className="enhance__list" aria-label="Suggested looks">
        {options.map((option) => (
          <EnhanceCard
            key={option.kind}
            option={option}
            sourceUrl={photo.url}
            start={suggestIntensity(option.preset, analysis)}
            isApplied={activePresetId === option.preset.id && previewingId === null}
            isPreviewing={previewingId === option.preset.id}
            onApply={onApply}
            onPreview={onPreview}
          />
        ))}
      </ul>

      {/* Strength of a committed look. While previewing, the stage bar owns it. */}
      {appliedOption && previewingId === null && (
        <div className="enhance__intensity quick__row">
          <div className="quick__row-head">
            <label className="quick__label" htmlFor="enhance-intensity">
              Intensity — {appliedOption.label}
            </label>
            <span className={['quick__value', intensity !== 100 && 'is-moved'].filter(Boolean).join(' ')}>
              {intensity}%
            </span>
          </div>
          <input
            className="quick__slider"
            type="range"
            id="enhance-intensity"
            min={0}
            max={100}
            step={1}
            value={intensity}
            aria-valuetext={`${intensity}%`}
            title="Intensity — 0 is the photograph as it arrived, 100 is this look exactly as written."
            onChange={(e) => onIntensity(Number(e.target.value))}
          />
          <span className="meta meta--micro quick__hint">
            Scales the whole look. Your own manual turns on top of it stay.
            {appliedStart && appliedStart.value !== intensity && (
              <>
                {' '}
                The measurements for this photograph put a start at{' '}
                <button
                  type="button"
                  className="enhance__use-start"
                  onClick={() => onIntensity(appliedStart.value)}
                  title={appliedStart.reason}
                >
                  {appliedStart.value}%
                </button>
                .
              </>
            )}
          </span>
        </div>
      )}

      <p className="meta meta--micro enhance__footer">
        Each suggestion is a real preset, chosen by scoring it against measurements of this
        photograph. Preview changes only the stage; Apply is one undoable step.
      </p>
    </div>
  );
}

// ── Option card ──────────────────────────────────────────────────────────────

type EnhanceCardProps = {
  option: EnhanceOption;
  sourceUrl: string;
  /** Where the blend starts, from the measurements of this photograph. */
  start: IntensitySuggestion;
  isApplied: boolean;
  isPreviewing: boolean;
  onApply: (preset: Preset, label: string, intensity?: number) => void;
  onPreview: (preset: Preset, label: string, intensity?: number) => void;
};

const EnhanceCard = memo(function EnhanceCard({
  option,
  sourceUrl,
  start,
  isApplied,
  isPreviewing,
  onApply,
  onPreview,
}: EnhanceCardProps) {
  const { preset, label, explanation, changes } = option;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    const node = canvas.current;
    if (!node || !sourceUrl) return;
    let alive = true;
    setPainted(false);

    const watch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        watch.disconnect();
        coverSource(sourceUrl).then(
          (bitmap) => {
            if (!alive) return;
            queueThumb(node, bitmap, preset, sourceUrl, (ok) => {
              if (alive && ok) setPainted(true);
            });
          },
          () => { /* thumbnail unavailable — card still works */ },
        );
      },
      { rootMargin: '80px' },
    );
    watch.observe(node);
    return () => {
      alive = false;
      watch.disconnect();
    };
  }, [preset, sourceUrl]);

  const cardClass = [
    'enhance-card',
    isApplied && 'enhance-card--applied',
    isPreviewing && 'enhance-card--previewing',
  ].filter(Boolean).join(' ');

  return (
    <li className={cardClass} data-kind={option.kind}>
      <div className="enhance-card__thumb-wrap">
        <canvas ref={canvas} className="enhance-card__thumb" aria-hidden="true" />
        {!painted && <span className="pcard__veil" aria-hidden="true" />}
        <span className="enhance-card__kind">{label}</span>
      </div>

      <div className="enhance-card__body">
        <div className="enhance-card__head">
          <span className="enhance-card__name">{preset.name}</span>
          {isApplied && <span className="meta meta--micro ai-rec__applied-badge">Applied</span>}
          {isPreviewing && (
            <span className="meta meta--micro enhance-card__preview-badge">Previewing</span>
          )}
        </div>
        <p className="meta meta--micro enhance-card__reason">{explanation}</p>
        <p className="meta meta--micro enhance-card__changes">{changes}</p>
        <p className="meta meta--micro enhance-card__start" title={start.reason}>
          Starts at {start.value}% — {start.reason} The slider is yours after that.
        </p>
        <div className="enhance-card__actions">
          <Button
            variant="ghost"
            size="sm"
            iconLeft="eye"
            onClick={() => onPreview(preset, label, start.value)}
            title={`Preview ${preset.name} on the stage at ${start.value}% — your edit is not changed`}
          >
            Preview {start.value}%
          </Button>
          <Button
            variant={isApplied ? 'primary' : 'secondary'}
            size="sm"
            iconLeft="check"
            onClick={() => onApply(preset, label, start.value)}
            title={`Apply ${preset.name} at ${start.value}% — one undoable step`}
          >
            {isApplied ? 'Applied' : 'Apply'}
          </Button>
        </div>
      </div>
    </li>
  );
});
