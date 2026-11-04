/**
 * CUBE files: read, checked, and honestly labelled.
 *
 * A `.cube` is a sampled 3D colour transform — the grading is stored as a grid
 * of output colours rather than as a set of decisions. This engine works the
 * other way round: eight named knobs and an ordered list of arithmetic stages.
 * It has no 3D LUT stage, so a CUBE file cannot be applied here without first
 * inventing one, and a preset that cannot change a pixel is not a preset.
 *
 * The importer therefore parses and validates these files — the header, the
 * grid size, the domain, the count — and records what was understood and what
 * the engine would need. That is the difference between "unsupported" and
 * "unread".
 */

export type CubeReading = {
  readonly title: string | null;
  readonly size: number;
  readonly oneDimensional: boolean;
  readonly domainMin: readonly number[];
  readonly domainMax: readonly number[];
  readonly entries: number;
  readonly expected: number;
  readonly valid: boolean;
  readonly error: string | null;
};

export const CUBE_LIMITATION =
  'A 3D LUT needs a grid-sampling stage in the rendering engine; this build grades with sliders instead.';

export function readCube(text: string): CubeReading {
  let size = 0;
  let oneDimensional = false;
  let title: string | null = null;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  let entries = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (/^TITLE\b/i.test(line)) {
      const quoted = /"([^"]*)"/.exec(line);
      title = quoted ? quoted[1] : line.slice(5).trim().replace(/"/g, '');
      continue;
    }
    const luts = /^LUT_(?:1D|3D)_SIZE\s+(\d+)/i.exec(line);
    if (luts) {
      oneDimensional = /1D/i.test(line);
      size = Number.parseInt(luts[1], 10);
      continue;
    }
    const domain = /^DOMAIN_(MIN|MAX)\s+(.*)$/i.exec(line);
    if (domain) {
      const values = domain[2]
        .split(/\s+/)
        .map((part) => Number.parseFloat(part))
        .filter((n) => Number.isFinite(n));
      if (domain[1].toUpperCase() === 'MIN') min = values;
      else max = values;
      continue;
    }
    const nums = line.split(/[\s,]+/).map((part) => Number.parseFloat(part));
    if (nums.length >= 3 && nums.every((n) => Number.isFinite(n))) entries += 1;
  }

  let error: string | null = null;
  if (!size) error = 'no LUT size declared';
  else if (size < 2 || size > 128) error = `grid size ${size} outside 2–128`;
  else if (!oneDimensional && entries !== size ** 3) error = `${entries} colour entries for a ${size}³ grid`;
  else if (oneDimensional && entries !== size) error = `${entries} entries for a 1D grid of ${size}`;
  else if (max.some((v) => v <= 0)) error = 'domain maximum is not positive';

  return {
    title,
    size,
    oneDimensional,
    domainMin: min,
    domainMax: max,
    entries,
    expected: oneDimensional ? size : size ** 3,
    valid: error === null,
    error,
  };
}
