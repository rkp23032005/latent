import { useCallback, useMemo, useRef, useState } from 'react';
import { getCurrentPhoto, loadPhotoFromFile, PhotoError, type Photo } from './photoStore';

export type WorkspaceStatus = 'empty' | 'loading' | 'ready' | 'invalid' | 'failed';

/**
 * Owns the photograph plus the five states the workspace has to express.
 *
 * A rejected file never destroys a good photograph that is already on the
 * stage — the error surfaces alongside it instead.
 */
export function usePhotoLoader() {
  const [photo, setPhoto] = useState<Photo | null>(() => getCurrentPhoto());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PhotoError | null>(null);
  /* A slower first decode must not land after a faster second one. */
  const latest = useRef(0);

  const load = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadPhotoFromFile(file);
      if (ticket === latest.current) setPhoto(next);
    } catch (e) {
      if (ticket !== latest.current) return;
      setError(
        e instanceof PhotoError
          ? e
          : new PhotoError('undecodable', 'Something went wrong while reading that file.'),
      );
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  const status: WorkspaceStatus = useMemo(() => {
    if (loading) return 'loading';
    if (error && !photo) return error.code === 'unsupported' ? 'invalid' : 'failed';
    if (photo) return 'ready';
    return 'empty';
  }, [loading, error, photo]);

  return { photo, status, error, load, dismissError };
}
