/**
 * Post-import sanity checks on the emitted JSON.
 *
 * A tiny guard so a bad build fails loudly instead of shipping broken cards.
 * It only reads the schema contract and the knob ranges from the app, never the
 * mapping internals — if imported.json disagrees with schema.ts, this says so.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONTROLS } from '../../src/lib/image/adjustments.ts';
import { PRESETS_CACHE } from './import-lib.mjs';

const SUPPORT = new Set(['full', 'partial', 'unsupported', 'invalid']);
const RANGES = new Map(CONTROLS.map((c) => [c.id, c]));

function main() {
  const file = path.join(PRESETS_CACHE, 'imported.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const presets = data.presets;
  const problems = [];

  for (const p of presets) {
    if (typeof p.name !== 'string' || p.name.trim().length === 0) {
      problems.push(`preset ${p.id}: empty name`);
    }
    if (typeof p.id !== 'string' || !/^[a-z0-9-]+$/.test(p.id)) {
      problems.push(`preset ${p.id}: bad id`);
    }
    if (!SUPPORT.has(p.support)) {
      problems.push(`preset ${p.id}: bad support ${p.support}`);
    }
    if (p.origin !== 'imported' && p.origin !== 'generated') {
      problems.push(`preset ${p.id}: bad origin ${p.origin}`);
    }
    if (typeof p.effect !== 'number' || !Number.isFinite(p.effect)) {
      problems.push(`preset ${p.id}: effect not finite (${p.effect})`);
    }
    for (const [key, value] of Object.entries(p.adjust)) {
      const control = RANGES.get(key);
      if (!control) {
        problems.push(`preset ${p.id}: unknown knob ${key}`);
        continue;
      }
      if (!Number.isFinite(value) || value < control.min || value > control.max) {
        problems.push(`preset ${p.id}: ${key}=${value} outside [${control.min}, ${control.max}]`);
      }
    }
    for (const field of ['mapped', 'dropped', 'tags']) {
      if (!Array.isArray(p[field]) || p[field].some((s) => typeof s !== 'string')) {
        problems.push(`preset ${p.id}: ${field} must be a string array`);
      }
    }
    if (!p.source || typeof p.source.sourceId !== 'string' || typeof p.source.licence !== 'string') {
      problems.push(`preset ${p.id}: incomplete source record`);
    }
    // A full or partial preset must actually carry a recipe; an unsupported one
    // must not carry knobs it claims it cannot apply.
    if ((p.support === 'full' || p.support === 'partial') && Object.keys(p.adjust).length === 0) {
      problems.push(`preset ${p.id}: ${p.support} with empty adjust`);
    }
    if (p.support === 'unsupported' && Object.keys(p.adjust).length > 0) {
      problems.push(`preset ${p.id}: unsupported with non-empty adjust`);
    }
    if (p.support === 'full' && p.dropped.length > 0) {
      problems.push(`preset ${p.id}: full but has dropped settings`);
    }
  }

  // ids unique across the library
  const ids = new Set();
  for (const p of presets) {
    if (ids.has(p.id)) problems.push(`duplicate id ${p.id}`);
    ids.add(p.id);
  }

  const counts = presets.reduce((acc, p) => ((acc[p.support] = (acc[p.support] ?? 0) + 1), acc), {});
  console.log('[verify] presets:', presets.length, 'by support:', JSON.stringify(counts));
  if (problems.length > 0) {
    console.error('[verify] FAILURES:');
    for (const line of problems.slice(0, 50)) console.error('  -', line);
    if (problems.length > 50) console.error(`  ...and ${problems.length - 50} more`);
    process.exit(1);
  }
  console.log('[verify] all checks passed');
}

main();
