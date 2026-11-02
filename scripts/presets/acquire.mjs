/**
 * Fetch, extract and licence-verify each accepted source.
 *
 * The order matters: nothing is trusted until its licence text is on disk and
 * matches the markers we expect. A source that is already extracted (emulsion
 * was fetched by hand) is verified in place rather than re-downloaded, and a
 * source whose licence cannot be confirmed is marked rejected so the importer
 * will not touch a byte of it.
 *
 * Rejected sources in the registry are never seen here — this loop reads only
 * the accepted list. They are reported by import.mjs instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { acceptedSources, isLicenceAcceptable } from './sources.mjs';
import { PRESETS_CACHE, findExtractRoot, listMatchingFiles } from './import-lib.mjs';

const STATE_FILE = path.join(PRESETS_CACHE, 'acquire-state.json');
const LICENCE_EXCERPT = 2000;

function log(...args) {
  console.log('[acquire]', ...args);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Stream a tarball to disk. `fetch` gives us a web ReadableStream on res.body,
 * which Readable.fromWeb adapts for node:stream/promises so back-pressure is
 * respected on the ~36 MB packs.
 */
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  ensureDir(path.dirname(dest));
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

/** Extract a `.tar.gz` into `dir` with the system tar (bsdtar or GNU tar). */
function extract(tarPath, dir) {
  ensureDir(dir);
  // Pass tar a path relative to cwd: GNU tar under Git Bash reads a Windows
  // `C:\...` argument as `host:path` and tries to connect to the "host" C:.
  const res = spawnSync('tar', ['-xzf', path.basename(tarPath), '-C', '.'], {
    cwd: dir,
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error(`tar exited with status ${res.status}`);
}

/**
 * Find the licence file: prefer LICENSE/LICENCE/LICENSE.md/COPYING at the root,
 * then fall back to a case-insensitive scan of the root and one directory level.
 */
function findLicenceFile(root) {
  if (!root) return null;
  const preferred = ['LICENSE', 'LICENCE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'COPYING.md'];
  for (const name of preferred) {
    const abs = path.join(root, name);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  const names = new Set(
    fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
  );
  const hit = [...names].find((n) => /^licen[cs]e|^copying|^unlicense/i.test(n));
  if (hit) return path.join(root, hit);
  // One level down: a codeload root occasionally nests the licence in a folder.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(root, entry.name);
    const inSub = fs
      .readdirSync(sub)
      .find((n) => /^licen[cs]e|^copying|^unlicense/i.test(n));
    if (inSub) return path.join(sub, inSub);
  }
  return null;
}

/** Every marker must appear in the licence text, case-insensitively. */
function markersMatch(text, markers) {
  const lower = text.toLowerCase();
  return markers.every((m) => lower.includes(m.toLowerCase()));
}

async function acquireOne(source) {
  const sourceDir = path.join(PRESETS_CACHE, source.sourceId);
  const record = {
    sourceId: source.sourceId,
    licence: source.licence,
    present: false,
    downloaded: false,
    root: null,
    licenceFile: null,
    licenceVerified: false,
    licenceExcerpt: null,
    filesFound: 0,
    error: null,
  };

  ensureDir(sourceDir);
  let root = findExtractRoot(sourceDir);

  // "Present" means the tree is there AND has files we would actually import.
  const hasContent =
    root && listMatchingFiles(root, source.pathFilter).length > 0;

  if (hasContent) {
    record.present = true;
    record.root = root;
    log(source.sourceId, 'already on disk, skipping download');
  } else if (!source.tarball) {
    record.error = 'no cached tree and no tarball in the registry';
    log(source.sourceId, record.error);
    return record;
  } else {
    // Download to a cache file, then extract into the source directory.
    const tarPath = path.join(sourceDir, `${source.sourceId}.tar.gz`);
    try {
      if (fs.existsSync(tarPath) && fs.statSync(tarPath).size > 0) {
        log(source.sourceId, 'tarball already cached, skipping fetch');
      } else {
        log(source.sourceId, 'fetching', source.tarball);
        await download(source.tarball, tarPath);
      }
      extract(tarPath, sourceDir);
      root = findExtractRoot(sourceDir);
      record.present = true;
      record.downloaded = true;
      record.root = root;
      log(source.sourceId, 'extracted');
    } catch (err) {
      record.error = `download/extract failed: ${err.message}`;
      record.present = false;
      log(source.sourceId, record.error);
      return record;
    }
  }

  const files = root ? listMatchingFiles(root, source.pathFilter) : [];
  record.filesFound = files.length;
  if (files.length === 0) {
    record.error = 'no source files matched the path filter';
    return record;
  }

  // Licence verification. A source is importable only if this passes.
  const licenceFile = findLicenceFile(root);
  if (!licenceFile) {
    record.error = 'licence could not be verified';
    log(source.sourceId, 'no licence file found — rejecting');
    return record;
  }
  let text;
  try {
    text = fs.readFileSync(licenceFile, 'utf8');
  } catch {
    record.error = 'licence could not be verified';
    return record;
  }
  record.licenceFile = path.relative(root, licenceFile).split(path.sep).join('/');
  record.licenceExcerpt = text.slice(0, LICENCE_EXCERPT);

  if (!isLicenceAcceptable(source.licence) || !markersMatch(text, source.licenceMarkers)) {
    record.error = 'licence could not be verified';
    record.licenceVerified = false;
    log(source.sourceId, 'licence markers did not match — rejecting');
    return record;
  }

  record.licenceVerified = true;
  log(source.sourceId, 'licence verified:', record.licenceFile);
  return record;
}

async function main() {
  ensureDir(PRESETS_CACHE);
  const sources = acceptedSources();
  const state = { generatedAt: new Date().toISOString(), sources: {} };

  for (const source of sources) {
    // Defensive: never download a source we would not accept on licence alone.
    if (!isLicenceAcceptable(source.licence)) continue;
    state.sources[source.sourceId] = await acquireOne(source);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  const summary = Object.values(state.sources).map((s) => {
    const status = s.licenceVerified ? 'verified' : s.error ?? 'not verified';
    return `${s.sourceId}: present=${s.present} files=${s.filesFound} licence=${status}`;
  });
  log('state written to', STATE_FILE);
  for (const line of summary) log(' -', line);
}

main().catch((err) => {
  console.error('[acquire] fatal:', err);
  process.exit(1);
});
