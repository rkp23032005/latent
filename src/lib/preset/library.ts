/**
 * The preset library, as the editor sees it.
 *
 * The catalogue is a file the build produced, not a service: it is fetched from
 * this origin once, kept in memory for the session, and the editor works
 * normally if the network never comes back. Favourites and recent picks are the
 * user's own, stored on this device, and they hold ids rather than copies so a
 * library update can rename or remove a look without stranding anything.
 */

import { IDENTITY } from '../image/adjustments.ts';
import type { Adjustments } from '../image/adjustments.ts';
import type { Preset, PresetLibrary, PresetSource, SourceRecord, SupportLevel } from './schema.ts';

export const LIBRARY_URL = '/presets/library.json';
export const FAVOURITES_KEY = 'latent.preset.favourites';
export const RECENTS_KEY = 'latent.preset.recent';

/** A look you cannot apply is not something to click on. */
export const USABLE: readonly SupportLevel[] = ['full', 'partial'];

let pending: Promise<PresetLibrary> | null = null;
let loaded: PresetLibrary | null = null;

const SUPPORT_LEVELS: readonly SupportLevel[] = ['full', 'partial', 'unsupported', 'invalid'];
const ADJUSTMENT_KEYS = new Set(Object.keys(IDENTITY));

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function adjustmentOf(value: unknown): Partial<Adjustments> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (ADJUSTMENT_KEYS.has(key) && typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return out as Partial<Adjustments>;
}

function sourceOf(value: unknown): PresetSource {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const file = typeof record.file === 'string' ? record.file : undefined;
  const attribution = typeof record.attribution === 'string' ? record.attribution : undefined;
  return {
    sourceId: text(record.sourceId, 'unknown'),
    licence: text(record.licence, 'Unknown licence'),
    origin: text(record.origin, 'Source not recorded'),
    ...(file ? { file } : {}),
    ...(attribution ? { attribution } : {}),
  };
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The catalogue's account of where it came from; a broken line costs only that line. */
function sourceRecordOf(value: unknown): SourceRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sourceId = typeof record.sourceId === 'string' ? record.sourceId.trim() : '';
  const verdict =
    record.verdict === 'imported' || record.verdict === 'rejected' ? record.verdict : null;
  if (!sourceId || !verdict) return null;
  return {
    sourceId,
    repository: text(record.repository, 'Not recorded'),
    licence: text(record.licence, 'Unknown licence'),
    licenceFile: text(record.licenceFile, ''),
    attribution: text(record.attribution, ''),
    verdict,
    reason: text(record.reason, ''),
    formats: texts(record.formats),
    filesFound: numberOf(record.filesFound),
    presetsKept: numberOf(record.presetsKept),
    presetsDropped: numberOf(record.presetsDropped),
  };
}

/**
 * One catalogue entry, made safe to render. A file that was hand-edited or
 * truncated should cost the entry that is wrong, not the whole catalogue — so a
 * preset missing its tags is repaired, and one missing an identity is dropped.
 */
function coercePreset(value: unknown): Preset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  const adjust = adjustmentOf(p.adjust);
  const support =
    typeof p.support === 'string' && SUPPORT_LEVELS.includes(p.support as SupportLevel)
      ? (p.support as SupportLevel)
      : null;
  if (!id || !name || !adjust || !support) return null;

  const limitation = typeof p.limitation === 'string' ? p.limitation : undefined;
  const effect =
    typeof p.effect === 'number' && Number.isFinite(p.effect) ? p.effect : undefined;
  return {
    id,
    name,
    category: text(p.category, 'Uncategorised'),
    description: text(p.description, ''),
    adjust,
    support,
    origin: p.origin === 'generated' ? 'generated' : 'imported',
    source: sourceOf(p.source),
    mapped: texts(p.mapped),
    dropped: texts(p.dropped),
    ...(limitation ? { limitation } : {}),
    tags: texts(p.tags),
    ...(effect !== undefined ? { effect } : {}),
  };
}

/** A catalogue that cannot answer at all should say so in words the user can act on. */
function ask(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  return fetch(url, { signal: controller.signal })
    .catch(() => {
      throw new Error(
        'The preset catalogue could not be fetched. Editing with the knobs still works, and the catalogue can be asked for again.',
      );
    })
    .finally(() => window.clearTimeout(timer));
}

export function loadLibrary(url: string = LIBRARY_URL): Promise<PresetLibrary> {
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  pending = ask(url)
    .then(async (response) => {
      if (!response.ok) throw new Error(`The preset catalogue answered ${response.status}.`);
      /* A dev server that does not have the file yet answers with the app's own
         HTML, and that is what the retry then keeps re-reading. */
      if (!(response.headers.get('content-type') ?? '').includes('json')) {
        throw new Error('The preset catalogue is not a readable file.');
      }
      return response.json();
    })
    .then((json: unknown) => {
      const library =
        json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
      if (!library || !Array.isArray(library.presets)) {
        throw new Error('The preset catalogue is not readable.');
      }
      /* A duplicated id would give two cards the same identity, so the first
         entry that claims an id keeps it and the copy is dropped. */
      const seen = new Set<string>();
      const presets = (library.presets as unknown[])
        .map(coercePreset)
        .filter((preset): preset is Preset => {
          if (preset === null || seen.has(preset.id)) return false;
          seen.add(preset.id);
          return true;
        });
      if (presets.length === 0) {
        throw new Error('The preset catalogue contains no presets this editor can use.');
      }
      /* The label counts what was actually loaded, so a repaired file cannot
         claim a total it does not have. */
      const counts: Record<SupportLevel, number> = { full: 0, partial: 0, unsupported: 0, invalid: 0 };
      for (const preset of presets) counts[preset.support] += 1;
      const next: PresetLibrary = {
        version: typeof library.version === 'number' && Number.isFinite(library.version) ? library.version : 0,
        builtAt: text(library.builtAt, 'date not recorded'),
        sample: text(library.sample, '/photography/landscape-highlands.jpg'),
        presets,
        sources: (Array.isArray(library.sources) ? library.sources : [])
          .map(sourceRecordOf)
          .filter((source): source is SourceRecord => source !== null),
        counts,
      };
      loaded = next;
      return next;
    })
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}

/** Only ever for tests: forget what was fetched. */
export function resetLibraryCache(): void {
  pending = null;
  loaded = null;
}

/* The catalogue is fetched once and does not change, so its two derived views
   are built once too: a search keystroke should not rebuild a 663-entry map. */
const indexes = new WeakMap<PresetLibrary, Map<string, Preset>>();
const categoryLists = new WeakMap<PresetLibrary, string[]>();

export function indexById(library: PresetLibrary | null): Map<string, Preset> {
  if (!library) return new Map();
  const known = indexes.get(library);
  if (known) return known;
  const next = new Map(library.presets.map((preset) => [preset.id, preset]));
  indexes.set(library, next);
  return next;
}

export function isUsable(preset: Preset): boolean {
  return USABLE.includes(preset.support) && Object.keys(preset.adjust).length > 0;
}

export function categoriesOf(library: PresetLibrary): string[] {
  const known = categoryLists.get(library);
  if (known) return known;
  const seen = new Set<string>();
  for (const preset of library.presets) if (isUsable(preset)) seen.add(preset.category);
  const next = [...seen].sort((a, b) => a.localeCompare(b));
  categoryLists.set(library, next);
  return next;
}

export function browseIds(ids: readonly string[], presets: Map<string, Preset>): Preset[] {
  return ids.map((id) => presets.get(id)).filter((preset): preset is Preset => !!preset && isUsable(preset));
}

export type Query = {
  readonly text: string;
  readonly category: string | null;
  readonly tab: 'all' | 'featured' | 'favourites' | 'recent' | 'left behind';
  readonly favourites: readonly string[];
  readonly recent: readonly string[];
};

function matches(preset: Preset, needle: string): boolean {
  if (!needle) return true;
  return (
    preset.name.toLowerCase().includes(needle) ||
    preset.category.toLowerCase().includes(needle) ||
    preset.description.toLowerCase().includes(needle) ||
    preset.tags.some((tag) => tag.includes(needle))
  );
}

/**
 * One pass, one order: what the user typed narrows everything, the tab decides
 * the pool, and the newest work still sits at the front of the whole library.
 */
export function filterPresets(library: PresetLibrary, query: Query): Preset[] {
  const needle = query.text.trim().toLowerCase();
  const pool =
    query.tab === 'favourites'
      ? browseIds(query.favourites, indexById(library))
      : query.tab === 'recent'
        ? browseIds(query.recent, indexById(library))
        : query.tab === 'left behind'
          ? library.presets.filter((preset) => !isUsable(preset))
          : library.presets.filter(isUsable);
  const category = query.category;
  return pool.filter(
    (preset) =>
      (category === null || preset.category === category) &&
      (query.tab !== 'featured' || preset.tags.includes('featured')) &&
      matches(preset, needle),
  );
}

function readList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(key: string, ids: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* Private mode or a full quota: the library still works, it just forgets. */
  }
}

export function readFavourites(): string[] {
  return readList(FAVOURITES_KEY);
}

export function toggleFavourite(id: string): string[] {
  const current = readFavourites();
  const next = current.includes(id) ? current.filter((item) => item !== id) : [id, ...current];
  writeList(FAVOURITES_KEY, next.slice(0, 200));
  return next;
}

export function readRecent(): string[] {
  return readList(RECENTS_KEY);
}

export function rememberRecent(id: string): string[] {
  const next = [id, ...readRecent().filter((item) => item !== id)];
  writeList(RECENTS_KEY, next.slice(0, 24));
  return next;
}
