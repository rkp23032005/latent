import { useCallback, useEffect, useState } from 'react';
import type { PresetLibrary } from './schema.ts';
import { loadLibrary, readFavourites, readRecent, toggleFavourite, rememberRecent } from './library.ts';

export type LibraryState = {
  status: 'loading' | 'ready' | 'error';
  library: PresetLibrary | null;
  error: string | null;
  retry: () => void;
  favourites: string[];
  recent: string[];
  favourite: (id: string) => void;
  remember: (id: string) => void;
};

/**
 * Fetches the catalogue once per session and keeps the user's own marks beside
 * it. The retry exists because a catalogue that fails to read should not leave
 * the editor looking permanently empty: it is a file, and asking for it again is
 * a reasonable thing for the interface to offer.
 */
export function usePresetLibrary(): LibraryState {
  const [library, setLibrary] = useState<PresetLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [favourites, setFavourites] = useState<string[]>(readFavourites);
  const [recent, setRecent] = useState<string[]>(readRecent);

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

  const favourite = useCallback((id: string) => setFavourites(toggleFavourite(id)), []);
  const remember = useCallback((id: string) => setRecent(rememberRecent(id)), []);

  return {
    status: library ? 'ready' : error ? 'error' : 'loading',
    library,
    error,
    retry,
    favourites,
    recent,
    favourite,
    remember,
  };
}
