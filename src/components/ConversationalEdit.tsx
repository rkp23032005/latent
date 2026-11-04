/**
 * Conversational editing interface.
 *
 * Sits inside the AI Edit panel. The user types a natural-language request;
 * the local rule-based parser converts it to a validated instruction; the
 * result is shown as a proposal the user can preview, accept or reject.
 *
 * ## What this does
 * - Accepts free-text requests and passes them to nlParser.
 * - Folds the parsed deltas into the edit as it already stands, so "make it
 *   brighter" lifts the current photograph rather than replacing the look on it.
 * - Shows every knob it is about to move, with the reading before and after,
 *   in the same words and ranges the Manual Edit rail uses.
 * - For preset families: previews the real preset the assistant measured for
 *   that family, or says why there is not one yet.
 * - For ambiguous requests: shows two or three named options to choose from.
 * - For unsupported requests: explains the limitation and suggests an alternative.
 * - Keeps a short history of the session's exchanges.
 * - Never executes arbitrary code; never invents controls or presets.
 *
 * ## Privacy
 * Everything runs locally in the browser. No text and no photograph is sent
 * anywhere, so there is nothing to consent to and no key to keep secret.
 */

import { useCallback, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import {
  movingKnobs,
  parseNlRequest,
  resolveDeltas,
  resolvedToAdjustments,
  type AmbiguityOption,
  type ParsedInstruction,
  type ResolvedKnob,
} from '../lib/ai/nlParser';
import type { Adjustments } from '../lib/image/adjustments';
import type { Preset } from '../lib/preset/schema';

import type { EnhanceOption } from '../lib/ai/enhance';

// ── Types ────────────────────────────────────────────────────────────────────

type Exchange = {
  readonly id: string;
  readonly userText: string;
  readonly instruction: ParsedInstruction;
  /** Where each requested knob stands and would stand, against the live edit. */
  readonly knobs: readonly ResolvedKnob[];
  /** True once the user has accepted this exchange's proposal. */
  readonly accepted: boolean;
  /** The interpretation chosen for an ambiguous request, once picked. */
  readonly chosenOptionId: string | null;
  /** A look was asked for but the photograph has not been measured yet. */
  readonly noPresetAvailable: boolean;
};

export type ConversationalEditProps = {
  /** The three enhance options (Natural / Cinematic / Creative) for preset lookups. */
  enhanceOptions: readonly EnhanceOption[];
  /** The knobs as they read right now: applied look plus any hand turns. */
  currentAdjustments: Adjustments;
  /** Called when the user wants to preview an adjustment-based proposal. */
  onPreviewAdjustments: (adjustments: Partial<Adjustments>, summary: string) => void;
  /** Called when the user wants to preview a preset-family option. */
  onPreviewPreset: (preset: Preset, label: string) => void;
  /** Called when the user accepts the current proposal. */
  onAccept: () => void;
  /** Called when the user rejects the current proposal. */
  onReject: () => void;
  /** True when a proposal is currently being previewed on the stage. */
  isPreviewing: boolean;
  /** Whether a photo is loaded. */
  hasPhoto: boolean;
};

// ── Quick-access chips ────────────────────────────────────────────────────────

const COMMAND_CHIPS = [
  'Make it brighter',
  'Warmer colours',
  'More contrast',
  'Less saturated',
  'Cinematic look',
  'Faded film',
  'Moody',
  'Black and white',
] as const;

// ── Component ─────────────────────────────────────────────────────────────────

export function ConversationalEdit({
  enhanceOptions,
  currentAdjustments,
  onPreviewAdjustments,
  onPreviewPreset,
  onAccept,
  onReject,
  isPreviewing,
  hasPhoto,
}: ConversationalEditProps) {
  const [input, setInput] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idCounter = useRef(0);

  const nextId = useCallback(() => String(++idCounter.current), []);

  /** Preview a look, or report that the photograph has not been measured yet. */
  const previewFamily = useCallback(
    (family: 'natural' | 'cinematic' | 'creative') => {
      const option = enhanceOptions.find((o) => o.kind === family);
      if (!option) return null;
      onPreviewPreset(option.preset, option.label);
      return option;
    },
    [enhanceOptions, onPreviewPreset],
  );

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !hasPhoto) return;

      const instruction = parseNlRequest(trimmed);
      const id = nextId();
      let knobs: readonly ResolvedKnob[] = [];
      let noPresetAvailable = false;
      let previewed = false;

      if (instruction.kind === 'adjustments') {
        knobs = resolveDeltas(currentAdjustments, instruction.deltas);
        if (movingKnobs(knobs).length > 0) {
          onPreviewAdjustments(resolvedToAdjustments(knobs), instruction.summary);
          previewed = true;
        }
      } else if (instruction.kind === 'preset') {
        noPresetAvailable = previewFamily(instruction.presetFamily) === null;
        previewed = !noPresetAvailable;
      }

      setExchanges((prev) => [
        ...prev.slice(-9), // keep the last ten exchanges
        { id, userText: trimmed, instruction, knobs, accepted: false, chosenOptionId: null, noPresetAvailable },
      ]);
      setInput('');
      // Only a proposal that reached the stage can be accepted or rejected.
      setPendingId(previewed ? id : null);
    },
    [hasPhoto, currentAdjustments, onPreviewAdjustments, previewFamily, nextId],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submit(input);
    },
    [input, submit],
  );

  const handleChip = useCallback(
    (chip: string) => {
      setInput(chip);
      submit(chip);
      inputRef.current?.focus();
    },
    [submit],
  );

  const handleAmbiguityChoice = useCallback(
    (exchange: Exchange, option: AmbiguityOption) => {
      let knobs: readonly ResolvedKnob[] = [];
      let noPresetAvailable = false;
      let previewed = false;

      if (option.presetFamily) {
        noPresetAvailable = previewFamily(option.presetFamily) === null;
        previewed = !noPresetAvailable;
      } else {
        knobs = resolveDeltas(currentAdjustments, option.deltas);
        if (movingKnobs(knobs).length > 0) {
          onPreviewAdjustments(resolvedToAdjustments(knobs), option.label);
          previewed = true;
        }
      }

      if (!previewed) {
        setExchanges((prev) =>
          prev.map((ex) => (ex.id === exchange.id ? { ...ex, noPresetAvailable } : ex)),
        );
        return;
      }

      setExchanges((prev) =>
        prev.map((ex) =>
          ex.id === exchange.id
            ? { ...ex, knobs, chosenOptionId: option.id, noPresetAvailable: false }
            : ex,
        ),
      );
      setPendingId(exchange.id);
    },
    [currentAdjustments, onPreviewAdjustments, previewFamily],
  );

  const handleAccept = useCallback(() => {
    if (pendingId) {
      setExchanges((prev) =>
        prev.map((ex) => (ex.id === pendingId ? { ...ex, accepted: true } : ex)),
      );
    }
    setPendingId(null);
    onAccept();
  }, [pendingId, onAccept]);

  const handleReject = useCallback(() => {
    setPendingId(null);
    onReject();
  }, [onReject]);

  const clearHistory = useCallback(() => {
    setExchanges([]);
    setPendingId(null);
    onReject();
  }, [onReject]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="conv-edit" aria-label="Conversational editing">
      {/* Input form */}
      <form className="conv-edit__form" onSubmit={handleSubmit} aria-label="Describe an edit">
        <label className="conv-edit__label" htmlFor="conv-edit-input">
          <Icon name="sliders" size={12} />
          <span>Describe an edit</span>
        </label>
        <div className="conv-edit__row">
          <input
            ref={inputRef}
            id="conv-edit-input"
            className="conv-edit__input"
            type="text"
            value={input}
            placeholder={hasPhoto ? 'e.g. make it brighter, warmer colours…' : 'Load a photo first'}
            disabled={!hasPhoto}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Describe the edit you want"
            autoComplete="off"
          />
          <Button
            variant="secondary"
            size="sm"
            type="submit"
            disabled={!hasPhoto || !input.trim()}
          >
            Apply
          </Button>
        </div>
      </form>

      {/* Quick-access chips */}
      {hasPhoto && (
        <div className="conv-edit__chips" role="group" aria-label="Quick edit commands">
          {COMMAND_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              className="chip"
              onClick={() => handleChip(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      {/* Exchange history */}
      {exchanges.length > 0 && (
        <div className="conv-edit__history" aria-label="Edit history" aria-live="polite">
          {exchanges.map((ex) => (
            <ExchangeItem
              key={ex.id}
              exchange={ex}
              isPending={ex.id === pendingId}
              isPreviewing={isPreviewing && ex.id === pendingId}
              onAmbiguityChoice={handleAmbiguityChoice}
              onAccept={handleAccept}
              onReject={handleReject}
            />
          ))}
        </div>
      )}

      {/* Clear history */}
      {exchanges.length > 2 && (
        <button
          type="button"
          className="conv-edit__clear"
          onClick={clearHistory}
          aria-label="Clear edit history"
        >
          Clear history
        </button>
      )}

      <p className="meta meta--micro conv-edit__note">
        Commands are read on this device — no text and no photograph is sent anywhere. Every
        change goes through the same engine as the manual controls and lands on top of your
        current edit. Preview before accepting; Undo is always available.
      </p>
    </div>
  );
}

// ── Exchange item ─────────────────────────────────────────────────────────────

type ExchangeItemProps = {
  exchange: Exchange;
  isPending: boolean;
  isPreviewing: boolean;
  onAmbiguityChoice: (exchange: Exchange, option: AmbiguityOption) => void;
  onAccept: () => void;
  onReject: () => void;
};

function ExchangeItem({
  exchange,
  isPending,
  isPreviewing,
  onAmbiguityChoice,
  onAccept,
  onReject,
}: ExchangeItemProps) {
  const { userText, instruction, accepted } = exchange;

  return (
    <div
      className={[
        'conv-item',
        accepted && 'conv-item--accepted',
        isPending && !accepted && 'conv-item--pending',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* User's request */}
      <p className="conv-item__user">
        <Icon name="sliders" size={11} />
        <span>{userText}</span>
      </p>

      {/* Parser response */}
      <div className="conv-item__response">
        {instruction.kind === 'adjustments' && (
          <AdjustmentResponse
            exchange={exchange}
            instruction={instruction}
            isPending={isPending}
            isPreviewing={isPreviewing}
            accepted={accepted}
            onAccept={onAccept}
            onReject={onReject}
          />
        )}

        {instruction.kind === 'preset' && (
          <PresetResponse
            exchange={exchange}
            instruction={instruction}
            isPending={isPending}
            isPreviewing={isPreviewing}
            accepted={accepted}
            onAccept={onAccept}
            onReject={onReject}
          />
        )}

        {instruction.kind === 'ambiguous' && (
          <AmbiguousResponse
            exchange={exchange}
            instruction={instruction}
            isPreviewing={isPreviewing}
            onAccept={onAccept}
            onReject={onReject}
            onChoice={(option) => onAmbiguityChoice(exchange, option)}
          />
        )}

        {instruction.kind === 'unsupported' && <UnsupportedResponse instruction={instruction} />}
      </div>
    </div>
  );
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

/** The knobs a proposal moves, in the Manual Edit rail's own words and ranges. */
function KnobList({ knobs }: { knobs: readonly ResolvedKnob[] }) {
  if (knobs.length === 0) return null;
  return (
    <ul className="conv-response__deltas" aria-label="Knob changes">
      {knobs.map((k) => (
        <li key={k.id} className="conv-response__delta">
          <span className="conv-response__delta-label">{k.label}</span>
          <span className="conv-response__delta-value">
            {k.beforeText !== k.afterText ? `${k.beforeText} → ` : ''}
            {k.afterText}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Caveat({ text }: { text: string }) {
  return <p className="meta meta--micro conv-response__caveat">{text}</p>;
}

/** Accept / reject while the proposal is on the stage and not yet committed. */
function ProposalActions({
  isPreviewing,
  onAccept,
  onReject,
}: {
  isPreviewing: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  if (!isPreviewing) {
    return <span className="meta meta--micro conv-response__previewing">Replaced by a later request.</span>;
  }
  return (
    <div className="conv-response__actions">
      <Button variant="ghost" size="sm" iconLeft="close" onClick={onReject}>
        Reject
      </Button>
      <Button variant="primary" size="sm" iconLeft="check" onClick={onAccept}>
        Accept
      </Button>
    </div>
  );
}

function AppliedNote() {
  return (
    <p className="meta meta--micro conv-response__accepted">
      <Icon name="check" size={11} /> Applied — keep editing by hand, or Undo to step back
    </p>
  );
}

// ── Response sub-components ───────────────────────────────────────────────────

type AdjustmentResponseProps = {
  exchange: Exchange;
  instruction: ParsedInstruction & { kind: 'adjustments' };
  isPending: boolean;
  isPreviewing: boolean;
  accepted: boolean;
  onAccept: () => void;
  onReject: () => void;
};

function AdjustmentResponse({
  exchange,
  instruction,
  isPending,
  isPreviewing,
  accepted,
  onAccept,
  onReject,
}: AdjustmentResponseProps) {
  const nothingMoves = movingKnobs(exchange.knobs).length === 0;

  return (
    <div className="conv-response conv-response--adjustments">
      <p className="conv-response__summary">{instruction.summary}</p>
      <KnobList knobs={exchange.knobs} />
      {instruction.caveat && <Caveat text={instruction.caveat} />}
      {nothingMoves && !accepted && (
        <p className="meta meta--micro conv-response__note">
          These knobs are already where that request would put them, so nothing changes. Turn
          them yourself in Manual Edit, or ask for a bigger move.
        </p>
      )}
      {isPending && !accepted && !nothingMoves && (
        <ProposalActions isPreviewing={isPreviewing} onAccept={onAccept} onReject={onReject} />
      )}
      {accepted && <AppliedNote />}
    </div>
  );
}

type PresetResponseProps = {
  exchange: Exchange;
  instruction: ParsedInstruction & { kind: 'preset' };
  isPending: boolean;
  isPreviewing: boolean;
  accepted: boolean;
  onAccept: () => void;
  onReject: () => void;
};

function PresetResponse({
  exchange,
  instruction,
  isPending,
  isPreviewing,
  accepted,
  onAccept,
  onReject,
}: PresetResponseProps) {
  return (
    <div className="conv-response conv-response--preset">
      <p className="conv-response__summary">{instruction.summary}</p>
      {instruction.caveat && <Caveat text={instruction.caveat} />}
      {exchange.noPresetAvailable ? (
        <p className="meta meta--micro conv-response__note">
          This look is chosen from the presets in your library, matched to how this photograph
          measures. It is not ready yet — once the measurement finishes, ask again. Nothing has
          been changed on your photograph in the meantime.
        </p>
      ) : (
        <p className="meta meta--micro conv-response__note">
          A real preset from the library, picked for how this photograph measures. Accepting it
          sets this look as the new starting point; Undo brings back what was there before.
        </p>
      )}
      {isPending && !accepted && !exchange.noPresetAvailable && (
        <ProposalActions isPreviewing={isPreviewing} onAccept={onAccept} onReject={onReject} />
      )}
      {accepted && <AppliedNote />}
    </div>
  );
}

type AmbiguousResponseProps = {
  exchange: Exchange;
  instruction: ParsedInstruction & { kind: 'ambiguous' };
  /** This exchange's choice is the proposal on the stage. */
  isPreviewing: boolean;
  onAccept: () => void;
  onReject: () => void;
  onChoice: (option: AmbiguityOption) => void;
};

function AmbiguousResponse({
  exchange,
  instruction,
  isPreviewing,
  onAccept,
  onReject,
  onChoice,
}: AmbiguousResponseProps) {
  const chosen = instruction.options.find((o) => o.id === exchange.chosenOptionId);

  return (
    <div className="conv-response conv-response--ambiguous">
      <p className="conv-response__summary">{instruction.summary}</p>
      <div className="conv-response__options" role="group" aria-label="Choose an interpretation">
        {instruction.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={['conv-option', exchange.chosenOptionId === opt.id && 'is-chosen'].filter(Boolean).join(' ')}
            aria-pressed={exchange.chosenOptionId === opt.id}
            onClick={() => onChoice(opt)}
          >
            <span className="conv-option__label">{opt.label}</span>
            <span className="conv-option__desc">{opt.description}</span>
          </button>
        ))}
      </div>
      {exchange.noPresetAvailable && (
        <p className="meta meta--micro conv-response__note">
          That one is a preset from your library, and the measurement of this photograph is not
          ready yet. Pick another, or ask again in a moment.
        </p>
      )}
      {chosen && !exchange.noPresetAvailable && <KnobList knobs={exchange.knobs} />}
      {chosen && exchange.knobs.length === 0 && !exchange.noPresetAvailable && (
        <p className="meta meta--micro conv-response__note">
          Previewing “{chosen.label}” on the stage. Accept to keep it, Reject to leave your edit
          as it was.
        </p>
      )}
      {chosen && !exchange.noPresetAvailable && !exchange.accepted && (
        <ProposalActions isPreviewing={isPreviewing} onAccept={onAccept} onReject={onReject} />
      )}
      {exchange.accepted && <AppliedNote />}
    </div>
  );
}

type UnsupportedResponseProps = {
  instruction: ParsedInstruction & { kind: 'unsupported' };
};

function UnsupportedResponse({ instruction }: UnsupportedResponseProps) {
  return (
    <div className="conv-response conv-response--unsupported">
      <p className="conv-response__summary">
        <Icon name="close" size={12} />
        {instruction.summary}
      </p>
      {instruction.suggestion && (
        <p className="meta meta--micro conv-response__suggestion">{instruction.suggestion}</p>
      )}
    </div>
  );
}
