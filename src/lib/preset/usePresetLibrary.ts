import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { PresetLibrary } from './schema.ts';
import { loadLibrary } from './library.ts';
import {
  clearPreferences,
  createCollection,
  deleteCollection,
  preferencesSnapshot,
  rememberRecent,
  rememberStyle,
  subscribePreferences,
  toggleFavourite,
  toggleInCollection,
} from './preferences.ts';

export type LibraryState = {
  status: 'loading' | 'ready' | 'error';
  library: PresetLibrary | null;
  error: string | null;
  retry: () => void;
  favourites: readonly string[];
  recent: readonly string[];
  collections: Readonly<Record<string, readonly string[]>>;
  styles: readonly string[];
  favourite: (id: string) => void;
  remember: (id: string) => void;
  recallStyle: (label: string) => void;
  keep: (collection: string, id: string) => void;
  addCollection: (name: string) => string | null;
  removeCollection: (name: string) => void;
  forget: () => void;
};

/**
 * Fetches the catalogue once per session and reads the user's own marks from the
 * one store that holds them. Every panel calling this hook sees the same
 * favourites and history immediately, because there is nothing per-panel to go
 * out of date. The retry exists because a catalogue that fails to read should
 * not leave the editor looking permanently empty: it is a file, and asking for it
 * again is a reasonable thing for the interface to offer.
 */
export function usePresetLibrary(): LibraryState {
  const [library, setLibrary] = useState<PresetLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const prefs = useSyncExternalStore(subscribePreferences, preferencesSnapshot, preferencesSnapshot);

  useEffect(() => {
    let alive = true;
    loadLibrary().then(
      (next) => {
        if (!alive) return;
        setLibrary(next);
        setError(null);
      },
      (reason: unknown) => {
        if (!alive) return;
        setError(reason instanceof Error ? reason.message : 'The presets could not be read.');
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return {
    status: library ? 'ready' : error ? 'error' : 'loading',
    library,
    error,
    retry,
    favourites: prefs.favourites,
    recent: prefs.recent,
    collections: prefs.collections,
    styles: prefs.styles,
    favourite: toggleFavourite,
    remember: rememberRecent,
    recallStyle: rememberStyle,
    keep: toggleInCollection,
    addCollection: createCollection,
    removeCollection: deleteCollection,
    forget: clearPreferences,
  };
}
