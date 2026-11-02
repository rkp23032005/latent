#!/usr/bin/env node
/**
 * Builds the catalogue the app reads.
 *
 * The importer and the generator each write a pile of presets into
 * `.cache/presets`. This merges them, re-measures every recipe with the app's own
 * engine (not with a number the producer claimed), throws away what is
 * duplicated or does nothing, and writes three things into `public/presets`:
 * the library the browser fetches, a machine-readable licence manifest, and the
 * notices a person can open. The upstream files themselves stay in the cache —
 * only the derived recipes and their paperwork ship with the app, so nothing in
 * the editor depends on a website still being online.
 *
 * Usage: node scripts/presets/build-library.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTROLS, IDENTITY, clampToControl } from '../../src/lib/image/adjustments.ts';
import { effectOf, signatureOf } from '../../src/lib/preset/effect.ts';
import { findExtractRoot, kebab } from './import-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(ROOT, '.cache', 'presets');
const OUT = path.join(ROOT, 'public', 'presets');

const VERSION = 1;
const SAMPLE = '/photography/landscape-highlands.jpg';
/** An original look that changes less than this is a rounding error, not a look. */
const MIN_GENERATED_EFFECT = 1.5;
/** Below this a change is on the edge of visible; it is labelled, not hidden. */
const SUBTLE_EFFECT = 1;

const SUPPORT = new Set(['full', 'partial', 'unsupported', 'invalid']);
const KNOBS = new Map(CONTROLS.map((control) => [control.id, control]));

/**
 * Imported families keep their own names, but the upstream spellings are
 * inconsistent ("luts", "LUT", "Video LUT Reference") and some folders name a
 * single film maker rather than a kind of look. This folds them into one
 * readable set of chips without pretending a source said something it did not.
 */
const IMPORTED_CATEGORIES = new Map(
  Object.entries({
    'Alternative Processes': 'Alternative processes',
    'Black & White Film': 'Black and white film',
    'Color Negative Film': 'Colour negative film',
    'Slide / E-6 Film': 'Slide film',
    'Creative / Cinematic': 'Cinematic',
    'Historical Decade': 'Historical decades',
    'Genre-Specific': 'By genre',
    'Geographic & Cultural': 'By place',
    'Mobile & Social Media': 'Social media photography',
    'Photographer Styles': 'Named styles',
    'Seasonal & Holiday': 'Seasonal',
    'Utility & Tools': 'Utility',
    'Video LUT Reference': 'Video LUT',
    LUT: 'Video LUT',
    luts: 'Video LUT',
    Fuji: 'Film makers',
    Kodak: 'Film makers',
    Ilford: 'Film makers',
    Leica: 'Camera makers',
    'Modern Trends': 'Trends',
    Personal: 'Personal',
  }),
);

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : [];
}

function cleanTags(value) {
  const seen = new Set();
  for (const tag of strings(value)) seen.add(tag.toLowerCase().trim());
  return [...seen].filter(Boolean).slice(0, 12);
}

/** Only knobs this engine owns, clamped to their range, resting values removed. */
function cleanAdjust(raw) {
  const adjust = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    const control = KNOBS.get(id);
    if (!control || typeof value !== 'number' || !Number.isFinite(value)) continue;
    const clamped = clampToControl(id, value);
    if (clamped === IDENTITY[id]) continue;
    adjust[id] = round2(clamped);
  }
  return adjust;
}

function categoryFor(preset) {
  const category = String(preset.category ?? '').trim();
  if (preset.origin === 'generated') return category || 'Original';
  return IMPORTED_CATEGORIES.get(category) ?? category ?? 'Imported';
}

function sourceFor(preset) {
  const raw = preset.source ?? {};
  const sourceId = String(raw.sourceId ?? (preset.origin === 'generated' ? 'generated' : 'unknown'));
  const next = {
    sourceId,
    licence: String(raw.licence ?? 'unspecified'),
    origin: String(raw.origin ?? 'Not recorded'),
  };
  if (typeof raw.file === 'string' && raw.file) next.file = raw.file;
  if (typeof raw.attribution === 'string' && raw.attribution) next.attribution = raw.attribution;
  return next;
}

/**
 * One preset in, either a preset out or the reason it is not in the catalogue.
 * Nothing is quietly dropped: every rejection is counted and printed.
 */
function normalise(raw, problems) {
  const reject = (reason) => {
    problems.push({ id: String(raw?.id ?? '(missing id)'), reason });
    return null;
  };

  if (!raw || typeof raw !== 'object') return reject('not an object');
  const name = String(raw.name ?? '').trim();
  if (!name) return reject('no name');

  const id = /^[a-z0-9][a-z0-9-]*$/.test(String(raw.id ?? ''))
    ? String(raw.id)
    : `${kebab(String(raw.source?.sourceId ?? 'preset'))}-${kebab(name)}`;

  const origin = raw.origin === 'generated' ? 'generated' : 'imported';
  const adjust = cleanAdjust(raw.adjust);
  const knobs = Object.keys(adjust);
  const effect = round2(effectOf(adjust));
  const mapped = strings(raw.mapped);
  const dropped = strings(raw.dropped);
  const limitation = typeof raw.limitation === 'string' ? raw.limitation.trim() : '';

  let support = SUPPORT.has(raw.support) ? raw.support : knobs.length > 0 ? 'partial' : 'unsupported';
  if (support === 'invalid') return reject('declared invalid by its producer');

  /* A card may not claim to work when the engine says nothing would change. */
  if (knobs.length === 0) support = 'unsupported';
  if (effect === 0) support = 'unsupported';
  if (support === 'full' && dropped.length > 0) support = 'partial';
  if (origin === 'generated' && effect < MIN_GENERATED_EFFECT) {
    return reject(`measured ${effect} of 255, under the ${MIN_GENERATED_EFFECT} floor for originals`);
  }

  const tags = cleanTags(raw.tags);
  if (effect > 0 && effect < SUBTLE_EFFECT) tags.push('subtle');
  if (origin === 'imported') tags.push('imported');

  const preset = {
    id,
    name,
    category: categoryFor({ category: raw.category, origin }),
    description: String(raw.description ?? '').trim() || `${name} — ${knobs.length} of ${KNOBS.size} knobs.`,
    adjust,
    support,
    origin,
    source: sourceFor({ origin, source: raw.source }),
    mapped,
    dropped,
    tags: [...new Set(tags)],
    effect,
  };
  if (limitation && !(support === 'full' && dropped.length === 0)) preset.limitation = limitation;
  else if (support === 'unsupported' && knobs.length === 0) {
    preset.limitation = 'Nothing in this file maps to a knob this engine has.';
  } else if (support === 'unsupported') {
    preset.limitation = 'Measured against the test chart, this recipe changes no pixels.';
  }
  return preset;
}

/**
 * The same recipe arrived twice — same knobs, different wrapper. The first one
 * in wins, because the walk is ordered by source priority and originals come
 * last: provenance is worth more than a second copy.
 */
function dedupe(presets, problems) {
  const bySignature = new Map();
  const kept = [];
  for (const preset of presets) {
    if (preset.support === 'unsupported') {
      kept.push(preset);
      continue;
    }
    const key = signatureOf(preset.adjust);
    const first = bySignature.get(key);
    if (first) {
      problems.push({ id: preset.id, reason: `same recipe as ${first}, kept once` });
      continue;
    }
    bySignature.set(key, preset.id);
    kept.push(preset);
  }
  return kept;
}

/**
 * Featured means "try this one first", so it is a rule rather than a mood:
 * whatever the generator curated, plus in each category the look whose measured
 * change sits nearest the middle of that category — a representative, not the
 * loudest.
 */
function markFeatured(presets) {
  const byCategory = new Map();
  for (const preset of presets) {
    if (preset.support === 'unsupported') continue;
    const list = byCategory.get(preset.category) ?? [];
    list.push(preset);
    byCategory.set(preset.category, list);
  }
  for (const list of byCategory.values()) {
    if (list.length < 3) continue;
    const effects = list.map((preset) => preset.effect).sort((a, b) => a - b);
    const median = effects[Math.floor(effects.length / 2)];
    let nearest = list[0];
    for (const preset of list) {
      if (Math.abs(preset.effect - median) < Math.abs(nearest.effect - median)) nearest = preset;
    }
    if (!nearest.tags.includes('featured')) nearest.tags = [...nearest.tags, 'featured'];
  }
}

function countsBy(presets, key) {
  const counts = new Map();
  for (const preset of presets) {
    const value = typeof key === 'function' ? key(preset) : preset[key];
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function copyLicences(sources, shippedBySource) {
  const dir = path.join(OUT, 'licences');
  fs.mkdirSync(dir, { recursive: true });
  const notices = [];
  for (const source of sources.filter((entry) => entry.verdict === 'imported')) {
    const root = findExtractRoot(path.join(CACHE, source.sourceId));
    const file = root ? path.join(root, source.licenceFile || 'LICENSE') : null;
    if (!file || !fs.existsSync(file)) {
      notices.push({ ...source, noticeFile: null, note: 'licence text not found in the cache' });
      continue;
    }
    const target = path.join(dir, `${source.sourceId}.txt`);
    fs.copyFileSync(file, target);
    notices.push({ ...source, noticeFile: `licences/${source.sourceId}.txt`, shipped: shippedBySource.get(source.sourceId) ?? 0 });
  }
  return notices;
}

function noticesMarkdown(notices, rejected, stats) {
  const lines = [
    '# Preset sources and licences',
    '',
    `Built by \`scripts/presets/build-library.mjs\` on ${stats.builtAt}. ` +
      `${stats.read} entries ship in \`public/presets/library.json\`: ` +
      `${stats.usable} can be reproduced by this engine, and ${stats.unsupported} were read ` +
      'but need stages it does not have. Those are listed in the browser as reference only, so the count stays honest.',
    '',
    'Every accepted source was checked against the licence text on disk before it was',
    'read, and only these SPDX ids are ever accepted: MIT, CC0-1.0, CC-BY-4.0,',
    'Apache-2.0, BSD-3-Clause, Unlicense. The full licence text of each source is',
    'copied next to this file.',
    '',
    '## Accepted sources',
    '',
  ];
  for (const notice of notices) {
    lines.push(
      `### ${notice.sourceId}`,
      '',
      `- Repository: ${notice.repository}`,
      `- Licence: ${notice.licence} (${notice.licenceFile || 'LICENSE'})`,
      notice.noticeFile
        ? `- Licence text shipped with this app: \`public/presets/${notice.noticeFile}\``
        : `- Licence text: ${notice.note ?? 'not shipped'}`,
      `- Formats: ${notice.formats.join(', ')}`,
      `- Files read: ${notice.filesFound} · looks shipped: ${notice.shipped ?? 0} · invalid: ${notice.presetsInvalid} · duplicates: ${notice.presetsDuplicates}`,
      notice.attribution ? `- Required notice: ${notice.attribution}` : '- Required notice: none beyond the licence text above.',
      `- Why accepted: ${notice.reason}`,
      '',
    );
  }
  lines.push(
    '## Refused sources',
    '',
    'Not downloaded, not read, not mixed in. Recorded here because a silent omission',
    'would look like an omission of the research rather than of the files.',
    '',
    '| Source | Licence | Reason |',
    '| --- | --- | --- |',
  );
  for (const entry of rejected) {
    lines.push(`| ${entry.repository} | ${entry.licence} | ${entry.reason} |`);
  }
  lines.push(
    '',
    '## Original looks',
    '',
    `The remaining looks (${stats.generated}) were written by this project's own script and`,
    'measured with this project’s own engine. They are recipes for the engine’s own knobs; they do',
    'not reproduce, claim to reproduce, or depend on any proprietary camera profile,',
    'film simulation or vendor preset, and they carry no third-party attribution.',
    '',
  );
  return lines.join('\n');
}

/**
 * A refused source is still a source we looked at: its record ships in the
 * catalogue so the interface can say how many were refused, not only how many
 * were accepted. The numbers stay at zero because nothing was read.
 */
function sourceRecord(entry) {
  return {
    sourceId: String(entry.sourceId ?? 'unknown'),
    repository: String(entry.repository ?? ''),
    licence: String(entry.licence ?? 'unspecified'),
    licenceFile: String(entry.licenceFile ?? 'LICENSE'),
    attribution: String(entry.attribution ?? ''),
    verdict: entry.verdict === 'imported' ? 'imported' : 'rejected',
    reason: String(entry.reason ?? ''),
    formats: strings(entry.formats),
    filesFound: Number(entry.filesFound) || 0,
    presetsKept: Number(entry.presetsKept) || 0,
    presetsDropped: Number(entry.presetsDropped) || 0,
    presetsInvalid: Number(entry.presetsInvalid) || 0,
    presetsDuplicates: Number(entry.presetsDuplicates) || 0,
  };
}

function main() {
  const imported = readJson(path.join(CACHE, 'imported.json'));
  const generated = readJson(path.join(CACHE, 'generated.json'));
  const report = readJson(path.join(CACHE, 'sources-report.json'));

  const missing = [
    ['imported.json', imported],
    ['generated.json', generated],
    ['sources-report.json', report],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    console.error(`[build] missing ${missing.join(', ')} — run npm run presets:update first.`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(ROOT, 'public', SAMPLE))) {
    console.error(`[build] the sample photograph ${SAMPLE} is not in public/.`);
    process.exit(1);
  }

  const problems = [];
  const raw = [...imported.presets, ...generated.presets];
  const normalised = raw.map((preset) => normalise(preset, problems)).filter((preset) => preset !== null);
  const presets = dedupe(normalised, problems);
  markFeatured(presets);

  presets.sort((a, b) => {
    const category = a.category.localeCompare(b.category);
    if (category !== 0) return category;
    if (a.support !== b.support) return a.support === 'unsupported' ? 1 : -1;
    return b.effect - a.effect || a.name.localeCompare(b.name);
  });

  const counts = { full: 0, partial: 0, unsupported: 0, invalid: 0 };
  for (const preset of presets) counts[preset.support] += 1;

  const shippedBySource = countsBy(presets, (preset) => preset.source.sourceId);
  const sources = (Array.isArray(report) ? report : (report.sources ?? [])).map(sourceRecord);
  const accepted = sources.filter((entry) => entry.verdict === 'imported');
  const rejected = sources.filter((entry) => entry.verdict === 'rejected');
  const notices = copyLicences(accepted, shippedBySource);

  const builtAt = new Date().toISOString().slice(0, 10);
  const stats = {
    builtAt,
    read: raw.length,
    usable: presets.filter((preset) => preset.support !== 'unsupported').length,
    unsupported: counts.unsupported,
    imported: presets.filter((preset) => preset.origin === 'imported').length,
    generated: presets.filter((preset) => preset.origin === 'generated').length,
    rejectedAtBuild: problems.length,
    invalidFiles: sources.reduce((total, entry) => total + entry.presetsInvalid, 0),
    duplicateFiles: sources.reduce((total, entry) => total + entry.presetsDuplicates, 0),
    categories: countsBy(presets, 'category').size,
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'library.json'),
    `${JSON.stringify({ version: VERSION, builtAt, sample: SAMPLE, presets, sources, counts })}\n`,
  );
  fs.writeFileSync(
    path.join(OUT, 'manifest.json'),
    `${JSON.stringify(
      { version: VERSION, builtAt, sample: SAMPLE, stats, counts, sources: notices, rejected, problems },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(OUT, 'NOTICES.md'), noticesMarkdown(notices, rejected, stats));

  console.log(`[build] read ${stats.read} recipes, shipped ${presets.length} (${stats.usable} applicable)`);
  console.log(`[build] by support: full ${counts.full} · partial ${counts.partial} · unsupported ${counts.unsupported}`);
  console.log(`[build] by origin: imported ${stats.imported} · generated ${stats.generated}`);
  console.log(`[build] ${stats.categories} categories · ${shippedBySource.size} sources · ${sources.length} in the registry`);
  const byReason = countsBy(problems, (problem) => problem.reason.split(' ')[0]);
  if (problems.length > 0) {
    console.log(`[build] set aside ${problems.length}: ${[...byReason].map(([r, n]) => `${r} ×${n}`).join(', ')}`);
  }
  console.log(`[build] wrote ${path.relative(ROOT, OUT)}${path.sep}library.json, manifest.json, NOTICES.md`);
}

main();
