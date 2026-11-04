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

/**
 * Manual Edit rail — three always-visible sections (Light, Colour, Effects)
 * plus a collapsible Advanced section (Tone zones + Print effects).
 *
 * Every control here maps to a real pipeline stage. Nothing is decorative.
 * The engine does not support sharpening, so it is not exposed.
 *
 * Section mapping:
 *   Light   — exposure, brightness, contrast, warmth, saturation  (group: light)
 *   Colour  — temperature, tint, vibrance                         (group: colour)
 *   Effects — vignette, grain                                     (group: effect)
 *   Advanced (collapsed by default):
 *     Tone zones — highlights, shadows, whites, blacks            (group: zone)
 *     Print      — fade, toning                                   (group: print)
 *
 * The Colour section carries one more control: the skin guard. It is not a knob
 * on the engine's sixteen — no preset sets it and no recipe contains it — so it
 * has its own row and its own place in the session. See `lib/image/skinGuard.ts`
 * for what it does to a pixel and what it cannot claim about a face.
 */

type EditRailProps = {
  photo: Photo | null;
  values: Adjustments;
  dirty: boolean;
  /** A look is on the photograph, so a knob has somewhere else to go home to. */
  hasLook: boolean;
  /** Skin tone protection, 0–100. Not one of the sixteen: see `skinGuard.ts`. */
  skinGuard: number;
  onChange: (id: AdjustmentId, value: number) => void;
  onResetKnob: (id: AdjustmentId) => void;
  onSkinGuard: (value: number) => void;
  onReset: () => void;
};

type SectionDef = {
  readonly group: Control['group'];
  readonly label: string;
};

const PRIMARY_SECTIONS: readonly SectionDef[] = [
  { group: 'light', label: 'Light' },
  { group: 'colour', label: 'Colour' },
  { group: 'effect', label: 'Effects' },
];

const ADVANCED_SECTIONS: readonly SectionDef[] = [
  { group: 'zone', label: 'Tone zones' },
  { group: 'print', label: 'Print' },
];

export function EditRail({
  photo,
  values,
  dirty,
  hasLook,
  skinGuard,
  onChange,
  onResetKnob,
  onSkinGuard,
  onReset,
}: EditRailProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <aside className="rail rail--quick" aria-labelledby="rail-title">
      <div className="rail__head">
        <h2 className="caps rail__head-title" id="rail-title">
          Manual Edit
        </h2>
        {dirty ? (
          <Button variant="ghost" size="sm" onClick={onReset} iconLeft="undo" title="Reset every adjustment, the skin guard and the frame to the original">

            Reset all
          </Button>
        ) : (
          <span className="tag">Original</span>
        )}
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
          <dt className="meta meta--micro">Size</dt>
          <dd className="quick__fact-value">{photo ? formatBytes(photo.bytes) : '—'}</dd>
        </div>
        <div className="quick__fact">
          <dt className="meta meta--micro">Format</dt>
          <dd className="quick__fact-value">{photo ? photo.orientation : '—'}</dd>
        </div>
      </dl>

      {PRIMARY_SECTIONS.map(({ group, label }, index) => (
        <section className="quick__section" key={group} aria-label={label}>
          {index > 0 && <hr className="rule" />}
          <h3 className="caps quick__section-title">{label}</h3>
          <ul className="quick__list">
            {CONTROLS.filter((c) => c.group === group).map((control) => (
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
            {group === 'colour' && (
              <SkinGuardRow
                value={skinGuard}
                disabled={!photo}
                onChange={onSkinGuard}
                note={dirty ? null : 'With nothing on the photograph there is no colour move for it to hold back.'}
              />
            )}
          </ul>
        </section>
      ))}

      <hr className="rule" />

      {/* Advanced section — collapsed by default so the default view stays
          approachable. Every control inside is a real pipeline stage. */}
      <section className="quick__section" aria-label="Advanced adjustments">
        <button
          type="button"
          className="rail__advanced-toggle caps"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <Icon name={advancedOpen ? 'chevronDown' : 'chevronRight'} size={12} />
          Advanced
        </button>

        {advancedOpen && (
          <div className="rail__advanced-body">
            {ADVANCED_SECTIONS.map(({ group, label }, index) => (
              <section className="quick__section" key={group} aria-label={label}>
                {index > 0 && <hr className="rule" />}
                <h3 className="caps quick__section-title">{label}</h3>
                <ul className="quick__list">
                  {CONTROLS.filter((c) => c.group === group).map((control) => (
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
          </div>
        )}
      </section>

      <p className="rail__note" id="quick-status">
        <Icon name="sliders" size={14} />
        {photo
          ? 'The stage redraws from the original every time a knob moves — these values are a recipe, not an edit to your file.'
          : 'Load a photograph to start editing.'}
      </p>

      <p className="meta meta--micro quick__original">
        Original kept untouched · {photo ? 'read from this device' : 'no file loaded'}
      </p>
    </aside>
  );
}

type SliderRowProps = {  control: Control;
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

/* Two sentences, both of them a measurement. The band's grip is proportional to
   how far a colour sits from grey, so it loosens on the palest and the darkest
   complexions first — and on a warm photograph the band is not a small area:
   53% of the studio portrait's pixels fall inside it. That half is the backdrop,
   which is why the row is called a guard and not a skin tool. */
const GUARD_HINT =
  'Holds a look back from pixels whose own colour sits in a warm, moderately saturated band — where skin sits, but also wood, sand and autumn. Not a face detector: the grip follows the colour, so a strong cool look drops the palest and the darkest skin out of the band first.';

/**
 * The one control in this rail that is not one of the sixteen knobs.
 *
 * A preset never sets it and intensity does not scale it: it is a limit placed
 * over whatever look is on the photograph, so it keeps its value when a new one
 * arrives and disappears only with Reset all. At 0 the render is the plain
 * recipe, and on an unedited photograph any value is a no-op, which is what the
 * note under the slider says.
 */
function SkinGuardRow({
  value,
  disabled,
  onChange,
  note,
}: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
  note: string | null;
}) {
  const text = value === 0 ? 'Off' : `${Math.round(value)}%`;
  return (
    <li className="quick__row">
      <div className="quick__row-head">
        <label className="quick__label" htmlFor="adjust-skin-guard">
          Skin guard
        </label>
        <span className={['quick__value', value > 0 && 'is-moved'].filter(Boolean).join(' ')}>
          {text}
        </span>
      </div>
      <input
        className="quick__slider"
        type="range"
        id="adjust-skin-guard"
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        aria-describedby="adjust-skin-guard-hint"
        aria-valuetext={text}
        title="Skin tone protection — double-click or press Enter to switch it off."
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          onChange(0);
        }}
      />
      <span className="meta meta--micro quick__hint" id="adjust-skin-guard-hint">
        {GUARD_HINT}
        {note ? ` ${note}` : ''}
      </span>
    </li>
  );
}
