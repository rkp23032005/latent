/**
 * The reference-photograph panel: "make mine look like that".
 *
 * One file picker, one measured answer, no imitation. The reference is reduced
 * to the 64×64 sample the rest of the app measures on and then put away — its
 * pixels are not blended, cloned or composited into anything, and it never
 * becomes a `Photo`, so it cannot reach the stage. What comes back is a ranking
 * of real catalogue looks by what the engine renders *this* photograph into,
 * plus, for the top couple, the supported knobs that close the rest.
 *
 * The wording is part of the feature. It says the reference is measured locally,
 * that a match is a distance rather than a verdict, and that tone and colour are
 * what the numbers hold — texture, subject and region edges are not, so the
 * closest look is not the reference. See `lib/ai/reference.ts` for the
 * measurement and `reference.test.ts` for how far it was checked.
 *
 * ## Known limits, as measured
 * - The yardstick is eleven tone and colour quantities read off a 64×64 sample.
 *   Texture, subject, framing and region edges are not in it, so a portrait and
 *   a landscape that share a palette will match, and a print that differs only
 *   in grain or in a face will not be describable here at all.
 * - The figures are averages. A look can rank first while losing on three of
 *   the eleven characteristics; the card names which ones it is still short of
 *   rather than pretending the distance is uniform.
 * - A reference that already reads alike costs nothing but returns nothing: the
 *   panel says so when no move closes the distance by the 0.15-step margin.
 * - One pass renders every usable look — 663 on the shipped catalogue — at
 *   about 0.9 ms each, so 0.9–1.4 s of work. It yields at task boundaries
 *   rather than on timers, which is why it finishes in a background tab where
 *   `setTimeout` would be throttled to seconds.
 * - The card thumbnails are queued on intersection, so a card that is never
 *   scrolled into view stays unpainted; that is the pre-existing thumb queue,
 *   not a fault of the ranking.
 * - Nothing here asks for a model or the network. Both files are read in this
 *   tab, and only the reference's eleven numbers leave `choose()`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { Progress } from './Progress';
import { coverSource, queueThumb } from '../lib/preset/thumb';
import { readSample, SAMPLE_SIZE, type ImageAnalysis } from '../lib/ai/imageAnalysis';
import { makeStyleSubject, matchToReference, referenceRecipe, type ReferenceResult } from '../lib/ai/reference';
import { styleSummary, readStyleRgba, type StyleRead } from '../lib/ai/styleRead';
import { suggestIntensity } from '../lib/ai/intensity';
import type { Adjustments } from '../lib/image/adjustments';
import { ACCEPT_ATTR, formatBytes, isAccepted, MAX_BYTES, type Photo } from '../lib/photoStore';
import type { Preset, PresetLibrary } from '../lib/preset/schema';

const LIMIT = 3;

type Reference = {
  readonly name: string;
  /** Only for the thumbnail the user can compare against — never for measurement. */
  readonly url: string;
  readonly read: StyleRead;
};

type Phase = 'idle' | 'reading' | 'matching' | 'ready' | 'error';

type ReferencePanelProps = {
  photo: Photo | null;
  library: PresetLibrary | null;
  /** The measurement of the photograph being edited, for the starting intensity. */
  analysis: ImageAnalysis | null;
  activePresetId: string | null;
  previewingId: string | null;
  onApply: (preset: Preset, intensity?: number) => void;
  onPreview: (preset: Preset, intensity?: number) => void;
  /** The look plus the confirmed turns, as one previewable whole edit. */
  onPreviewRecipe: (values: Adjustments, summary: string) => void;
};

/** The distance, in the units the measure is built from. */
function steps(gap: number): string {
  return gap < 0.05 ? 'a hair' : `${gap.toFixed(2)} steps`;
}

export function ReferencePanel({
  photo,
  library,
  analysis,
  activePresetId,
  previewingId,
  onApply,
  onPreview,
  onPreviewRecipe,
}: ReferencePanelProps) {
  const [reference, setReference] = useState<Reference | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<ReferenceResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  /* The sample of the user's own file is what every candidate is graded on; it
     belongs to the photograph, not to the reference, so it survives a change of
     reference and is thrown away when the file changes. */
  const subjectFor = useRef<{ url: string; subject: ReturnType<typeof makeStyleSubject> } | null>(null);
  const run = useRef(0);
  /* The reference's blob url exists for one thing: the thumbnail the user
     compares the edit against. It is revoked as soon as another takes its
     place, or when the panel unloads — tracked in a ref rather than in the
     state updater, which React may run twice. */
  const liveUrl = useRef<string | null>(null);

  const takeUrl = useCallback((next: string | null) => {
    if (liveUrl.current && liveUrl.current !== next) URL.revokeObjectURL(liveUrl.current);
    liveUrl.current = next;
  }, []);

  const clear = useCallback(() => {
    run.current += 1;
    takeUrl(null);
    setReference(null);
    setResult(null);
    setMessage(null);
    setPhase('idle');
  }, [takeUrl]);

  /* A panel that unloads with the mode tab should not keep a blob url alive. */
  useEffect(
    () => () => {
      run.current += 1;
      if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
      liveUrl.current = null;
    },
    [],
  );

  const subjectOf = useCallback(async (current: Photo) => {
    if (subjectFor.current?.url === current.url) return subjectFor.current.subject;
    const bytes = await readSample(current.file);
    const subject = makeStyleSubject(bytes, SAMPLE_SIZE, SAMPLE_SIZE);
    subjectFor.current = { url: current.url, subject };
    return subject;
  }, []);

  const match = useCallback(
    async (current: Photo, read: StyleRead) => {
      if (!library) return;
      const token = ++run.current;
      setPhase('matching');
      try {
        const subject = subjectFor.current?.url === current.url
          ? subjectFor.current.subject
          : await subjectOf(current);
        const next = await matchToReference(library, subject, read, { limit: LIMIT, turnLimit: 2 });
        if (token !== run.current) return;
        setResult(next);
        setPhase('ready');
      } catch (err) {
        if (token !== run.current) return;
        setPhase('error');
        setMessage(err instanceof Error ? err.message : 'The photograph could not be measured.');
      }
    },
    [library, subjectOf],
  );

  const choose = useCallback(
    async (file: File) => {
      if (!photo) {
        setMessage('Load the photograph you want to change first.');
        setPhase('error');
        return;
      }
      if (!library) return;
      /* The same files the editor reads, the same ceiling: one rule for both
         pickers, so a reference cannot be accepted here and refused on the stage. */
      if (!isAccepted(file)) {
        setMessage(`${file.name || 'That file'} is not a JPEG, PNG or WebP photograph.`);
        setPhase('error');
        return;
      }
      if (file.size > MAX_BYTES) {
        setMessage(`${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_BYTES)}.`);
        setPhase('error');
        return;
      }
      const token = ++run.current;
      setPhase('reading');
      setMessage(null);
      try {
        const bytes = await readSample(file);
        // Measuring the user's own file is part of "reading", not of matching.
        await subjectOf(photo);
        if (token !== run.current) return;
        const read = readStyleRgba(bytes, SAMPLE_SIZE * SAMPLE_SIZE);
        const url = URL.createObjectURL(file);
        takeUrl(url);
        setReference({ name: file.name, url, read });
        void match(photo, read);
      } catch {
        if (token !== run.current) return;
        setPhase('error');
        setMessage(`${file.name} could not be opened as a photograph.`);
      }
    },
    [library, photo, match, subjectOf, takeUrl],
  );

  /* A different photograph invalidates the subject; the reference itself stays,
     because the print someone liked does not stop being the print they liked. */
  useEffect(() => {
    if (!photo || !reference) return;
    if (subjectFor.current?.url === photo.url) return;
    void match(photo, reference.read);
  }, [photo, reference, match]);

  const busy = phase === 'reading' || phase === 'matching';

  return (
    <section className="reference" aria-labelledby="reference-title">
      <div className="enhance__section-head">
        <Icon name="image" size={14} />
        <span className="caps enhance__section-title" id="reference-title">
          Match a Reference Photograph
        </span>
        {reference && (
          <button type="button" className="caps reference__clear" onClick={clear}>
            Remove
          </button>
        )}
      </div>

      <input
        ref={input}
        type="file"
        accept={ACCEPT_ATTR}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so choosing the same file again still fires a change.
          event.target.value = '';
          if (file) void choose(file);
        }}
        aria-label="Choose a reference photograph"
      />

      {!reference && (
        <>
          <p className="meta meta--micro reference__hint">
            Choose a print you like and the editor measures what it does — overall level, tonal
            spread, the warm–cool and green–magenta balance, colour intensity, palette breadth and
            both ends of the tone scale — then renders your photograph with every usable look in
            the catalogue and ranks them by how near the reference each one lands.
          </p>
          <p className="meta meta--micro reference__hint">
            Measured on this device. Nothing is uploaded, and none of the reference&rsquo;s pixels
            are copied into your edit.
          </p>
          <Button variant="secondary" size="sm" iconLeft="upload" onClick={() => input.current?.click()}>
            Choose a reference
          </Button>
        </>
      )}

      {reference && (
        <div className="reference__strip">
          <img className="reference__thumb" src={reference.url} alt={`Reference: ${reference.name}`} />
          <div className="reference__read">
            <p className="meta meta--micro reference__name">{reference.name}</p>
            <p className="reference__summary">{styleSummary(reference.read)}</p>
            <Button variant="ghost" size="sm" iconLeft="upload" onClick={() => input.current?.click()}>
              Choose another
            </Button>
          </div>
        </div>
      )}

      {phase === 'error' && message && (
        <p className="looks__state looks__state--bad" role="alert">
          {message}
        </p>
      )}

      {busy && (
        <div className="looks__state" role="status">
          <Progress label="Measuring the reference" />
          <p className="body-muted">
            {phase === 'reading'
              ? 'Reading the reference…'
              : 'Rendering your photograph with every usable look in the catalogue…'}
          </p>
        </div>
      )}

      {phase === 'ready' && result && !result.useful && !result.alreadyAlike && (
        <p className="looks__state" role="status">
          Nothing here is worth applying: the nearest look renders your photograph{' '}
          {result.matches[0].gap.toFixed(2)} steps from the reference against{' '}
          {result.before.toFixed(2)} for the file as it stands, so no move closes the distance by
          even 0.15 of a step. That is a result, not a failure — the difference between two
          photographs is mostly texture, subject and region edges, which these knobs do not reach.
        </p>
      )}

      {phase === 'ready' && result && !result.useful && result.alreadyAlike && (
        <p className="looks__state" role="status">
          These two already read alike on everything this engine can change —{' '}
          {result.before.toFixed(2)} steps apart. Nothing needs doing, and a look would only move
          one of them away from the other.
        </p>
      )}

      {phase === 'ready' && result && result.useful && (
        <>
          <ul className="ai-assistant__recs reference__list" aria-label="Closest looks">
            {result.matches.map((match) => (
              <ReferenceCard
                key={match.preset.id}
                match={match}
                photo={photo}
                start={suggestIntensity(match.preset, analysis).value}
                isApplied={activePresetId === match.preset.id && previewingId === null}
                isPreviewing={previewingId === match.preset.id}
                onApply={onApply}
                onPreview={onPreview}
                onPreviewRecipe={onPreviewRecipe}
              />
            ))}
          </ul>
          <p className="meta meta--micro ai-assistant__footer">
            Ranked by measurement, not by taste: {result.measured} usable looks were each rendered
            onto your photograph at 64×64 and read back on the same eleven characteristics as the
            reference. A step is one clear change in one characteristic, and the figure on a card is
            the average across all eleven — {result.before.toFixed(2)} with nothing applied,{' '}
            {result.matches[0].gap.toFixed(2)} with this look on. The reference is never copied in:
            a print&rsquo;s texture and subject are not in these numbers, so the nearest look is not
            the reference. Preview changes only the stage; Apply puts the look on as one undoable
            step.
          </p>
        </>
      )}
    </section>
  );
}

type CardProps = {
  match: ReferenceResult['matches'][number];
  photo: Photo | null;
  start: number;
  isApplied: boolean;
  isPreviewing: boolean;
  onApply: (preset: Preset, intensity?: number) => void;
  onPreview: (preset: Preset, intensity?: number) => void;
  onPreviewRecipe: (values: Adjustments, summary: string) => void;
};

function ReferenceCard({
  match,
  photo,
  start,
  isApplied,
  isPreviewing,
  onApply,
  onPreview,
  onPreviewRecipe,
}: CardProps) {
  const { preset, gap, gaps, turns, turnsGap } = match;
  /* One recipe for the whole card: the same numbers the thumbnail is painted
     with, the slider positions the line names, and the preview hands over. */
  const recipe = useMemo(() => referenceRecipe(match), [match]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);

  /* The card is the look on the user's own file, painted by the same CPU
     renderer as every other card — including the turns, so what is offered is
     what the card shows rather than an approximation of it. */
  useEffect(() => {
    const node = canvas.current;
    if (!node || !photo) return;
    let alive = true;
    const watch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        watch.disconnect();
        void coverSource(photo.url).then(
          (bitmap) => {
            if (!alive) return;
            const shown = turns.length > 0 ? { ...preset, adjust: recipe } : preset;
            queueThumb(node, bitmap, shown, photo.url, (ok) => {
              if (alive && ok) setPainted(true);
            });
          },
          () => {
            /* No pixels, no card image: the text below still stands. */
          },
        );
      },
      { rootMargin: '120px' },
    );
    watch.observe(node);
    return () => {
      alive = false;
      watch.disconnect();
    };
  }, [preset, photo, recipe, turns.length]);

  const summary =
    turns.length > 0
      ? `${preset.name} with ${turns.map((turn) => `${turn.label} ${turn.deltaText}`).join(', ')}`
      : preset.name;

  return (
    <li
      className={['ai-rec', isApplied && 'ai-rec--applied', isPreviewing && 'ai-rec--previewing']
        .filter(Boolean)
        .join(' ')}
    >
      <div className="ai-rec__thumb-wrap">
        <canvas ref={canvas} className="ai-rec__thumb" aria-hidden="true" />
        {!painted && <span className="pcard__veil" aria-hidden="true" />}
      </div>
      <div className="ai-rec__body">
        <div className="ai-rec__head">
          <span className="ai-rec__name">{preset.name}</span>
          <span className="meta meta--micro ai-rec__cat">
            {isApplied ? (
              <span className="ai-rec__applied-badge">Applied</span>
            ) : isPreviewing ? (
              <span className="ai-rec__applied-badge">Previewing</span>
            ) : (
              preset.category
            )}
          </span>
        </div>
        <p className="meta meta--micro ai-rec__basis">
          <span className="tag">Measured render</span>
          <span className="ai-rec__traits">{steps(gap)} from the reference</span>
        </p>
        {gaps.length > 0 && (
          <p className="meta meta--micro ai-rec__reason">
            Still short of the reference: {gaps.map((entry) => entry.label).join('; ')}.
          </p>
        )}
        <div className="ai-rec__actions">
          <Button
            variant="ghost"
            size="sm"
            iconLeft="eye"
            onClick={() => onPreview(preset, start)}
            title={`Preview ${preset.name} on the stage at ${start}% — your edit is not changed`}
          >
            Preview {start}%
          </Button>
          <Button
            variant={isApplied ? 'primary' : 'secondary'}
            size="sm"
            iconLeft="check"
            onClick={() => onApply(preset, start)}
            title={`Apply ${preset.name} at ${start}% — one undoable step`}
          >
            {isApplied ? 'Applied' : 'Apply'}
          </Button>
        </div>
        {turns.length > 0 && (
          <p className="meta meta--micro reference__turns">
            <Icon name="sliders" size={12} />
            {turns
              .map((turn) => {
                /* The slider position is only worth naming when it is not the
                   move itself — that is, when the look already had a value. */
                const landed = recipe[turn.id];
                return `${turn.label} ${turn.deltaText}${landed === turn.delta ? '' : ` (to ${turn.valueText})`}`;
              })
              .join(' · ')}{' '}
            closes it to {steps(turnsGap ?? 0)} from the reference.{' '}
            <button
              type="button"
              className="caps reference__turns-preview"
              onClick={() => onPreviewRecipe(recipe, summary)}
              title={`Preview ${summary} on the stage — your edit is not changed`}
            >
              Preview the whole thing
            </button>
          </p>
        )}
      </div>
    </li>
  );
}
