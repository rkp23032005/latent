import { Button } from './Button';
import { Icon } from './Icon';
import type { Proposal } from '../lib/useProposal';

type ProposalBarProps = {
  proposal: Proposal;
  onIntensity: (value: number) => void;
  onAccept: () => void;
  onReject: () => void;
};

/**
 * The decision strip under the stage while a look is only being previewed.
 *
 * What is on the stage is the proposal; the real edit is untouched and comes
 * back the moment this is rejected. The stage's own Original / Split / Edited
 * control compares the proposal with the photograph as it arrived.
 */
export function ProposalBar({ proposal, onIntensity, onAccept, onReject }: ProposalBarProps) {
  const { preset, intensity, label } = proposal;
  return (
    <section className="proposal" aria-label="Previewing a suggested look">
      <div className="proposal__what">
        <p className="caps proposal__title">
          <Icon name="eye" size={13} />
          Previewing {label ? `${label} · ` : ''}
          {preset.name}
        </p>
        <p className="meta meta--micro proposal__note">
          Chosen by automated rules, not an AI model. Your current edit is unchanged — use
          Original or Split above to compare.
        </p>
      </div>

      <div className="proposal__strength">
        <label className="meta meta--micro" htmlFor="proposal-intensity">
          Intensity <span className="proposal__value">{intensity}%</span>
        </label>
        <input
          className="quick__slider"
          id="proposal-intensity"
          type="range"
          min={0}
          max={100}
          step={1}
          value={intensity}
          aria-valuetext={`${intensity}%`}
          onChange={(e) => onIntensity(Number(e.target.value))}
        />
      </div>

      <div className="proposal__actions">
        <Button variant="ghost" size="sm" iconLeft="close" onClick={onReject}>
          Reject
        </Button>
        <Button variant="primary" size="sm" iconLeft="check" onClick={onAccept}>
          Accept
        </Button>
      </div>
    </section>
  );
}
