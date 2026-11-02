import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import type { Photo } from '../lib/photoStore';
import { categoriesOf, filterPresets, type Query } from '../lib/preset/library';
import { SUPPORT_LABEL, type Preset, type PresetLibrary } from '../lib/preset/schema';
import { coverSource, queueThumb, releaseSource } from '../lib/preset/thumb';
import { usePresetLibrary } from '../lib/preset/usePresetLibrary';

const PAGE = 24;

const TABS: ReadonlyArray<{ readonly id: Query['tab']; readonly label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'featured', label: 'Featured' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'recent', label: 'Recent' },
  { id: 'left behind', label: 'Left behind' },
];

type PresetBrowserProps = {
  photo: Photo | null;
  selected: string | null;
  modified: boolean;
  /** How much of the selected look is on the photograph, 0–100. */
  intensity: number;
  onApply: (preset: Preset) => void;
  onClear: () => void;
  onIntensity: (value: number) => void;
};

/**
 * The look browser.
 *
 * Six hundred entries would not fit on a screen worth looking at, so the rail
 * asks three questions in order — what are you after, which family, which sort
 * of permission — and shows a page at a time. Every card is painted by the
 * engine: with a photograph on the stage it is that photograph under that look,
 * and without one it is the sample the library was measured against, labelled as
 * such. The paperwork of a partial import is one tap away, not hidden.
 */
export const PresetBrowser = memo(function PresetBrowser({
  photo,
  selected,
  modified,
  intensity,
  onApply,
  onClear,
  onIntensity,
}: PresetBrowserProps) {
  const { status, library, error, retry, favourites, recent, favourite, remember } = usePresetLibrary();
  const [text, setText] = useState('');
  const [tab, setTab] = useState<Query['tab']>('all');
  const [category, setCategory] = useState<string | null>(null);
  const [page, setPage] = useState(PAGE);
  const [thumbError, setThumbError] = useState<string | null>(null);

  const noteThumbError = useCallback(
    () =>
      setThumbError(
        'The photograph behind the cards could not be read. Every look still applies to the stage; only the card previews are missing.',
      ),
    [],
  );
  const noteThumbPainted = useCallback(() => setThumbError(null), []);

  const query = useMemo<Query>(
    () => ({ text, category, tab, favourites, recent }),
    [text, category, tab, favourites, recent],
  );

  const results = useMemo(() => (library ? filterPresets(library, query) : []), [library, query]);
  const chosen = useMemo(
    () => (library ? library.presets.find((preset) => preset.id === selected) ?? null : null),
    [library, selected],
  );

  useEffect(() => {
    setPage(PAGE);
  }, [text, tab, category]);

  /* A photograph that left the stage took its decoded pixels with it: the card
     cache must not keep a bitmap behind a revoked blob url. */
  const lastSource = useRef<string | null>(null);
  useEffect(() => {
    const url = photo?.url ?? null;
    const before = lastSource.current;
    lastSource.current = url;
    if (before && before !== url && before.startsWith('blob:')) releaseSource(before);
    setThumbError(null);
  }, [photo?.url]);

  const sourceUrl = photo?.url ?? library?.sample ?? null;
  const shown = results.slice(0, page);

  return (
    <section className="rail rail--looks" aria-labelledby="looks-title">
      <div className="rail__head">
        <h2 className="caps rail__head-title" id="looks-title">
          Looks
        </h2>
        {status === 'ready' && <span className="meta meta--micro looks__count">{results.length} shown</span>}
      </div>

      {status === 'loading' && (
        <div className="looks__state" role="status">
          <Icon name="film" size={16} />
          <p className="body-muted">
            Reading the preset catalogue built into this app. Editing with the knobs does not wait
            for it.
          </p>
        </div>
      )}

      {status === 'error' && (
        <div className="looks__state looks__state--bad" role="alert">
          <Icon name="close" size={16} />
          <p className="body-muted">{error ?? 'The presets could not be read.'}</p>
          <Button variant="ghost" size="sm" onClick={retry} iconLeft="undo">
            Try the catalogue again
          </Button>
        </div>
      )}

      {status === 'ready' && library && (
        <>
          <div className="looks__bar">
            <label className="looks__search">
              <span className="meta meta--micro">Search</span>
              <input
                type="search"
                value={text}
                placeholder="warm, faded, night…"
                onChange={(event) => setText(event.target.value)}
                aria-label="Search presets by name, category or description"
              />
            </label>

            <div className="looks__tabs" role="group" aria-label="Preset groups">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={tab === entry.id}
                  className={['caps', 'looks__tab', tab === entry.id && 'is-active'].filter(Boolean).join(' ')}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            {tab !== 'left behind' && (
              <div className="looks__chips">
                <CategoryChips
                  categories={categoriesOf(library)}
                  active={category}
                  onSelect={setCategory}
                />
              </div>
            )}
          </div>

          {thumbError && (
            <div className="looks__state" role="status">
              <Icon name="image" size={16} />
              <p className="body-muted">{thumbError}</p>
            </div>
          )}

          {chosen && (
            <PresetPapers
              key={chosen.id}
              preset={chosen}
              modified={modified}
              intensity={intensity}
              onIntensity={onIntensity}
              onClear={onClear}
            />
          )}

          {results.length === 0 ? (
            <p className="looks__state body-muted" role="status">
              {text
                ? `Nothing here matches “${text}”.`
                : tab === 'favourites'
                  ? category
                    ? `No favourites in ${category} yet.`
                    : 'No favourites yet. Tap the star on a look to keep it here.'
                  : tab === 'recent'
                    ? category
                      ? `Nothing used in ${category} yet.`
                      : 'Nothing used yet. Apply a look and it will appear here.'
                    : category
                      ? `No ${category.toLowerCase()} looks here.`
                      : 'Nothing here yet.'}
              {category ? ` Clear ${category} to see the rest.` : ''}
            </p>
          ) : (
            <div className="looks__body">
              {tab === 'left behind' ? (
                <Pile presets={shown} />
              ) : (
                <ul className="looks__grid">
                  {shown.map((preset) => (
                    <Card
                      key={`${preset.id}|${sourceUrl ?? 'none'}`}
                      preset={preset}
                      sourceUrl={sourceUrl}
                      isSelected={preset.id === selected}
                      modified={modified && preset.id === selected}
                      intensity={intensity}
                      isFavourite={favourites.includes(preset.id)}
                      onApply={onApply}
                      onFavourite={favourite}
                      onRemember={remember}
                      onSourceError={noteThumbError}
                      onPainted={noteThumbPainted}
                    />
                  ))}
                </ul>
              )}
              {results.length > page && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="looks__more"
                  onClick={() => setPage((n) => n + PAGE)}
                  iconLeft="plus"
                >
                  {`Show ${Math.min(PAGE, results.length - page)} more · ${page} of ${results.length}`}
                </Button>
              )}
            </div>
          )}

          <p className="meta meta--micro looks__foot" aria-live="polite">
            {photo
              ? 'Cards are your photograph with each look applied. Nothing is stored — the original stays untouched.'
              : `Cards are the sample photograph from ${library.sample}, rendered by the same engine. Your own file, once loaded, replaces it.`}
          </p>
          <LibraryFootnote library={library} />
        </>
      )}
    </section>
  );
});

type CategoryChipsProps = {
  categories: string[];
  active: string | null;
  onSelect: (value: string | null) => void;
};

function CategoryChips({ categories, active, onSelect }: CategoryChipsProps) {
  return (
    <div className="looks__scroll" aria-label="Categories">
      <button
        type="button"
        className={['chip', active === null && 'is-active'].filter(Boolean).join(' ')}
        aria-pressed={active === null}
        onClick={() => onSelect(null)}
      >
        Every category
      </button>
      {categories.map((name) => (
        <button
          key={name}
          type="button"
          className={['chip', active === name && 'is-active'].filter(Boolean).join(' ')}
          aria-pressed={active === name}
          onClick={() => onSelect(active === name ? null : name)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

type CardProps = {
  preset: Preset;
  sourceUrl: string | null;
  isSelected: boolean;
  modified: boolean;
  intensity: number;
  isFavourite: boolean;
  onApply: (preset: Preset) => void;
  onFavourite: (id: string) => void;
  onRemember: (id: string) => void;
  onSourceError: () => void;
  onPainted: () => void;
};

const Card = memo(function Card({
  preset,
  sourceUrl,
  isSelected,
  modified,
  intensity,
  isFavourite,
  onApply,
  onFavourite,
  onRemember,
  onSourceError,
  onPainted,
}: CardProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'waiting' | 'painted' | 'plain'>('waiting');

  useEffect(() => {
    const node = canvas.current;
    if (!node || !sourceUrl) return;
    let alive = true;

    /* A card is only worth painting once someone can see it: the library is
       large and every pixel in it is computed. */
    const watch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        watch.disconnect();
        coverSource(sourceUrl).then(
          (bitmap) => {
            if (!alive) return;
            queueThumb(node, bitmap, preset, sourceUrl, (painted) => {
              if (!alive) return;
              setState(painted ? 'painted' : 'waiting');
              if (painted) onPainted();
            });
          },
          () => {
            if (!alive) return;
            setState('plain');
            onSourceError();
          },
        );
      },
      { rootMargin: '160px' },
    );
    watch.observe(node);
    return () => {
      alive = false;
      watch.disconnect();
    };
  }, [preset, sourceUrl, onPainted, onSourceError]);

  return (
    <li className={['pcard', isSelected && 'is-chosen'].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="pcard__face"
        aria-pressed={isSelected}
        title={`${preset.name} — ${preset.description}`}
        onClick={() => {
          onApply(preset);
          onRemember(preset.id);
        }}
      >
        <span className="pcard__window">
          <canvas ref={canvas} className="pcard__thumb" aria-hidden="true" />
          {state !== 'painted' && <span className="pcard__veil" aria-hidden="true" />}
        </span>
        <span className="pcard__foot">
          <span className="pcard__name">{preset.name}</span>
          <span className="meta meta--micro pcard__line">
            {preset.category} · {SUPPORT_LABEL[preset.support]}
            {isSelected &&
              ` · applied${intensity === 100 ? '' : ` at ${intensity}%`}${modified ? ', changed by you' : ''}`}
          </span>
        </span>
      </button>
      <button
        type="button"
        className={['pcard__star', isFavourite && 'is-kept'].filter(Boolean).join(' ')}
        aria-pressed={isFavourite}
        aria-label={isFavourite ? `Remove ${preset.name} from favourites` : `Keep ${preset.name} as a favourite`}
        onClick={() => onFavourite(preset.id)}
      >
        <Icon name="star" size={13} />
      </button>
    </li>
  );
});

type PapersProps = {
  preset: Preset;
  modified: boolean;
  intensity: number;
  onIntensity: (value: number) => void;
  onClear: () => void;
};

/** The honest label: what arrived, what did not, and where it came from. */
function PresetPapers({ preset, modified, intensity, onIntensity, onClear }: PapersProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="papers" aria-live="polite">
      <div className="papers__head">
        <span className="papers__name">{preset.name}</span>
        <span className={['tag', preset.support === 'partial' && 'tag--pending'].filter(Boolean).join(' ')}>
          {SUPPORT_LABEL[preset.support]}
          {modified && ' · changed'}
        </span>
      </div>
      <p className="body-muted papers__note">{preset.limitation ?? preset.description}</p>

      {/* The same blend the knobs use: identity to the recipe, in slider units. */}
      <div className="quick__row papers__strength">
        <div className="quick__row-head">
          <label className="quick__label" htmlFor="preset-intensity">
            Intensity
          </label>
          <span className={['quick__value', intensity !== 100 && 'is-moved'].filter(Boolean).join(' ')}>
            {intensity}%
          </span>
        </div>
        <input
          className="quick__slider"
          type="range"
          id="preset-intensity"
          min={0}
          max={100}
          step={1}
          value={intensity}
          aria-describedby="preset-intensity-hint"
          aria-valuetext={`${intensity}%`}
          title="Intensity — 0 is the photograph as it arrived, 100 is this look exactly as written."
          onChange={(event) => onIntensity(Number(event.target.value))}
        />
        <span className="meta meta--micro quick__hint" id="preset-intensity-hint">
          Scales the whole look, every knob at once. Your own turns on top of it stay.
        </span>
      </div>

      <div className="papers__actions">
        <Button variant="ghost" size="sm" onClick={onClear} iconLeft="undo">
          Remove look
        </Button>
        <button
          type="button"
          className="caps papers__toggle"
          aria-expanded={open}
          onClick={() => setOpen((n) => !n)}
        >
          <Icon name={open ? 'close' : 'chevronDown'} size={12} />
          {open ? 'Hide the paperwork' : 'What came over'}
        </button>
      </div>
      {open && (
        <dl className="papers__list">
          <div className="papers__row">
            <dt className="meta meta--micro">Carried over</dt>
            <dd>{preset.mapped.length > 0 ? preset.mapped.join(' · ') : 'Nothing'}</dd>
          </div>
          <div className="papers__row">
            <dt className="meta meta--micro">Not carried over</dt>
            <dd>{preset.dropped.length > 0 ? preset.dropped.join(' · ') : 'Nothing was left behind'}</dd>
          </div>
          <div className="papers__row">
            <dt className="meta meta--micro">Source</dt>
            <dd>
              {preset.source.origin}
              {preset.source.file ? ` · ${preset.source.file}` : ''} · {preset.source.licence}
              {preset.source.attribution ? ` · ${preset.source.attribution}` : ''}
            </dd>
          </div>
          {typeof preset.effect === 'number' && (
            <div className="papers__row">
              <dt className="meta meta--micro">Measured change</dt>
              <dd>{`mean ${preset.effect.toFixed(2)} of 255 per channel on the test chart`}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

function Pile({ presets }: { presets: Preset[] }) {
  return (
    <ul className="pile">
      <li className="meta meta--micro pile__note">
        Read and understood, but this engine cannot perform them. Listed so the count stays honest —
        a 3D LUT would need a grid-sampling stage, and a preset that changes no pixels is not a look.
      </li>
      {presets.map((preset) => (
        <li className="pile__row" key={preset.id}>
          <span className="pile__name">{preset.name}</span>
          <span className="meta meta--micro pile__why">
            {SUPPORT_LABEL[preset.support]} · {preset.limitation ?? preset.dropped[0] ?? 'no usable settings'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LibraryFootnote({ library }: { library: PresetLibrary }) {
  const counts = library.counts;
  return (
    <p className="meta meta--micro looks__made">
      {`${counts.full + counts.partial} of ${library.presets.length} entries are applicable here · built ${library.builtAt}`}
      {` · ${library.sources.filter((source) => source.verdict === 'imported').length} sources accepted, `}
      {`${library.sources.filter((source) => source.verdict === 'rejected').length} refused`}
    </p>
  );
}
