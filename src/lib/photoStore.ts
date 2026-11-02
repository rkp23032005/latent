/**
 * The photograph the editor works on.
 *
 * `url` always points at the untouched original bytes. Nothing here is ever
 * mutated in place — later phases derive a separate output from `file`/`url`
 * so the original stays available for non-destructive editing.
 */
export type Photo = {
  readonly file: File;
  readonly url: string;
  readonly name: string;
  readonly bytes: number;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly orientation: 'portrait' | 'landscape' | 'square';
};

export type PhotoErrorCode = 'unsupported' | 'too-large' | 'undecodable' | 'empty';

export class PhotoError extends Error {
  constructor(
    readonly code: PhotoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PhotoError';
  }
}

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Generous, but a tab should not be taken down by a 400 MB raw file. */
export const MAX_BYTES = 40 * 1024 * 1024;

const ACCEPTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

/** Keeps the file dialogs and `isAccepted` agreeing. */
export const ACCEPT_ATTR = [
  ...ACCEPTED_TYPES,
  ...ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`),
].join(',');

let current: Photo | null = null;
/* Two drops in quick succession start two decodes; only the later one may
   replace the photograph, and the earlier one must not revoke its url. */
let generation = 0;

export function getCurrentPhoto(): Photo | null {
  return current;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatLabel(photo: Photo): string {
  return `${photo.width} × ${photo.height} px · ${formatBytes(photo.bytes)} · ${photo.mime
    .replace('image/', '')
    .toUpperCase()}`;
}

/**
 * Some browsers report an empty MIME string for WebP, and files dragged from
 * certain apps arrive with no type at all, so the extension is the fallback.
 */
export function isAccepted(file: File): boolean {
  if (ACCEPTED_TYPES.includes(file.type as (typeof ACCEPTED_TYPES)[number])) return true;
  if (file.type && !file.type.startsWith('image/')) return false;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ACCEPTED_EXTENSIONS.includes(ext);
}

function orientationOf(width: number, height: number): Photo['orientation'] {
  if (width === height) return 'square';
  return height > width ? 'portrait' : 'landscape';
}

/** Decodes through an <img> so a corrupt file fails here rather than on stage. */
function decode(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        reject(new PhotoError('undecodable', 'That file decoded to an empty image.'));
        return;
      }
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () =>
      reject(
        new PhotoError(
          'undecodable',
          'This file is damaged or uses a variant the browser cannot decode.',
        ),
      );
    img.src = url;
  });
}

/**
 * Validates, decodes and remembers a photograph. Throws PhotoError with a
 * message meant to be shown to the user verbatim.
 */
export async function loadPhotoFromFile(file: File): Promise<Photo> {
  if (!file) throw new PhotoError('empty', 'No file was received. Try selecting it again.');

  if (!isAccepted(file)) {
    throw new PhotoError(
      'unsupported',
      `${file.name || 'That file'} is not a JPEG, PNG or WebP photograph.`,
    );
  }

  if (file.size > MAX_BYTES) {
    throw new PhotoError(
      'too-large',
      `${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_BYTES)}.`,
    );
  }

  const ticket = ++generation;
  const url = URL.createObjectURL(file);

  let dimensions: { width: number; height: number };
  try {
    dimensions = await decode(url);
  } catch (error) {
    URL.revokeObjectURL(url);
    if (error instanceof PhotoError) throw error;
    throw new PhotoError('undecodable', `${file.name} could not be opened as a photograph.`);
  }

  if (ticket !== generation) {
    URL.revokeObjectURL(url);
    throw new PhotoError('empty', `${file.name} was replaced before it finished opening.`);
  }

  if (current) URL.revokeObjectURL(current.url);

  current = {
    file,
    url,
    name: file.name,
    bytes: file.size,
    mime: file.type || guessMimeFromName(file.name),
    ...dimensions,
    orientation: orientationOf(dimensions.width, dimensions.height),
  };

  return current;
}

function guessMimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}
