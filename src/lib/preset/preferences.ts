/**
 * What the user kept, used and collected — on this device, in one place.
 *
 * ## Why a store instead of component state
 * Two panels show the star and the recent list, and each used to keep its own
 * copy read out of localStorage at mount. Marking a look in one panel therefore
 * did not change the other until a reload, which reads as a bug because it is
 * one. There is now exactly one copy here; panels subscribe to it.
 *
 * ## What is stored, and what is not
 * Ids and short words only: favourite ids, recently applied ids, the names and
 * contents of the user's own collections, and the style words they last typed or
 * chose. No photograph, no pixel, no file name, no project. It is all readable
 * JSON under three `latent.preset.*` keys, and `clearPreferences` removes every
 * one of them — the interface offers that, because a preference you cannot
 * delete is a profile.
 *
 * Storage failures are swallowed on purpose: private mode and a full quota are
 * normal browser conditions, and forgetting is a worse outcome than refusing to
 * edit. The interface still says nothing was uploaded.
 */

export const FAVOURITES_KEY = 'latent.preset.favourites';
export const RECENTS_KEY = 'latent.preset.recent';
export const COLLECTIONS_KEY = 'latent.preset.collections';
export const STYLES_KEY = 'latent.preset.styles';

export const RECENT_LIMIT = 24;
export const FAVOURITE_LIMIT = 200;
export const COLLECTION_LIMIT = 12;
export const STYLE_LIMIT = 8;

export type Preferences = {
  readonly favourites: readonly string[];
  readonly recent: readonly string[];
  readonly collections: Readonly<Record<string, readonly string[]>>;
  readonly styles: readonly string[];
};

const EMPTY: Preferences = { favourites: [], recent: [], collections: {}, styles: [] };

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStrings(key: string): string[] {
  try {
    const raw = store()?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((i): i is string => typeof i === 'string') : [];
  } catch {
    return [];
  }
}

function writeStrings(key: string, ids: readonly string[]): void {
  try {
    store()?.setItem(key, JSON.stringify(ids));
  } catch {
    /* Private mode or a full quota: the editor keeps working and simply forgets. */
  }
}

function readCollections(): Record<string, string[]> {
  try {
    const raw = store()?.getItem(COLLECTIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [name, ids] of Object.entries(parsed as Record<string, unknown>)) {
      const clean = name.trim().slice(0, 40);
      if (!clean || !Array.isArray(ids)) continue;
      out[clean] = ids.filter((i): i is string => typeof i === 'string').slice(0, FAVOURITE_LIMIT);
    }
    return out;
  } catch {
    return {};
  }
}

function writeCollections(collections: Readonly<Record<string, readonly string[]>>): void {
  try {
    store()?.setItem(COLLECTIONS_KEY, JSON.stringify(collections));
  } catch {
    /* as above */
  }
}

let snapshot: Preferences = {
  favourites: readStrings(FAVOURITES_KEY),
  recent: readStrings(RECENTS_KEY),
  collections: readCollections(),
  styles: readStrings(STYLES_KEY),
};

const listeners = new Set<() => void>();

function publish(next: Preferences): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function mutate(
  change: (current: Preferences) => Partial<Preferences>,
  persist: (next: Preferences) => void,
): void {
  const next: Preferences = { ...snapshot, ...change(snapshot) };
  persist(next);
  publish(next);
}

/** Everything the user has marked, newest first, ids only. */
export function readPreferences(): Preferences {
  return snapshot;
}

export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable reference between changes, so `useSyncExternalStore` does not loop. */
export function preferencesSnapshot(): Preferences {
  return snapshot;
}

export function isFavourite(id: string): boolean {
  return snapshot.favourites.includes(id);
}

export function toggleFavourite(id: string): readonly string[] {
  mutate(
    (current) => {
      const next = current.favourites.includes(id)
        ? current.favourites.filter((item) => item !== id)
        : [id, ...current.favourites];
      return { favourites: next.slice(0, FAVOURITE_LIMIT) };
    },
    (next) => writeStrings(FAVOURITES_KEY, next.favourites),
  );
  return snapshot.favourites;
}

/** Called whenever a look actually lands on the photograph, from any panel. */
export function rememberRecent(id: string): readonly string[] {
  mutate(
    (current) => ({ recent: [id, ...current.recent.filter((item) => item !== id)].slice(0, RECENT_LIMIT) }),
    (next) => writeStrings(RECENTS_KEY, next.recent),
  );
  return snapshot.recent;
}

/** The style words the user last asked for — used to order suggestions. */
export function rememberStyle(label: string): readonly string[] {
  const clean = label.trim().slice(0, 40);
  if (!clean) return snapshot.styles;
  mutate(
    (current) => ({
      styles: [clean, ...current.styles.filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(
        0,
        STYLE_LIMIT,
      ),
    }),
    (next) => writeStrings(STYLES_KEY, next.styles),
  );
  return snapshot.styles;
}

export function collectionNames(): string[] {
  return Object.keys(snapshot.collections).sort((a, b) => a.localeCompare(b));
}

/** Collection names are the user's own words; only the shape is checked here. */
export function createCollection(name: string): string | null {
  const clean = name.trim().slice(0, 40);
  if (!clean || snapshot.collections[clean]) return null;
  if (Object.keys(snapshot.collections).length >= COLLECTION_LIMIT) return null;
  mutate(
    (current) => ({ collections: { ...current.collections, [clean]: [] } }),
    (next) => writeCollections(next.collections),
  );
  return clean;
}

export function deleteCollection(name: string): void {
  mutate(
    (current) => {
      const next = { ...current.collections };
      delete next[name];
      return { collections: next };
    },
    (next) => writeCollections(next.collections),
  );
}

/** One tap keeps or releases a look in a named collection; nothing is copied. */
export function toggleInCollection(name: string, id: string): readonly string[] {
  mutate(
    (current) => {
      const existing = current.collections[name];
      if (!existing) return {};
      const next = existing.includes(id)
        ? existing.filter((item) => item !== id)
        : [id, ...existing].slice(0, FAVOURITE_LIMIT);
      return { collections: { ...current.collections, [name]: next } };
    },
    (next) => writeCollections(next.collections),
  );
  return snapshot.collections[name] ?? [];
}

/** Removes every preference this app stores on this device. */
export function clearPreferences(): void {
  for (const key of [FAVOURITES_KEY, RECENTS_KEY, COLLECTIONS_KEY, STYLES_KEY]) {
    try {
      store()?.removeItem(key);
    } catch {
      /* nothing to forget */
    }
  }
  publish({ ...EMPTY });
}

/** Test seam: forget what is in memory without touching another browser's disk. */
export function resetPreferences(): void {
  publish({ ...EMPTY });
}
