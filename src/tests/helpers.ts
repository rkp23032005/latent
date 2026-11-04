import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { analysePixels } from '../lib/ai/imageAnalysis';
import { toPipelineParams, type Adjustments } from '../lib/image/adjustments';
import { applyPipeline } from '../lib/image/pipeline';
import type { PresetLibrary } from '../lib/preset/schema';

const ROOT = join(__dirname, '..', '..', 'public');

export const library: PresetLibrary = JSON.parse(
  readFileSync(join(ROOT, 'presets', 'library.json'), 'utf8'),
);

export type Sample = { name: string; width: number; height: number; rgba: Uint8Array };

/** Nearest-neighbour reduction to at most `edge` pixels on the long side. */
function reduce(img: { width: number; height: number; data: Uint8Array }, edge: number): Sample & { name: '' } {
  const k = Math.min(1, edge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) / k));
      const sy = Math.min(img.height - 1, Math.floor((y + 0.5) / k));
      const s = (sy * img.width + sx) * 4;
      const d = (y * w + x) * 4;
      rgba[d] = img.data[s];
      rgba[d + 1] = img.data[s + 1];
      rgba[d + 2] = img.data[s + 2];
      rgba[d + 3] = 255;
    }
  }
  return { name: '', width: w, height: h, rgba };
}

export function loadSamples(edge = 96): Sample[] {
  const dir = join(ROOT, 'photography');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((file) => {
      const img = jpeg.decode(readFileSync(join(dir, file)), { useTArray: true });
      return { ...reduce(img, edge), name: file.replace('.jpg', '') };
    });
}

/** The 64×64 square every browser-side measurement is taken from. */
export function sample64(s: Sample): Uint8Array {
  const N = 64;
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const sx = Math.min(s.width - 1, Math.floor(((x + 0.5) / N) * s.width));
      const sy = Math.min(s.height - 1, Math.floor(((y + 0.5) / N) * s.height));
      const a = (sy * s.width + sx) * 4;
      const d = (y * N + x) * 4;
      out[d] = s.rgba[a];
      out[d + 1] = s.rgba[a + 1];
      out[d + 2] = s.rgba[a + 2];
      out[d + 3] = 255;
    }
  }
  return out;
}

/** What the browser does: a 64×64 sample, then the measurements. */
export function analyseSample(s: Sample) {
  return analysePixels(sample64(s), 64 * 64);
}

/** Render a photograph through the shared pipeline: RGB bytes out. */
export function render(s: Sample, values: Adjustments): Uint8Array {
  const params = toPipelineParams(values);
  const out = new Uint8Array(s.width * s.height * 3);
  const px = new Float32Array(3);
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const i = (y * s.width + x) * 4;
      px[0] = s.rgba[i] / 255;
      px[1] = s.rgba[i + 1] / 255;
      px[2] = s.rgba[i + 2] / 255;
      applyPipeline(px, params, { u: (x + 0.5) / s.width, v: (y + 0.5) / s.height, x, y });
      const o = (y * s.width + x) * 3;
      for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, Math.round(px[c] * 255)));
    }
  }
  return out;
}

export function original(s: Sample): Uint8Array {
  const out = new Uint8Array(s.width * s.height * 3);
  for (let i = 0, o = 0; i < s.rgba.length; i += 4, o += 3) {
    out[o] = s.rgba[i];
    out[o + 1] = s.rgba[i + 1];
    out[o + 2] = s.rgba[i + 2];
  }
  return out;
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
