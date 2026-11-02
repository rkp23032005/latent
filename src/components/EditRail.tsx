import { memo, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { formatBytes, type Photo } from '../lib/photoStore';
import {
  CONTROLS,
  IDENTITY,
  type AdjustmentId,
  type Adjustments,
  type Control,
} from '../lib/image/adjustments';

type ModeId = 'quick' | 'advanced';

/* Two panels, one rail, and never both at once: the seven knobs everyone needs
   stay in Quick Edit, and the nine that ask a question about the print live one
   tap away. Nothing here is a control that does nothing — every entry is a
   stage the engine runs. */
const MODES: ReadonlyArray<{
  readonly id: ModeId;
  readonly label: string;
  readonly note: string;
  readonly sections: ReadonlyArray<{ readonly group: Control['group']; readonly label: string }>;
}> = [
  {
    id: 'quick',
    label: 'Quick Edit',
    note: 'The light and the print. Enough for most photographs.',
    sections: [
      { group: 'light', label: 'Light' },
      { group: 'print', label: 'Print' },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced Edit',
    note: 'Parts of the tone scale, the colour axes, and the film itself.',
    sections: [
      { group: 'zone', label: 'Tone zones' },
      { group: 'colour', label: 'Colour' },
      { group: 'effect', label: 'Film' },
    ],
  },
];

type EditRailProps = {
  photo: Photo | null;
  values: Adjustments;
  dirty: boolean;
  /** A look is on the photograph, so a knob has somewhere else to go home to. */
  hasLook: boolean;
  onChange: (id: AdjustmentId, value: number) => void;
  onResetKnob: (id: AdjustmentId) => void;
  onReset: () => void;
};

/**
 * The knob rail, in one of two modes.
 *
 * Each control writes to the editing state only; the stage re-renders from the
 * original photograph plus that state, so the file itself is never modified and
 * Reset returns it exactly as it arrived.
 */
export function EditRail({
  photo,
  values,
  dirty,
  hasLook,
  onChange,
  onResetKnob,
  onReset,
}: EditRailProps) {
  const [mode, setMode] = useState<ModeId>('quick');
  const active = MODES.find((entry) => entry.id === mode) ?? MODES[0];

  return (
    <aside className="rail rail--quick" aria-labelledby="rail-title">
      <div className="rail__head">
        <h2 className="caps rail__head-title" id="rail-title">
          {active.label}
        </h2>
        {dirty ? (
          <Button variant="ghost" size="sm" onClick={onReset} iconLeft="undo" title="Restore the original appearance">
            Reset
          </Button>
        ) : (
          <span className="tag">Original</span>
        )}
      </div>

      <div className="rail__modes" role="group" aria-label="Editing mode">
        {MODES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={['caps', 'mode__tab', entry.id === mode && 'is-active'].filter(Boolean).join(' ')}
            aria-pressed={entry.id === mode}
            onClick={() => setMode(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <dl className="quick__facts">
        <div className="quick__fact">
          <dt className="meta meta--micro">File</dt>
          <dd className="quick__fact-value" title={photo?.name}>
            {photo?.name ?? '—'}
          </dd>
        </div>
        <div className="quick__fact">
          <dt className="meta meta--micro">Pixels</dt>
          <dd className="quick__fact-value">
            {photo ? `${photo.width} × ${photo.height}` : '—'}
          </dd>
        </div>
        <div className="quick__fact">
          <dt className="meta meta--micro">Weight</dt>
          <dd className="quick__fact-value">{photo ? formatBytes(photo.bytes) : '—'}</dd>
        </div>
        <div className="quick__fact">
          <dt className="meta meta--micro">Framing</dt>
          <dd className="quick__fact-value">{photo ? photo.orientation : '—'}</dd>
        </div>
      </dl>

      {active.sections.map(({ group, label }, index) => (
        <section className="quick__section" key={group} aria-label={label}>
          {index > 0 && <hr className="rule" />}
          <h3 className="caps quick__section-title">{label}</h3>
          <ul className="quick__list">
            {CONTROLS.filter((control) => control.group === group).map((control) => (
              <SliderRow
                key={control.id}
                control={control}
                value={values[control.id]}
                disabled={!photo}
                home={hasLook ? 'the look' : '0'}
                onChange={onChange}
                onHome={onResetKnob}
              />
            ))}
          </ul>
        </section>
      ))}

      <p className="rail__note" id="quick-status">
        <Icon name="sliders" size={14} /> {active.note} The stage redraws from the original every
        time a knob moves: {photo ? 'these values are a recipe, not an edit to your file.' : 'load a photograph to start editing.'}
      </p>

      <p className="meta meta--micro quick__original">
        Original kept untouched · {photo ? 'read from this device' : 'no file loaded'}
      </p>
    </aside>
  );
}

type SliderRowProps = {
  control: Control;
  value: number;
  disabled: boolean;
  /** What double-click returns this knob to, in the words the user would use. */
  home: string;
  onChange: (id: AdjustmentId, value: number) => void;
  onHome: (id: AdjustmentId) => void;
};

const SliderRow = memo(function SliderRow({
  control,
  value,
  disabled,
  home,
  onChange,
  onHome,
}: SliderRowProps) {
  const moved = value !== IDENTITY[control.id];
  return (
    <li className="quick__row">
      <div className="quick__row-head">
        <label className="quick__label" htmlFor={`adjust-${control.id}`}>
          {control.label}
        </label>
        <span className={['quick__value', moved && 'is-moved'].filter(Boolean).join(' ')}>
          {control.format(value)}
        </span>
      </div>
      <input
        className="quick__slider"
        type="range"
        id={`adjust-${control.id}`}
        min={control.min}
        max={control.max}
        step={control.step}
        value={value}
        disabled={disabled}
        aria-describedby={`adjust-${control.id}-hint`}
        aria-valuetext={control.format(value)}
        aria-keyshortcuts="Enter"
        title={`${control.label} — ${control.hint}. Double-click or press Enter to return to ${home}.`}
        onChange={(e) => onChange(control.id, Number(e.target.value))}
        onDoubleClick={() => onHome(control.id)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          onHome(control.id);
        }}
      />
      <span className="meta meta--micro quick__hint" id={`adjust-${control.id}-hint`}>
        {control.hint}
      </span>
    </li>
  );
});
