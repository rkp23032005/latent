/**
 * Shared helpers for the acquisition and import scripts.
 *
 * Keeping this free of heavy lifting means acquire.mjs and import.mjs read as
 * straight-line stories; the fiddly bits (walking a tree, matching a glob,
 * making a stable id, measuring what a recipe does) live here once.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTROLS } from '../../src/lib/image/adjustments.ts';
import { effectOf, signatureOf } from '../../src/lib/preset/effect.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root: scripts/presets -> repo. */
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const PRESETS_CACHE = path.join(REPO_ROOT, '.cache', 'presets');

export const KNOWN_KNOB_IDS = new Set(CONTROLS.map((c) => c.id));

/* ------------------------------------------------------------------ *
 * Effect measurement.
 *
 * The numbers come from src/lib/preset/effect.ts — the same chart, the same
 * stage list and the same arithmetic the preview runs — so a card's
 * "measured change" is the engine's own answer, not a description of it.
 * ------------------------------------------------------------------ */

export { effectOf, signatureOf };

/* ------------------------------------------------------------------ *
 * Filesystem + globbing.
 * ------------------------------------------------------------------ */

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The directory the upstream repository actually lives in inside a source's
 * cache folder. A codeload tarball extracts to one `<repo>-<ref>/` folder; when
 * the folder itself is the content, we use it directly.
 */
export function findExtractRoot(sourceDir) {
  if (!fs.existsSync(sourceDir)) return null;
  const dirs = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  // A codeload tarball extracts to one `<repo>-<ref>/` folder; sibling files
  // such as the cached .tar.gz are ignored, so a lone directory is the root.
  if (dirs.length === 1) return path.join(sourceDir, dirs[0]);
  return sourceDir;
}

function walk(dir, root, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, root, out);
    else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

/** Compile a `**`/`*` glob into a RegExp anchored to the whole relative path. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches across directories (including none); bare `**` matches all.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Every file under root whose repo-relative path matches the filter. */
export function listMatchingFiles(root, filter) {
  if (!root || !fs.existsSync(root)) return [];
  const all = walk(root, root, []);
  if (typeof filter === 'function') return all.filter(filter);
  const rx = globToRegExp(filter);
  return all.filter((p) => rx.test(p));
}

/* ------------------------------------------------------------------ *
 * Naming.
 * ------------------------------------------------------------------ */

/** Lowercase, ASCII, hyphen-separated: `Portra 400` -> `portra-400`. */
export function kebab(name) {
  const out = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out.length > 0 ? out : 'preset';
}

/** Key for "same file name from the same source" duplicate detection. */
export function normalizedName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Slug for tags, derived from a category or support label. */
export function slug(value) {
  return kebab(String(value)).toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Category + description.
 * ------------------------------------------------------------------ */

/**
 * The directory that stands in for a group when a file carries no group name.
 * Emulsion stores presets under `Presets/<Group>/<Name>.xmp`, so the immediate
 * parent is the group. hstockeb nests `presets/<brand>/<Color|Monochrome>/`, so
 * when the parent is a colour/treatment folder the brand above it is the group.
 */
export function categoryFromPath(relPath) {
  const parts = relPath.split('/');
  const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
  if (/^(color|monochrome|mono|c|b&w|bw)$/i.test(parent) && parts.length >= 3) {
    return parts[parts.length - 3];
  }
  return parent;
}

const CONTROL_BY_ID = new Map(CONTROLS.map((c) => [c.id, c]));

/**
 * An honest one-liner built only from the knobs a recipe actually sets. It never
 * claims a film stock or camera is emulated — it says what the picture will do.
 */
export function composeDescription(adjust) {
  const active = Object.entries(adjust).filter(([id]) => CONTROL_BY_ID.has(id));
  if (active.length === 0) {
    return 'Recorded for reference: none of its settings could be reproduced with these knobs.';
  }
  const list = active.map(([id, value]) => {
    const control = CONTROL_BY_ID.get(id);
    return `${control.label} ${control.format(value)}`;
  });
  return `Adjusts the picture with ${list.join(', ')}.`;
}

/**
 * Load a machine-readable sidecar for a source, returning a map keyed by
 * repo-relative file path to { name, category, description }. Best-effort: if
 * the sidecar is absent or shaped unexpectedly we return an empty map and let
 * the importer fall back to the XMP attributes and file path.
 */
export function loadManifest(kind, root) {
  const map = new Map();
  if (!root) return map;
  try {
    if (kind === 'emulsion') {
      const data = readJson(path.join(root, 'presets.json'));
      for (const p of data?.presets ?? []) {
        if (!p.file) continue;
        map.set(normalizeRel(p.file), {
          name: p.name ?? null,
          category: p.category ?? null,
          description: p.description ?? null,
        });
      }
    } else if (kind === 'hstockeb') {
      // site/looks.json groups presets into families; each family has a name and
      // a list of { name, preset } where `preset` is a URL-encoded repo path.
      // There is no per-look blurb, so we only borrow names + family categories
      // and let the importer compose the description from the knobs.
      const data = readJson(path.join(root, 'site', 'looks.json'));
      const families = data?.families ? Object.values(data.families) : [];
      for (const family of families) {
        for (const look of family?.looks ?? []) {
          const file = look.preset ?? look.file ?? look.path;
          if (!file) continue;
          map.set(decodeURIComponent(normalizeRel(file)), {
            name: look.name ?? look.title ?? null,
            category: family.name ?? null,
            description: look.description ?? look.blurb ?? null,
          });
        }
      }
    }
  } catch {
    /* Sidecar is optional; the files themselves always carry the settings. */
  }
  return map;
}

function normalizeRel(p) {
  return p.split('\\').join('/').replace(/^\.\//, '');
}
