import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import type { Photo } from '../lib/photoStore';
import { categoriesOf, type Query } from '../lib/preset/library';
import { queryPresets, type RankedResults } from '../lib/preset/search';
import { parameterSummary, traitsOf } from '../lib/preset/traits';
import { SUPPORT_LABEL, type Preset, type PresetLibrary } from '../lib/preset/schema';
import { coverSource, queueThumb, releaseSource } from '../lib/preset/thumb';
import { usePresetLibrary } from '../lib/preset/usePresetLibrary';
import { suggestIntensity } from '../lib/ai/intensity';
import { similarPresets } from '../lib/ai/recommender';
import type { ImageAnalysis } from '../lib/ai/imageAnalysis';
import { useImageAnalysis } from '../lib/ai/useImageAnalysis';

const PAGE = 24;

const TABS: ReadonlyArray<{ readonly id: Query['tab']; readonly label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'featured', label: 'Featured' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'recent', label: 'Recent' },
  { id: 'collections', label: 'My looks' },
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
 * of permission — and shows a page at a time. What you type is matched against
 * the catalogue's own words by a local index (see `lib/preset/search.ts`), so
 * "warm film look" and "moody night photography" are answers rather than an
 * empty shelf. Every card is painted by the engine: with a photograph on the
 * stage it is that photograph under that look, and without one it is the sample
 * the library was measured against, labelled as such. The paperwork of a partial
 * import is one tap away, not hidden.
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
  const {
    status,
    library,
    error,
    retry,
    favourites,
    recent,
    collections,
    favourite,
    keep,
    addCollection,
    removeCollection,
    forget,
  } = usePresetLibrary();
  const [text, setText] = useState('');
  const [tab, setTab] = useState<Query['tab']>('all');
  const [category, setCategory] = useState<string | null>(null);
  const [collection, setCollection] = useState<string | null>(null);
  const [page, setPage] = useState(PAGE);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const analysis = useImageAnalysis(photo);

  const noteThumbError = useCallback(
    () =>
      setThumbError(
        'The photograph behind the cards could not be read. Every look still applies to the stage; only the card previews are missing.',
      ),
    [],
  );
  const noteThumbPainted = useCallback(() => setThumbError(null), []);

  const query = useMemo<Query>(
    () => ({ text, category, tab, favourites, recent, collections, collection }),
    [text, category, tab, favourites, recent, collections, collection],
  );

  const ranked = useMemo(() => (library ? queryPresets(library, query) : null), [library, query]);
  const results = useMemo(() => ranked?.presets ?? [], [ranked]);
  const chosen = useMemo(
    () => (library ? library.presets.find((preset) => preset.id === selected) ?? null : null),
    [library, selected],
  );
  const collectionNames = useMemo(
    () => Object.keys(collections).sort((a, b) => a.localeCompare(b)),
    [collections],
  );
  /** Words the phrase asked for that no preset anywhere in the catalogue uses. */
  const unmatched = useMemo(
    () => (ranked?.outcome?.tokens ?? []).filter((token) => token.via === null).map((token) => token.word),
    [ranked],
  );

  useEffect(() => {
    setPage(PAGE);
  }, [text, tab, category, collection]);

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
              {TABS.filter((entry) => entry.id !== 'collections' || collectionNames.length > 0).map((entry) => (
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

            {tab === 'collections' && collectionNames.length > 0 && (
              <div className="looks__chips" role="group" aria-label="Your collections">
                {collectionNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={['chip', collection === name && 'is-active'].filter(Boolean).join(' ')}
                    aria-pressed={collection === name}
                    onClick={() => setCollection(collection === name ? null : name)}
                  >
                    {`${name} (${collections[name]?.length ?? 0})`}
                  </button>
                ))}
                {collection && (
                  <button
                    type="button"
                    className="caps looks__forget is-armed"
                    onClick={() => {
                      removeCollection(collection);
                      setCollection(null);
                    }}
                  >
                    Delete “{collection}”
                  </button>
                )}
              </div>
            )}

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

          {chosen && library && (
            <PresetPapers
              key={chosen.id}
              preset={chosen}
              library={library}
              modified={modified}
              intensity={intensity}
              analysis={analysis}
              collections={collections}
              onIntensity={onIntensity}
              onClear={onClear}
              onPick={onApply}
              onKeep={keep}
              onAddCollection={addCollection}
            />
          )}

          {results.length === 0 ? (
            <p className="looks__state body-muted" role="status">
              {searchNote(text, ranked, tab, category, collection)}
            </p>
          ) : (
            <div className="looks__body">
              {ranked && !ranked.exact && (
                <p className="meta meta--micro looks__near" role="status">
                  {`Nothing in the catalogue uses every word in “${text}”. These are the closest`}
                  {unmatched.length > 0 ? ` — none of them mention ${unmatched.join(' or ')}.` : '.'}
                </p>
              )}
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
              ? 'Cards are your photograph with each look applied. The photograph is never stored or uploaded — what is kept on this device is listed below.'
              : `Cards are the sample photograph from ${library.sample}, rendered by the same engine. Your own file, once loaded, replaces it.`}
          </p>
          <PreferenceFoot
            favourites={favourites.length}
            recent={recent.length}
            collections={collectionNames.length}
            onForget={forget}
          />
          <LibraryFootnote library={library} />
        </>
      )}
    </section>
  );
});

type PreferenceFootProps = {
  favourites: number;
  recent: number;
  collections: number;
  onForget: () => void;
};

/**
 * What this device remembers, and the one button that makes it forget. A
 * preference you cannot delete is a profile, so the count and the clear action
 * sit together where the marks were made.
 */
function PreferenceFoot({ favourites, recent, collections, onForget }: PreferenceFootProps) {
  const [armed, setArmed] = useState(false);
  const total = favourites + recent + collections;

  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 6000);
    return () => window.clearTimeout(id);
  }, [armed]);

  if (total === 0) {
    return (
      <p className="meta meta--micro looks__prefs">
        Nothing is kept about you on this device yet. Starring a look or applying one starts a list you
        can clear here at any time.
      </p>
    );
  }

  return (
    <p className="meta meta--micro looks__prefs">
      {`Kept on this device: ${favourites} favourite${favourites === 1 ? '' : 's'} · ${recent} recent · ${collections} collection${collections === 1 ? '' : 's'} · `}
      <button
        type="button"
        className={['caps', 'looks__forget', armed && 'is-armed'].filter(Boolean).join(' ')}
        onClick={() => {
          if (armed) {
            onForget();
            setArmed(false);
          } else {
            setArmed(true);
          }
        }}
      >
        {armed ? 'Tap again to forget' : 'Forget these'}
      </button>
    </p>
  );
}

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
        onClick={() => onApply(preset)}
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
  library: PresetLibrary;
  modified: boolean;
  intensity: number;
  /** Measurements of the photograph on the stage, or null before one arrives. */
  analysis: ImageAnalysis | null;
  collections: Readonly<Record<string, readonly string[]>>;
  onIntensity: (value: number) => void;
  onClear: () => void;
  onPick: (preset: Preset) => void;
  onKeep: (collection: string, id: string) => void;
  onAddCollection: (name: string) => string | null;
};

/** The honest label: what arrived, what did not, where it came from, and what it does. */
function PresetPapers({
  preset,
  library,
  modified,
  intensity,
  analysis,
  collections,
  onIntensity,
  onClear,
  onPick,
  onKeep,
  onAddCollection,
}: PapersProps) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const traits = traitsOf(preset);
  const suggestion = useMemo(() => suggestIntensity(preset, analysis), [preset, analysis]);
  const neighbours = useMemo(() => similarPresets(library, preset, 4), [library, preset]);
  const names = Object.keys(collections).sort((a, b) => a.localeCompare(b));

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

      <p className="meta meta--micro papers__traits">
        {`${traits.visual.length > 0 ? traits.visual.slice(0, 4).map((t) => `${t.label} ${t.magnitude}`).join(' · ') : 'No strong character'} · ${traits.strength} change`}
      </p>

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
        {analysis && suggestion.value !== intensity && (
          <span className="meta meta--micro papers__suggest">
            {`A start of ${suggestion.value}% suits what was measured (${suggestion.reason}) `}
            <button type="button" className="caps papers__use" onClick={() => onIntensity(suggestion.value)}>
              Use it
            </button>
          </span>
        )}
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

      <div className="papers__keep">
        {names.map((name) => {
          const kept = (collections[name] ?? []).includes(preset.id);
          return (
            <button
              key={name}
              type="button"
              className={['chip', 'papers__chip', kept && 'is-active'].filter(Boolean).join(' ')}
              aria-pressed={kept}
              onClick={() => onKeep(name, preset.id)}
            >
              {`${name}${kept ? ' ✓' : ''}`}
            </button>
          );
        })}
        <form
          className="papers__new"
          onSubmit={(event) => {
            event.preventDefault();
            if (onAddCollection(newName) !== null) setNewName('');
          }}
        >
          <input
            type="text"
            className="papers__newinput"
            value={newName}
            placeholder="new collection"
            maxLength={40}
            aria-label="Name for a new collection of looks"
            onChange={(event) => setNewName(event.target.value)}
          />
          <button type="submit" className="caps papers__chip" disabled={!newName.trim()}>
            Add
          </button>
        </form>
      </div>

      {neighbours.length > 0 && (
        <div className="papers__similar" role="group" aria-label="Looks measured as closest to this one">
          <span className="meta meta--micro">Looks like this</span>
          {neighbours.map((neighbour) => (
            <button
              key={neighbour.id}
              type="button"
              className="chip papers__chip"
              title={`${neighbour.category} · ${neighbour.name}`}
              onClick={() => onPick(neighbour)}
            >
              {neighbour.name}
            </button>
          ))}
        </div>
      )}

      {open && (
        <dl className="papers__list">
          <div className="papers__row">
            <dt className="meta meta--micro">Knobs it moves</dt>
            <dd>{parameterSummary(preset)}</dd>
          </div>
          <div className="papers__row">
            <dt className="meta meta--micro">Subjects it names itself</dt>
            <dd>
              {traits.scenes.length > 0
                ? `${traits.scenes.join(' · ')} — from this preset’s own category and tags, not a test`
                : 'The preset does not name a subject'}
            </dd>
          </div>
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
          <div className="papers__row">
            <dt className="meta meta--micro">How these are known</dt>
            <dd>{traits.provenance}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

/**
 * Why the shelf is empty. The wording separates "these words are not in the
 * catalogue" from "you have not kept anything yet", because they are different
 * answers and only one of them is a problem with the words.
 */
function searchNote(
  text: string,
  ranked: RankedResults | null,
  tab: Query['tab'],
  category: string | null,
  collection: string | null,
): string {
  const outcome = ranked?.outcome;
  if (outcome && outcome.meaningful) {
    const unusable = outcome.tokens.filter((token) => token.via === null).map((token) => token.word);
    return unusable.length > 0
      ? `No preset in the catalogue is described as ${unusable.join(' or ')}. Try one of the words the library uses — the categories above are all of them.`
      : `Nothing in ${tab === 'all' ? 'this pool' : `the ${tab} list`} matches “${text}”. The words fit some looks, but not together.`;
  }
  if (tab === 'favourites') {
    return category ? `No favourites in ${category} yet.` : 'No favourites yet. Tap the star on a look to keep it here.';
  }
  if (tab === 'recent') {
    return category ? `Nothing used in ${category} yet.` : 'Nothing used yet. Apply a look and it will appear here.';
  }
  if (tab === 'collections') {
    return collection
      ? `“${collection}” is empty. Choose a look and use the collection buttons above to keep it.`
      : 'Pick a collection above, or make one from the look paperwork.';
  }
  return category ? `No ${category.toLowerCase()} looks here.` : 'Nothing here yet.';
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
