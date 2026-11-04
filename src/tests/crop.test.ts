/**
 * The frame, and the measurement behind the suggestions — Phase 15 §4.
 *
 * Four things are checked, in this order:
 *
 * 1. Geometry. A frame is four fractions, and every operation on it has to
 *    leave it a window that is actually inside the photograph — never empty,
 *    never off the edge, never a shape that changed while it moved. Untrusted
 *    input (a database row, a hand-built object) is treated as hostile.
 * 2. That the same fractions mean the same pixels at every size. The stage
 *    draws a reduced decode, an export decodes the file at its own size; both
 *    go through `cropPixelRect`, so a number here is a number the user sees.
 * 3. The measurement, on synthetic grids where the answer is known in advance:
 *    a planted block of contrast is found, a flat picture yields nothing, and a
 *    tie goes to the centre rather than to whichever corner the loop reached
 *    first.
 * 4. What is *not* claimed. There is no subject here, no face, no horizon — so
 *    a texture-heavy region is followed exactly as eagerly as a face would be,
 *    and with no measurement at all nothing is suggested.
 */

import { describe, expect, it } from 'vitest';
import {
  FRAME_RATIOS,
  FULL_FRAME,
  bestPlacement,
  centreCrop,
  clampCrop,
  cropPixels,
  cropPixelRect,
  cropRatio,
  cropTravel,
  detailMapFromRgba,
  detailShareOf,
  framingLabel,
  framingsFor,
  isFullFrame,
  isMeasurable,
  largestWindow,
  percent,
  placeCrop,
  retainedArea,
  sameCrop,
  scaleCrop,
  type DetailMap,
  type Framing,
} from '../lib/image/crop';

/* ------------------------------------------------------------------ *
 * Helpers: small synthetic files, in pixels and in RGBA
 * ------------------------------------------------------------------ */

const LANDSCAPE = { width: 400, height: 300 };
const SQUARE = { width: 200, height: 200 };

/** A flat grey RGBA buffer. */
function flat(width: number, height: number, value = 128): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = value;
    out[i * 4 + 1] = value;
    out[i * 4 + 2] = value;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A block of checkerboard — the contrast the measurement is supposed to see. */
function busyBlock(
  width: number,
  height: number,
  box: { x: number; y: number; w: number; h: number },
): Uint8ClampedArray {
  const out = flat(width, height, 40);
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const v = (x + y) % 2 === 0 ? 255 : 0;
      const o = (y * width + x) * 4;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
    }
  }
  return out;
}

/** A one-cell map with given energies — for testing the sums directly. */
function mapOf(energies: number[][], width: number, height: number): DetailMap {
  return { width, height, energy: Float32Array.from(energies.flat()) };
}

// ── 1. What a frame is ────────────────────────────────────────────────────────

describe('a frame is four fractions of the photograph', () => {
  it('treats null and the whole picture as the same instruction', () => {
    expect(isFullFrame(null)).toBe(true);
    expect(isFullFrame(FULL_FRAME)).toBe(true);
    expect(isFullFrame({ x: 0, y: 0, w: 0.5, h: 1 })).toBe(false);

    /* Same instruction, so equal — which is what lets Undo compare states. */
    expect(sameCrop(null, FULL_FRAME)).toBe(true);
    expect(sameCrop(FULL_FRAME, null)).toBe(true);
    expect(sameCrop(null, null)).toBe(true);
    expect(sameCrop({ x: 0.1, y: 0, w: 0.9, h: 1 }, null)).toBe(false);
    expect(sameCrop({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0.5, h: 0.5 })).toBe(true);
    expect(sameCrop({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0.1, w: 0.5, h: 0.5 })).toBe(false);
  });

  it('keeps a window inside the picture whatever it is handed', () => {
    const cases: unknown[] = [
      { x: 0.5, y: 0.5, w: 0.9, h: 0.9 }, // would run off the bottom-right
      { x: -3, y: -3, w: 0.4, h: 0.4 }, // negative origin
      { x: 99, y: 99, w: 0.4, h: 0.4 }, // origin past the far edge
      { x: 0, y: 0, w: 7, h: 0.5 }, // wider than the file
      { x: Number.NaN, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: Infinity, h: 0.5 },
      { x: 0, y: 0, w: 0.001, h: 0.001 }, // a hair, not a frame
    ];
    for (const value of cases) {
      const crop = clampCrop(value);
      if (crop === null) continue;
      expect(crop.w).toBeGreaterThanOrEqual(0.05);
      expect(crop.h).toBeGreaterThanOrEqual(0.05);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.w).toBeLessThanOrEqual(1 + 1e-6);
      expect(crop.y + crop.h).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('reads a frame that is the whole picture back as no frame', () => {
    expect(clampCrop({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
    expect(clampCrop('nonsense')).toBeNull();
    expect(clampCrop(undefined)).toBeNull();
    expect(clampCrop(7)).toBeNull();
    /* Missing sides default to the whole axis, then collapse to null. */
    expect(clampCrop({})).toBeNull();
    expect(clampCrop({ w: 0.5 })).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });

  it('rounds to six decimals — a fraction of a pixel on any real file', () => {
    const crop = clampCrop({ x: 0.123456789, y: 0.5, w: 0.4, h: 0.4 });
    expect(crop!.x).toBeCloseTo(0.123457, 10);
    expect(crop!.w).toBe(0.4);
  });
});

// ── 2. Fractions to pixels ────────────────────────────────────────────────────

describe('the same frame at every size', () => {
  it('leaves the whole file alone when the frame is the whole file', () => {
    expect(cropPixelRect(null, 400, 300)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(cropPixelRect(FULL_FRAME, 400, 300)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it('is scale-invariant: the identical window on a decode and on the file', () => {
    const frame = { x: 0.2, y: 0.1, w: 0.6, h: 0.8 };
    const onFile = cropPixelRect(frame, 6000, 4000);
    const onPreview = cropPixelRect(frame, 600, 400);
    expect(onFile.x / onFile.width).toBeCloseTo(onPreview.x / onPreview.width, 6);
    expect(onFile.y / onFile.height).toBeCloseTo(onPreview.y / onPreview.height, 6);
    expect(onFile.width / onPreview.width).toBeCloseTo(10, 6);
  });

  it('never produces an empty or overflowing rectangle', () => {
    const hostile = [
      { crop: { x: 0.99, y: 0.99, w: 0.5, h: 0.5 }, size: LANDSCAPE },
      { crop: { x: 0, y: 0, w: 0.0001, h: 0.0001 }, size: LANDSCAPE },
      { crop: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, size: { width: 3, height: 2 } },
    ];
    for (const { crop, size } of hostile) {
      const rect = cropPixelRect(crop, size.width, size.height);
      expect(rect.width).toBeGreaterThanOrEqual(1);
      expect(rect.height).toBeGreaterThanOrEqual(1);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(size.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(size.height);
    }
  });

  it('survives a file with no pixels in it', () => {
    expect(cropPixelRect({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 0, 0)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it('reports the shape it was cut at, in the file’s own pixels', () => {
    /* Half the width of a 4:3 file is a square window. */
    expect(cropRatio({ x: 0.25, y: 0, w: 0.75, h: 1 }, LANDSCAPE)).toBeCloseTo(1, 8);
    expect(cropPixels({ x: 0.25, y: 0, w: 0.75, h: 1 }, LANDSCAPE)).toEqual({
      x: 100,
      y: 0,
      width: 300,
      height: 300,
    });
    expect(framingLabel({ x: 0.25, y: 0, w: 0.75, h: 1 }, LANDSCAPE)).toBe(
      '75% of the picture · 300 × 300 px',
    );
    expect(framingLabel(null, LANDSCAPE)).toBe('100% of the picture · 400 × 300 px');
  });

  it('re-states the frame from the database without trusting it', () => {
    /* cropPixels is the entry a stored row goes through: a 0.9 origin with a
       0.5 window cannot both be kept, and the file decides which one is lost. */
    expect(cropPixels({ x: 5, y: 5, w: 0.5, h: 0.5 }, SQUARE)).toEqual({
      x: 100,
      y: 100,
      width: 100,
      height: 100,
    });
    /* A hair of a window is damage, so it is raised to the floor: five percent
       of the file, not a tenth of a percent. */
    expect(cropPixels({ x: 0, y: 0, w: 0.0001, h: 1 }, SQUARE).width).toBe(10);

  });
});

// ── 3. Moving and sizing a frame ──────────────────────────────────────────────

describe('the shape, the size control and the two axes', () => {
  it('fits the largest window of a shape and centres it', () => {
    /* 4:3 file, square shape: full height, three quarters of the width. */
    expect(largestWindow(1, LANDSCAPE)).toEqual({ x: 0.125, y: 0, w: 0.75, h: 1 });
    /* A shape wider than the file loses height instead. */
    const wide = largestWindow(16 / 9, LANDSCAPE);
    expect(wide.w).toBeCloseTo(1, 6);
    expect(wide.h).toBeCloseTo(0.75, 6);
    /* Already this shape: nothing to cut. */
    expect(retainedArea(largestWindow(4 / 3, LANDSCAPE))).toBeCloseTo(1, 6);
    /* Nonsense ratios are the whole picture rather than a crash. */
    expect(largestWindow(0, LANDSCAPE)).toEqual(FULL_FRAME);
    expect(largestWindow(Number.NaN, LANDSCAPE)).toEqual(FULL_FRAME);
  });

  it('shrinks a frame about its own centre and never past the floor', () => {
    const square = largestWindow(1, LANDSCAPE); // x .125, w .75, full height
    const half = scaleCrop(square, 0.5, LANDSCAPE)!;
    expect(half.w).toBeCloseTo(0.375, 6);
    expect(half.h).toBeCloseTo(0.5, 6);
    /* Same centre. */
    expect(half.x + half.w / 2).toBeCloseTo(square.x + square.w / 2, 5);
    expect(half.y + half.h / 2).toBeCloseTo(square.y + square.h / 2, 5);
    /* The shape is kept: still a square in pixels. */
    expect(cropRatio(half, LANDSCAPE)).toBeCloseTo(1, 4);

    /* Past the floor it stops at 30 %. */
    expect(scaleCrop(square, 0.01, LANDSCAPE)!.w).toBeCloseTo(0.75 * 0.3, 3);
    /* At or above its own largest size it is simply that window again — a square
       on a 4:3 file can never become the whole picture, so no null here. */
    expect(scaleCrop(square, 1, LANDSCAPE)).toEqual(square);
    expect(scaleCrop(square, 9, LANDSCAPE)).toEqual(square);
    /* Only a frame that already spans the file gives it back. */
    expect(scaleCrop(FULL_FRAME, 1, LANDSCAPE)).toBe(null);
    expect(scaleCrop(largestWindow(4 / 3, LANDSCAPE), 0.999, LANDSCAPE)!.w).toBeCloseTo(1, 2);

    /* Slid to a corner, it stays inside the file. */
    const corner = placeCrop(square, 1, 1);
    const small = scaleCrop(corner, 0.4, LANDSCAPE)!;
    expect(small.x + small.w).toBeLessThanOrEqual(1 + 1e-6);
    expect(small.y + small.h).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('puts the window where the slider says, and reads it back', () => {
    /* A frame with travel on both axes. */
    const window = { x: 0, y: 0, w: 0.5, h: 0.4 };
    for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
      for (const fy of [0, 0.5, 1]) {
        const placed = placeCrop(window, fx, fy);
        const travel = cropTravel(placed);
        expect(travel.fx).toBeCloseTo(fx, 4);
        expect(travel.fy).toBeCloseTo(fy, 4);
      }
    }
    /* Out-of-range slider values are clamped, not propagated. */
    expect(placeCrop(window, -2, 5)).toEqual(placeCrop(window, 0, 1));
    expect(placeCrop(window, Number.NaN, Number.NaN)).toEqual(placeCrop(window, 0, 0));
  });

  it('has no travel on an axis the frame already spans', () => {
    const square = largestWindow(1, LANDSCAPE); // spans the height
    expect(placeCrop(square, 0.2, 0).y).toBe(0);
    expect(cropTravel(square).fy).toBe(0.5);
    /* A centred frame reports itself as centred. */
    const centred = centreCrop({ x: 0.6, y: 0.1, w: 0.3, h: 0.3 });
    expect(centred).toEqual({ x: 0.35, y: 0.35, w: 0.3, h: 0.3 });
    expect(cropTravel(centred).fx).toBeCloseTo(0.5, 6);
  });

  it('offers few shapes, and only real ones', () => {
    const ids = FRAME_RATIOS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(8);
    for (const ratio of FRAME_RATIOS) {
      expect(ratio.ratio).toBeGreaterThan(0);
      expect(ratio.label.length).toBeGreaterThan(0);
      expect(ratio.note.length).toBeGreaterThan(0);
      expect(['square', 'portrait', 'landscape']).toContain(ratio.kind);
    }
    expect(percent(0.753)).toBe('75%');
    expect(percent(-1)).toBe('0%');
    expect(percent(9)).toBe('100%');
  });
});

// ── 4. The measurement ────────────────────────────────────────────────────────

describe('local contrast on the untouched sample', () => {
  it('is zero everywhere on a flat picture', () => {
    const map = detailMapFromRgba(flat(9, 7), 9, 7);
    expect(map.energy.every((v) => v === 0)).toBe(true);
    expect(isMeasurable(map)).toBe(false);
  });

  it('counts a hard edge once per neighbour it touches', () => {
    /* Black frame, white centre: the centre differs from four neighbours, the
       edges of the frame from one, the corners from none (they clamp to
       themselves and the edge cells). */
    const rgba = flat(3, 3, 0);
    const o = (1 * 3 + 1) * 4;
    rgba[o] = 255;
    rgba[o + 1] = 255;
    rgba[o + 2] = 255;
    const map = detailMapFromRgba(rgba, 3, 3);
    const white = 0.299 * 255 + 0.587 * 255 + 0.114 * 255; // BT.601 → 255
    expect(map.energy[4]).toBeCloseTo(4 * white, 4);
    /* A corner sees only the two neighbours it has. */
    expect(map.energy[0]).toBeCloseTo(0 * white, 4);
    /* The cell above the centre sees the centre and nothing else. */
    expect(map.energy[1]).toBeCloseTo(white, 4);
  });

  it('measures luminance, not colour: equal brightness reads equal', () => {
    /* A pure red pixel and a grey one at the same BT.601 brightness differ by a
       rounding of the luma, not by the channel mix — so a red wall and a grey
       one of the same lightness are followed with the same eagerness. */
    const red = flat(5, 5, 0);
    const grey = flat(5, 5, 0);
    const at = (3 * 5 + 2) * 4;
    red[at] = 255;
    grey[at] = 255;
    grey[at + 1] = 255;
    grey[at + 2] = 255;
    const m1 = detailMapFromRgba(red, 5, 5);
    const m2 = detailMapFromRgba(grey, 5, 5);
    /* 0.299×255 = 76.2 against 255: the red cell is about a third as edged. */
    expect(m1.energy[17]).toBeCloseTo(4 * 76.245, 2);
    expect(m2.energy[17]).toBeCloseTo(4 * 255, 2);
  });

  it('refuses to be a measurement when there is nothing to measure', () => {
    expect(isMeasurable(null)).toBe(false);
    expect(isMeasurable(mapOf([[0, 0], [0, 0]], 2, 2))).toBe(false);
    expect(isMeasurable(mapOf([[0, 0, 0], [0, 5, 0], [0, 0, 0]], 3, 3))).toBe(true);
    /* Too coarse to place a window in. */
    expect(isMeasurable({ width: 2, height: 9, energy: Float32Array.from([1, 1]) })).toBe(false);
  });
});

describe('where the detail is', () => {
  it('finds a planted block instead of defaulting to the centre', () => {
    const map = detailMapFromRgba(busyBlock(40, 30, { x: 2, y: 2, w: 8, h: 8 }), 40, 30);
    const fit = bestPlacement(map, 0.4, 0.4);
    expect(fit.measured).toBe(true);
    expect(fit.crop.x).toBeLessThan(0.3);
    expect(fit.crop.y).toBeLessThan(0.3);
    expect(fit.detailShare!).toBeGreaterThan(0.9);
    /* The shape asked for is the shape returned. */
    expect(fit.crop.w).toBeCloseTo(0.4, 6);
    expect(fit.crop.h).toBeCloseTo(0.4, 6);
  });

  it('reports the whole picture when the frame is the whole picture', () => {
    const map = detailMapFromRgba(busyBlock(24, 24, { x: 18, y: 2, w: 5, h: 5 }), 24, 24);
    expect(detailShareOf(map, FULL_FRAME)).toBeCloseTo(1, 8);
    expect(detailShareOf(map, { x: 0, y: 0, w: 0.5, h: 0.5 })).toBeLessThan(0.1);
    expect(detailShareOf(null, FULL_FRAME)).toBeNull();
    expect(detailShareOf(flatMap(8, 8), FULL_FRAME)).toBeNull();
  });

  it('breaks a tie toward the centre, not toward whichever cell came first', () => {
    /* One bright cell. Any 10×10 window on a 20×20 grid that contains it is an
       equal answer; the loop meets the flush top-left placement first, so a
       naive search would stop there. */
    const energies: number[][] = [];
    for (let y = 0; y < 20; y++) {
      const row = new Array<number>(20).fill(0);
      if (y === 3) row[3] = 9;
      energies.push(row);
    }
    const fit = bestPlacement(mapOf(energies, 20, 20), 0.5, 0.5);
    expect(fit.measured).toBe(true);
    expect(fit.crop.x).toBeCloseTo(0.15, 6); // px 3 of 20 — the nearest to centre px 5
    expect(fit.crop.y).toBeCloseTo(0.15, 6);
    expect(fit.detailShare).toBeCloseTo(1, 6);
  });

  it('is a flat answer for a flat picture, and no answer without a measurement', () => {
    const flatFrame = flatMap(20, 20);
    expect(bestPlacement(flatFrame, 0.5, 0.5).measured).toBe(false);
    expect(bestPlacement(flatFrame, 0.5, 0.5).detailShare).toBeNull();
    /* Framed flatly: centred, not pushed into a corner by float noise. */
    expect(bestPlacement(flatFrame, 0.5, 0.4).crop).toEqual({ x: 0.25, y: 0.3, w: 0.5, h: 0.4 });
    expect(bestPlacement(null, 0.5, 0.5)).toEqual({
      crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      detailShare: null,
      measured: false,
    });
  });

  function flatMap(width: number, height: number): DetailMap {
    return detailMapFromRgba(flat(width, height), width, height);
  }
});

// ── 5. What gets suggested ────────────────────────────────────────────────────

describe('the row of shapes', () => {
  it('stays in a fixed order so the chips do not move under the pointer', () => {
    const map = detailMapFromRgba(busyBlock(32, 32, { x: 0, y: 20, w: 6, h: 6 }), 32, 32);
    const rows = framingsFor(LANDSCAPE, map);
    expect(rows.map((r) => r.ratio.id)).toEqual(FRAME_RATIOS.map((r) => r.id));
  });

  it('suggests nothing when a shape is already the shape of the file', () => {
    const rows = framingsFor({ width: 200, height: 200 }, null);
    const square = rows.find((r) => r.ratio.id === 'square')!;
    expect(square.cuts).toBe(false);
    expect(square.crop).toEqual(FULL_FRAME);
    expect(square.retained).toBe(1);
    expect(square.suggested).toBe(false);
  });

  it('suggests nothing at all when there was no measurement', () => {
    /* The honest state: chips are there to press, but no fit was computed, so
       no row is marked and nothing pretends to know. */
    const rows = framingsFor(LANDSCAPE, null);
    expect(rows.every((r) => r.suggested === false)).toBe(true);
    expect(rows.every((r) => r.detailShare === null)).toBe(true);
    expect(rows.filter((r) => r.cuts).length).toBeGreaterThan(0);
  });

  it('marks at most three, and only rows that actually cut', () => {
    const map = detailMapFromRgba(busyBlock(32, 32, { x: 24, y: 2, w: 7, h: 7 }), 32, 32);
    const rows = framingsFor(LANDSCAPE, map);
    const suggested = rows.filter((r) => r.suggested);
    expect(suggested.length).toBeGreaterThan(0);
    expect(suggested.length).toBeLessThanOrEqual(3);
    for (const row of suggested) {
      expect(row.cuts).toBe(true);
      expect(row.detailShare).not.toBeNull();
      /* The block sits at 75–95 % across the sample, so a good window of any of
         these widths has to be flush against the right edge to hold it. The
         position is a whole sample cell while the width is the requested
         fraction, so on a 32-cell grid allow that quantum. */
      expect(row.crop.x + row.crop.w).toBeGreaterThan(1 - 2 / 32);
    }
    /* A suggestion is never the whole picture. */
    for (const row of rows) {
      if (row.cuts) expect(row.retained).toBeLessThan(1);
    }
    /* The ranking is the stated rule, not an accident of the loop: no unmarked
       row keeps more detail per pixel of picture retained than a marked one. */
    const advantage = (row: Framing) => (row.detailShare ?? 0) - row.retained;
    const worst_marked = Math.min(...suggested.map(advantage));
    const best_unmarked = Math.max(
      ...rows.filter((r) => r.cuts && !r.suggested).map(advantage),
      Number.NEGATIVE_INFINITY,
    );
    expect(worst_marked).toBeGreaterThanOrEqual(best_unmarked - 1e-4);
  });

  it('ranks by detail kept per area kept, not by detail alone', () => {
    /* Two maps, same total energy, different spread: the tighter frame that
       keeps a third of the area and most of the detail should beat a shape that
       keeps almost all of it. */
    const concentrated = detailMapFromRgba(busyBlock(32, 32, { x: 0, y: 0, w: 6, h: 6 }), 32, 32);
    const rows = framingsFor({ width: 600, height: 300 }, concentrated);
    const byId = new Map(rows.map((r) => [r.ratio.id, r]));
    const upright = byId.get('portrait45')!; // tall window, cuts hard
    expect(upright.cuts).toBe(true);
    expect(upright.retained).toBeLessThan(1);
    /* A window that cuts off the block entirely reports a low share — the
       numbers the panel shows are the frame’s own, not the best possible. */
    expect(upright.detailShare!).toBeGreaterThan(0);
  });

  it('keeps the measurement honest about which number belongs to which frame', () => {
    const map = detailMapFromRgba(busyBlock(24, 24, { x: 2, y: 2, w: 8, h: 8 }), 24, 24);
    const largest = largestWindow(1, { width: 400, height: 300 });
    const fit = bestPlacement(map, largest.w, largest.h);
    /* The fit maximises; the same fractions moved elsewhere keep less. */
    const elsewhere = placeCrop(fit.crop, 1, 1);
    const here = detailShareOf(map, fit.crop);
    const there = detailShareOf(map, elsewhere);
    expect(here!).toBeGreaterThan(there!);
    /* And the panel’s sentence uses the frame the user is looking at. */
    expect(there!).toBeLessThan(here!);
    expect(fit.detailShare!).toBeCloseTo(here!, 2);
  });
});
