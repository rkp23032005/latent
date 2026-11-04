/**
 * Saved edits, kept on this device.
 *
 * A project is a recipe, a name and the facts needed to recognise the file it
 * was made for. It is deliberately not a copy of the photograph: image bytes
 * are large, they already live in the user's folders, and a browser database is
 * the wrong place to keep a second original. Restoring therefore has one honest
 * condition — the matching file has to be uploaded again — which the interface
 * says plainly instead of failing silently.
 */

import {
  CONTROLS,
  IDENTITY,
  clampToControl,
  type AdjustmentId,
  type Adjustments,
} from './image/adjustments';
import { clampCrop } from './image/crop';
import type { Photo } from './photoStore';
import type { EditingSnapshot } from './useAdjustments';

const DB_NAME = 'latent-studio';
const DB_VERSION = 1;
const STORE = 'projects';
const SCHEMA = 1;

export type ProjectPhoto = {
  name: string;
  bytes: number;
  mime: string;
  width: number;
  height: number;
  lastModified: number;
};

export type Project = {
  /** Fingerprint of the source file; one saved edit per photograph. */
  id: string;
  schema: number;
  name: string;
  photo: ProjectPhoto;
  editing: EditingSnapshot;
  /** Display name at the time of saving; the id is the actual reference. */
  presetName: string | null;
  savedAt: number;
};

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

/**
 * Enough to recognise the same file: its name, byte length and pixel size. The
 * timestamp is left out on purpose — copying a file to another folder can
 * change it, and the same photograph should still find its recipe. No pixel
 * content is read to build this.
 */
export function fingerprint(photo: Photo): string {
  return [photo.name, photo.bytes, photo.width, photo.height].join('|');
}

export function defaultProjectName(photo: Photo): string {
  return photo.name.replace(/\.[^.]+$/, '').trim() || 'Untitled edit';
}

export function newProject(
  photo: Photo,
  editing: EditingSnapshot,
  name: string,
  presetName: string | null,
): Project {
  return {
    id: fingerprint(photo),
    schema: SCHEMA,
    name: name.trim().slice(0, 120) || defaultProjectName(photo),
    photo: {
      name: photo.name,
      bytes: photo.bytes,
      mime: photo.mime,
      width: photo.width,
      height: photo.height,
      lastModified: photo.file.lastModified,
    },
    editing,
    presetName,
    savedAt: Date.now(),
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new ProjectError('This browser does not offer local project storage.'));
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      reject(new ProjectError('Local project storage could not be opened on this device.'));
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      /* Another tab asking to upgrade must not be blocked by this one. */
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () =>
      reject(
        new ProjectError(
          'Local project storage could not be opened. Private browsing can refuse the device database.',
        ),
      );
  });
}

function ask<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new ProjectError('The local project database refused the request.'));
  });
}

function settlement(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(new ProjectError('The edit could not be saved on this device. The database refused the write.'));
    tx.onabort = () =>
      reject(new ProjectError('The edit could not be saved on this device. The write was cancelled.'));
  });
}

function clampRecipe(source: unknown): Adjustments {
  const record = source as Record<string, unknown> | null;
  const out: Record<AdjustmentId, number> = { ...IDENTITY };
  for (const control of CONTROLS) {
    const value = record?.[control.id];
    out[control.id] =
      typeof value === 'number' && Number.isFinite(value)
        ? clampToControl(control.id, value)
        : IDENTITY[control.id];
  }
  return out;
}

function normaliseEditing(value: unknown): EditingSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as {
    chosen?: unknown;
    intensity?: unknown;
    offsets?: unknown;
    skinGuard?: unknown;
    crop?: unknown;
  };

  let chosen: EditingSnapshot['chosen'] = null;
  const candidate = raw.chosen as { presetId?: unknown; recipe?: unknown } | null | undefined;
  if (
    candidate &&
    typeof candidate === 'object' &&
    typeof candidate.presetId === 'string' &&
    candidate.recipe &&
    typeof candidate.recipe === 'object'
  ) {
    chosen = { presetId: candidate.presetId, recipe: clampRecipe(candidate.recipe) };
  }

  const intensity =
    typeof raw.intensity === 'number' && Number.isFinite(raw.intensity)
      ? Math.min(100, Math.max(0, raw.intensity))
      : 100;

  return {
    chosen,
    intensity,
    /* A project saved before the skin guard existed has no field for it, and
       the answer to that is off rather than a guess at a level. */
    skinGuard:
      typeof raw.skinGuard === 'number' && Number.isFinite(raw.skinGuard)
        ? Math.min(100, Math.max(0, raw.skinGuard))
        : 0,
    offsets: raw.offsets && typeof raw.offsets === 'object' ? clampRecipe(raw.offsets) : { ...IDENTITY },
    /* A project saved before framing existed has no field for it, and the answer
       to that is the whole photograph rather than a guess at a window. */
    crop: clampCrop(raw.crop),
  };
}

/** Unknown database content is treated as untrusted and rebuilt field by field. */
function normaliseProject(value: unknown): Project | null {
  const raw = value as Partial<Project> | null;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schema !== SCHEMA) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;

  const photo = raw.photo as Partial<ProjectPhoto> | null | undefined;
  if (
    !photo ||
    typeof photo.name !== 'string' ||
    typeof photo.width !== 'number' ||
    typeof photo.height !== 'number'
  ) {
    return null;
  }

  const editing = normaliseEditing(raw.editing);
  if (!editing) return null;

  return {
    id: raw.id,
    schema: SCHEMA,
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.slice(0, 120)
        : photo.name.replace(/\.[^.]+$/, ''),
    photo: {
      name: photo.name,
      bytes: typeof photo.bytes === 'number' && Number.isFinite(photo.bytes) ? photo.bytes : 0,
      mime: typeof photo.mime === 'string' ? photo.mime : 'image/jpeg',
      width: photo.width,
      height: photo.height,
      lastModified:
        typeof photo.lastModified === 'number' && Number.isFinite(photo.lastModified)
          ? photo.lastModified
          : 0,
    },
    editing,
    presetName: typeof raw.presetName === 'string' ? raw.presetName : null,
    savedAt:
      typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
  };
}

export async function listProjects(): Promise<Project[]> {
  const db = await open();
  try {
    const rows = await ask(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    return rows
      .map(normaliseProject)
      .filter((project): project is Project => project !== null)
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError('Saved edits could not be read from this device.');
  } finally {
    db.close();
  }
}

export async function saveProject(project: Project): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await ask(tx.objectStore(STORE).put(project));
    await settlement(tx);
  } finally {
    db.close();
  }
}

export async function deleteProject(id: string): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await ask(tx.objectStore(STORE).delete(id));
    await settlement(tx);
  } finally {
    db.close();
  }
}
