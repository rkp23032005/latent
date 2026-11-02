/**
 * Turn every accepted source's files into Preset records.
 *
 * The mapping itself is delegated to the app's own readers — `readXmp` /
 * `mapXmp` / `readCube` — so the build script cannot drift from what the editor
 * would do with the same file. This script only decides the honesty layer:
 *
 *   - a `.cube` never gets knob values it does not have — it is `unsupported`
 *     by construction, with the grid spelled out in `dropped`;
 *   - an `.xmp` is `full` only when nothing was left behind and the recipe
 *     actually moves pixels, `partial` when some settings had no equivalent, and
 *     `unsupported` when it maps to nothing or changes so little it is not a
 *     look — and in that last case we keep the file's own settings in `dropped`
 *     and empty its `adjust`, because a preset that changes nothing is a note,
 *     not a filter;
 *   - duplicates are caught by recipe fingerprint (so two sources with the same
 *     picture keep one card) and by repeated name within a source.
 *
 * It also writes the source ledger, which records the rejected sources we never
 * downloaded alongside the ones we did.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SOURCES, REJECTED_SOURCES, acceptedSources } from './sources.mjs';
import { readXmp, mapXmp, summarizeDropped } from '../../src/lib/preset/mapping.ts';
import { readCube, CUBE_LIMITATION } from '../../src/lib/preset/cube.ts';
import {
  PRESETS_CACHE,
  findExtractRoot,
  listMatchingFiles,
  effectOf,
  signatureOf,
  kebab,
  normalizedName,
  slug,
  categoryFromPath,
  composeDescription,
  loadManifest,
  readJson,
} from './import-lib.mjs';

const EFFECT_FLOOR = 0.75;
const UNSUPPORTED_LIMITATION =
  'None of this file’s settings can be reproduced with this engine’s knobs, so it is kept for reference only.';
const CUBE_DESCRIPTION =
  'A 3D colour look-up table — this engine grades with sliders and has no LUT stage, so it is recorded for reference only.';

function log(...args) {
  console.log('[import]', ...args);
}

/** A unique, schema-safe id: `<sourceId>-<kebab-name>` with a numeric suffix on collision. */
function makeId(sourceId, name, used) {
  const base = `${sourceId}-${kebab(name)}`.toLowerCase();
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function stemOf(relPath) {
  return path.basename(relPath).replace(/\.[^.]+$/, '');
}

function pickCategory(reading, manifest, relPath, groupFrom) {
  if (groupFrom === 'xmpGroup') {
    return reading.group || manifest?.category || categoryFromPath(relPath) || 'Uncategorised';
  }
  return manifest?.category || categoryFromPath(relPath) || 'Uncategorised';
}

/**
 * Decide an accepted source's final verdict now that acquire has run.
 * A source is importable only when its tree is present, matched files, and its
 * licence was verified. Otherwise it becomes a rejected ledger entry — and its
 * files are never read.
 */
function resolveSource(source, state) {
  const entry = state?.sources?.[source.sourceId];
  if (!entry) {
    return { source, verdict: 'rejected', reason: 'not acquired', root: null, files: [] };
  }
  if (!entry.present || entry.filesFound === 0) {
    return { source, verdict: 'rejected', reason: entry.error ?? 'not available', root: null, files: [] };
  }
  if (!entry.licenceVerified) {
    return { source, verdict: 'rejected', reason: 'licence could not be verified', root: null, files: [] };
  }
  const root = entry.root ?? findExtractRoot(path.join(PRESETS_CACHE, source.sourceId));
  const files = listMatchingFiles(root, source.pathFilter);
  return { source, verdict: 'imported', reason: 'accepted: licence verified', root, files, entry };
}

/* ------------------------------------------------------------------ *
 * Per-format builders. Each returns a finished Preset, or null when the
 * file was unreadable (counted as invalid by the caller).
 * ------------------------------------------------------------------ */

function buildXmpPreset(source, relPath, text, manifestMap) {
  const reading = readXmp(text);
  if (!reading) return { invalid: true };
  const m = mapXmp(reading);
  const measured = effectOf(m.adjust);
  const mappedLines = m.mapped.map((s) => `${s.from} → ${s.knob}`);
  const manifest = manifestMap.get(normalizeKey(relPath));
  const name = manifest?.name?.trim() || reading.name || stemOf(relPath);
  const category = pickCategory(reading, manifest, relPath, source.groupFrom);
  const grayscale = reading.grayscale || reading.monochrome;

  let support;
  let finalAdjust;
  let mappedField;
  let droppedField;
  let limitation;

  if (m.mapped.length === 0) {
    // Nothing became a knob value at all.
    support = 'unsupported';
    finalAdjust = {};
    mappedField = [];
    droppedField = m.dropped.length
      ? m.dropped
      : ['its settings did not read as any of this engine’s knobs'];
    limitation = UNSUPPORTED_LIMITATION;
  } else if (measured < EFFECT_FLOOR) {
    // It mapped, but the result is indistinguishable from doing nothing.
    support = 'unsupported';
    finalAdjust = {};
    mappedField = [];
    droppedField = [...mappedLines, ...m.dropped];
    limitation = UNSUPPORTED_LIMITATION;
  } else if (m.dropped.length === 0) {
    support = 'full';
    finalAdjust = m.adjust;
    mappedField = mappedLines;
    droppedField = [];
    limitation = m.limitations[0] ?? summarizeDropped([]);
  } else {
    support = 'partial';
    finalAdjust = m.adjust;
    mappedField = mappedLines;
    droppedField = m.dropped;
    limitation = m.limitations[0] ?? summarizeDropped(m.dropped);
  }

  const description = manifest?.description?.trim() || composeDescription(finalAdjust);
  const tags = [slug(category), support, 'imported'];
  if (grayscale) tags.push('monochrome');

  const sourceField = {
    sourceId: source.sourceId,
    licence: source.licence,
    origin: source.repository,
    file: relPath,
  };
  if (source.attribution) sourceField.attribution = source.attribution;

  return {
    preset: {
      id: null, // filled by the caller for collision handling
      name,
      category,
      description,
      adjust: finalAdjust,
      support,
      origin: 'imported',
      source: sourceField,
      mapped: mappedField,
      dropped: droppedField,
      limitation,
      tags,
      effect: Number(effectOf(finalAdjust).toFixed(2)),
    },
    signature: Object.keys(finalAdjust).length > 0 ? signatureOf(finalAdjust) : null,
    normalizedName: normalizedName(name),
  };
}

function buildCubePreset(source, relPath, text) {
  const reading = readCube(text);
  if (!reading.valid) return { invalid: true };
  const name = cubeName(reading.title, relPath);
  const category = categoryFromPath(relPath) || 'LUT';
  const droppedField = [
    `LUT_3D_SIZE ${reading.size} grid: ${reading.entries} sampled colours cannot be applied without a 3D LUT stage`,
  ];

  const sourceField = {
    sourceId: source.sourceId,
    licence: source.licence,
    origin: source.repository,
    file: relPath,
  };
  if (source.attribution) sourceField.attribution = source.attribution;

  return {
    preset: {
      id: null,
      name,
      category,
      description: CUBE_DESCRIPTION,
      adjust: {},
      support: 'unsupported',
      origin: 'imported',
      source: sourceField,
      mapped: [],
      dropped: droppedField,
      limitation: CUBE_LIMITATION,
      tags: [slug(category), 'unsupported', 'imported'],
      effect: 0,
    },
    // Empty adjust is not a look, so cubes are keyed only by name, never by
    // recipe signature — otherwise the first would swallow every later LUT.
    signature: null,
    normalizedName: normalizedName(name),
  };
}

function normalizeKey(p) {
  return p.split('\\').join('/').replace(/^\.\//, '');
}

/**
 * A cube's real identity is its file name. Many export tools stamp every LUT in
 * a pack with the same generic TITLE (e.g. "Generated by Resolve"), which would
 * make distinct looks collide in name-based de-duplication — so a generic title
 * loses to the stem, and a specific one (e.g. "slay Amber") wins.
 */
function cubeName(title, relPath) {
  const clean = title?.trim();
  const generic = !clean || /(generated? by|resolve|cube file|untitled)/i.test(clean);
  return generic ? stemOf(relPath) : clean;
}

/* ------------------------------------------------------------------ *
 * Main.
 * ------------------------------------------------------------------ */

function main() {
  const stateFile = path.join(PRESETS_CACHE, 'acquire-state.json');
  const state = readJson(stateFile);
  if (!state) log('no acquire-state.json — run acquire.mjs first; importing whatever is verifiable');

  const presets = [];
  const usedIds = new Set();
  const seenSignatures = new Map(); // signature -> first preset id
  const seenNames = new Map(); // `${sourceId}\0name` -> first preset id
  const perSource = [];

  let filesWalked = 0;
  let xmpRead = 0;
  let cubeRead = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const source of acceptedSources()) {
    const resolved = resolveSource(source, state);
    const tally = {
      sourceId: source.sourceId,
      verdict: resolved.verdict,
      reason: resolved.reason,
      filesFound: resolved.verdict === 'imported' ? resolved.files.length : state?.sources?.[source.sourceId]?.filesFound ?? 0,
      full: 0,
      partial: 0,
      unsupported: 0,
      invalid: 0,
      duplicates: 0,
      kept: 0,
      dropped: 0,
    };

    if (resolved.verdict !== 'imported') {
      perSource.push(tally);
      log(`${source.sourceId}: rejected (${resolved.reason})`);
      continue;
    }

    const manifestMap = source.manifest ? loadManifest(source.manifest, resolved.root) : new Map();

    for (const relPath of resolved.files) {
      filesWalked += 1;
      let result;
      try {
        const abs = path.join(resolved.root, relPath);
        const text = fs.readFileSync(abs, 'utf8');
        result = relPath.toLowerCase().endsWith('.cube')
          ? buildCubePreset(source, relPath, text)
          : buildXmpPreset(source, relPath, text, manifestMap);
        if (relPath.toLowerCase().endsWith('.cube')) cubeRead += 1;
        else xmpRead += 1;
      } catch (err) {
        // Unreadable file: count it, emit nothing.
        invalidCount += 1;
        tally.invalid += 1;
        log(`${source.sourceId}: could not read ${relPath}: ${err.message}`);
        continue;
      }

      if (result.invalid) {
        invalidCount += 1;
        tally.invalid += 1;
        continue;
      }

      // Duplicate detection: recipe fingerprint, then same-name-same-source.
      const nameKey = `${source.sourceId}\u0000${result.normalizedName}`;
      const sigKey = result.signature;
      if ((sigKey && seenSignatures.has(sigKey)) || seenNames.has(nameKey)) {
        duplicateCount += 1;
        tally.duplicates += 1;
        tally.dropped += 1;
        continue;
      }

      const preset = result.preset;
      preset.id = makeId(source.sourceId, preset.name, usedIds);
      presets.push(preset);
      if (sigKey) seenSignatures.set(sigKey, preset.id);
      seenNames.set(nameKey, preset.id);

      tally[preset.support] += 1;
      tally.kept += 1;
    }

    perSource.push(tally);
    log(
      `${source.sourceId}: kept=${tally.kept} full=${tally.full} partial=${tally.partial} unsupported=${tally.unsupported} invalid=${tally.invalid} dupes=${tally.duplicates}`,
    );
  }

  const counts = {
    full: presets.filter((p) => p.support === 'full').length,
    partial: presets.filter((p) => p.support === 'partial').length,
    unsupported: presets.filter((p) => p.support === 'unsupported').length,
    invalid: invalidCount,
  };

  const importedCount = perSource.filter((s) => s.verdict === 'imported').length;
  const rejectedCount =
    perSource.filter((s) => s.verdict === 'rejected').length + REJECTED_SOURCES.length;

  const report = {
    generatedAt: new Date().toISOString(),
    accepted: importedCount,
    rejected: rejectedCount,
    totals: {
      filesWalked,
      xmpRead,
      cubeRead,
      invalid: invalidCount,
      duplicates: duplicateCount,
      presetsEmitted: presets.length,
    },
    counts,
    perSource,
    notes: [
      'effect.ts is imported by the app, not here: at module load it builds its test chart with Math.floor(t*8), which reaches index 8 on the final column and throws before any export runs. import-lib.mjs reproduces that chart with the index clamped so Node can run it.',
    ],
  };

  writeImported(presets, report);
  writeSourcesReport(state, report);

  printSummary(report, counts);
}

function writeImported(presets, report) {
  const file = path.join(PRESETS_CACHE, 'imported.json');
  fs.writeFileSync(file, JSON.stringify({ presets, report }, null, 2));
  log('wrote', file);
}

/**
 * The source ledger: one SourceRecord per registry entry, accepted or rejected.
 * Rejected sources that were never downloaded appear here too, with filesFound 0
 * and the reason we refused them. presetsKept / presetsDropped come from the
 * same tallies the import loop built, so the two files can never disagree.
 */
function writeSourcesReport(state, report) {
  const tallies = new Map(report.perSource.map((t) => [t.sourceId, t]));
  const records = [];

  for (const source of SOURCES) {
    const entry = state?.sources?.[source.sourceId];
    const tally = tallies.get(source.sourceId);
    const imported = tally && tally.verdict === 'imported';
    records.push({
      sourceId: source.sourceId,
      repository: source.repository,
      licence: source.licence,
      licenceFile: imported ? entry?.licenceFile ?? '' : '',
      attribution: source.attribution ?? '',
      verdict: imported ? 'imported' : 'rejected',
      reason: tally?.reason ?? entry?.error ?? 'licence could not be verified',
      formats: source.formats,
      filesFound: imported ? tally.filesFound : 0,
      presetsKept: imported ? tally.kept : 0,
      presetsDropped: imported ? tally.invalid + tally.duplicates : 0,
      presetsInvalid: imported ? tally.invalid : 0,
      presetsDuplicates: imported ? tally.duplicates : 0,
    });
  }

  for (const source of REJECTED_SOURCES) {
    records.push({
      sourceId: source.sourceId,
      repository: source.repository,
      licence: source.licence,
      licenceFile: '',
      attribution: '',
      verdict: 'rejected',
      reason: source.reason,
      formats: source.formats,
      filesFound: 0,
      presetsKept: 0,
      presetsDropped: 0,
      presetsInvalid: 0,
      presetsDuplicates: 0,
    });
  }

  const file = path.join(PRESETS_CACHE, 'sources-report.json');
  fs.writeFileSync(file, JSON.stringify(records, null, 2));
  log('wrote', file);
}

function printSummary(report, counts) {
  console.log('');
  console.log('=== Preset import summary ===');
  console.log(`registry entries : ${SOURCES.length} accepted-eligible + ${REJECTED_SOURCES.length} pre-rejected`);
  console.log(`imported sources : ${report.accepted}`);
  console.log(`rejected sources : ${report.rejected} (licence/availability + pre-rejected)`);
  console.log(`files walked     : ${report.totals.filesWalked} (xmp ${report.totals.xmpRead}, cube ${report.totals.cubeRead})`);
  console.log(`emitted presets  : ${report.totals.presetsEmitted}`);
  console.log(`  full           : ${counts.full}`);
  console.log(`  partial        : ${counts.partial}`);
  console.log(`  unsupported    : ${counts.unsupported}`);
  console.log(`  invalid (skip) : ${report.totals.invalid}`);
  console.log(`  duplicates     : ${report.totals.duplicates}`);
  console.log('');
  for (const s of report.perSource) {
    console.log(` - ${s.sourceId}: ${s.verdict} — files ${s.filesFound}, kept ${s.kept} (full ${s.full}/partial ${s.partial}/unsupported ${s.unsupported}), invalid ${s.invalid}, dupes ${s.duplicates} — ${s.reason}`);
  }
}

main();
