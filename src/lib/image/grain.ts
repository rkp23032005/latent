/**
 * The grain map, generated once and shared by both renderers.
 *
 * Film grain is a fixed scatter that the photograph is printed through, so the
 * GPU and the CPU fallback must read the *same* speck at the *same* output
 * pixel. A generated tile — rather than shader noise — makes that provable:
 * the GPU uploads these bytes as a wrapping texture, the fallback indexes them
 * directly, and both add `(value - 0.5)`.
 *
 * The generator is a seeded PRNG, so the tile is byte for byte the same on
 * every machine and every reload. Nothing here touches the DOM.
 */

/** Edges of the tile. A power of two so both paths can wrap by indexing. */
export const GRAIN_SIZE = 256;

/** Mid-grey, the value a grain-free pixel would carry. */
export const GRAIN_MID = 0.5;

export const GRAIN_BYTES = new Uint8Array(GRAIN_SIZE * GRAIN_SIZE);

(() => {
  /* mulberry32: four lines, deterministic, and good enough for a texture that
     is only ever asked to look like silver halide. */
  let state = 0x2f6b_2b5d;
  const next = () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* Two draws averaged give a triangular spread: fewer extreme specks and a
     denser middle, which reads as grain rather than as television static. */
  for (let i = 0; i < GRAIN_BYTES.length; i++) {
    GRAIN_BYTES[i] = Math.round(((next() + next()) / 2) * 255);
  }
})();

/** The speck at one output pixel, centred on zero, for any coordinates. */
export function grainAt(x: number, y: number): number {
  const ix = (((Math.floor(x) % GRAIN_SIZE) + GRAIN_SIZE) % GRAIN_SIZE);
  const iy = (((Math.floor(y) % GRAIN_SIZE) + GRAIN_SIZE) % GRAIN_SIZE);
  return GRAIN_BYTES[iy * GRAIN_SIZE + ix] / 255 - GRAIN_MID;
}
