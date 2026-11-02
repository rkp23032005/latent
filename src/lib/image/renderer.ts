/**
 * Preview renderers.
 *
 * Both paths read from the same untouched decoded original, so a slider move
 * recomputes (original, parameters) instead of stacking another edit on top of
 * the last one. WebGL does the per-pixel work in one pass; where that is not
 * available the Canvas2D path runs the identical pipeline through three lookup
 * tables built from the same stage functions.
 */

import type { PipelineParams } from './adjustments';
import {
  PARAM_UNIFORMS,
  VERTEX_SHADER,
  applyCrossChannel,
  buildChannelLuts,
  fragmentShader,
} from './pipeline';
import { GRAIN_BYTES, GRAIN_SIZE } from './grain';

/** The value that means "no comparison, show the edit everywhere". */
export const NO_SPLIT = -1;

export type RenderMode = 'webgl' | 'canvas2d';

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export type PreviewRenderer = {
  readonly mode: RenderMode;
  /** The decoded original. Passing null clears the preview. */
  setSource(bitmap: ImageBitmap | null): void;
  /** Backing-store size in device pixels. */
  resize(width: number, height: number): void;
  /** Left of `split` (0–1) the untouched original is shown, right of it the edit. */
  draw(params: PipelineParams, split?: number): void;
  destroy(): void;
};

const CONTEXT_ATTRS: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  /* The preview is the thing we want to look at, measure and read back, so the
     drawing buffer is kept instead of being discarded after each composite. */
  preserveDrawingBuffer: true,
};

const TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);

/**
 * The resized original, drawn once per size change rather than per frame.
 * Downscaling here borrows the browser's own filtering, which is better than a
 * single-tap texture sample on a large reduction.
 */
function createSizedSource() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: true })!;
  let bitmap: ImageBitmap | null = null;
  let dirty = true;

  return {
    canvas,
    ctx,
    get width() {
      return canvas.width;
    },
    get height() {
      return canvas.height;
    },
    /** The pixels in `canvas` are no longer what the source should be. */
    get dirty() {
      return dirty;
    },
    setSource(next: ImageBitmap | null) {
      bitmap = next;
      dirty = true;
    },
    resize(width: number, height: number) {
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      dirty = true;
    },
    /** @returns ready: there is something to draw; redrawn: the pixels changed. */
    ensure(): { ready: boolean; redrawn: boolean } {
      if (!bitmap || canvas.width === 0 || canvas.height === 0) {
        return { ready: false, redrawn: false };
      }
      if (!dirty) return { ready: true, redrawn: false };
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      dirty = false;
      return { ready: true, redrawn: true };
    },
  };
}

let webglSupport: boolean | null = null;

/**
 * Compiles the real pipeline against a throwaway canvas, once per page.
 *
 * A canvas can hold only one kind of context, and choosing wrong on the visible
 * one cannot be undone, so the decision is made somewhere it does not matter.
 * A negative answer is only remembered when the driver genuinely rejected the
 * pipeline; a context that was simply lost tells us to ask again later.
 */
function supportsWebgl(): boolean {
  if (webglSupport !== null) return webglSupport;
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const gl = (probe.getContext('webgl2', CONTEXT_ATTRS) ??
    probe.getContext('webgl', CONTEXT_ATTRS)) as WebGLRenderingContext | null;
  if (!gl) {
    webglSupport = false;
    return false;
  }
  if (gl.isContextLost()) return false;
  const program = buildProgram(gl);
  if (gl.isContextLost()) return false;
  webglSupport = program !== null;
  if (program) gl.deleteProgram(program);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return webglSupport;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[latent] shader rejected:', gl.getShaderInfoLog(shader) ?? 'no log (lost context)');
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** @returns a linked program the caller owns, or null if this driver rejects it. */
function buildProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentShader());
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[latent] program rejected:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function createWebgl(canvas: HTMLCanvasElement): PreviewRenderer {
  const gl = (canvas.getContext('webgl2', CONTEXT_ATTRS) ??
    canvas.getContext('webgl', CONTEXT_ATTRS)) as WebGLRenderingContext | null;
  if (!gl || gl.isContextLost()) {
    throw new RenderError('WebGL is no longer available to this preview.');
  }

  const sized = createSizedSource();
  const program = buildProgram(gl);
  if (!program) {
    throw new RenderError('The editing pipeline could not be loaded onto the graphics card.');
  }

  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, TRIANGLE, gl.STATIC_DRAW);

  const position = gl.getAttribLocation(program, 'aPosition');
  gl.useProgram(program);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, 'uImage'), 0);

  /* The grain map is the same generated bytes the fallback indexes directly.
     Nearest filtering and a wrapping repeat over a power-of-two tile mean a
     sample lands on exactly one texel — the one that pixel's speck. It is
     carried as RGBA rather than LUMINANCE because that is the one format every
     driver here agrees on, and only the red channel is ever read. */
  const noise = gl.createTexture()!;
  const noiseRgba = new Uint8Array(GRAIN_SIZE * GRAIN_SIZE * 4);
  for (let i = 0; i < GRAIN_BYTES.length; i++) {
    noiseRgba[i * 4] = GRAIN_BYTES[i];
    noiseRgba[i * 4 + 3] = 255;
  }
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, noise);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    GRAIN_SIZE,
    GRAIN_SIZE,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    noiseRgba,
  );
  gl.uniform1i(gl.getUniformLocation(program, 'uNoise'), 1);

  const sites = PARAM_UNIFORMS.map(([, name]) => gl.getUniformLocation(program, name));
  const heightSite = gl.getUniformLocation(program, 'uHeight');
  const splitSite = gl.getUniformLocation(program, 'uSplit');

  let drawnParams: PipelineParams | null = null;
  let drawnSplit = NO_SPLIT;
  let uploaded = false;

  /* A context can be taken back at any time by the browser. Without a say in
     the matter the preview simply stops changing, which looks like a broken
     knob rather than a lost surface, so the draw reports it instead. */
  let lost = false;
  const onLost = () => {
    lost = true;
  };
  canvas.addEventListener('webglcontextlost', onLost);

  return {
    mode: 'webgl',
    setSource(bitmap) {
      sized.setSource(bitmap);
      uploaded = false;
      drawnParams = null;
      drawnSplit = NO_SPLIT;
    },
    resize(width, height) {
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      sized.resize(width, height);
      uploaded = false;
      drawnParams = null;
      drawnSplit = NO_SPLIT;
    },
    draw(params, split = NO_SPLIT) {
      if (lost) throw new RenderError('The graphics card let go of this preview.');
      if (!sized.dirty && params === drawnParams && split === drawnSplit) return;
      const { ready, redrawn } = sized.ensure();
      if (!ready || canvas.width === 0) return;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (redrawn || !uploaded) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sized.canvas);
        uploaded = true;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, noise);

      gl.viewport(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < PARAM_UNIFORMS.length; i++) {
        gl.uniform1f(sites[i], params[PARAM_UNIFORMS[i][0]]);
      }
      gl.uniform1f(heightSite, canvas.height);
      gl.uniform1f(splitSite, split);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawnParams = params;
      drawnSplit = split;
    },
    /* The objects go, the context stays: a canvas can never recover a lost
       context, and this element will be drawn into again. */
    destroy() {
      canvas.removeEventListener('webglcontextlost', onLost);
      gl.deleteTexture(texture);
      gl.deleteTexture(noise);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

function toByte(value: number): number {
  const byte = Math.round(value * 255);
  return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}

function createCanvas2d(canvas: HTMLCanvasElement): PreviewRenderer {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new RenderError('This preview canvas cannot be drawn into.');

  const sized = createSizedSource();
  const pixel = new Float32Array(3);
  let drawnParams: PipelineParams | null = null;
  let drawnSplit = NO_SPLIT;
  let lutsFor: PipelineParams | null = null;
  let luts: Float32Array | null = null;
  let input: ImageData | null = null;
  let output: ImageData | null = null;

  return {
    mode: 'canvas2d',
    setSource(bitmap) {
      sized.setSource(bitmap);
      input = null;
      drawnParams = null;
      drawnSplit = NO_SPLIT;
    },
    resize(width, height) {
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      sized.resize(width, height);
      input = null;
      output = null;
      drawnParams = null;
      drawnSplit = NO_SPLIT;
    },
    draw(params, split = NO_SPLIT) {
      if (!sized.dirty && params === drawnParams && split === drawnSplit) return;
      const { ready, redrawn } = sized.ensure();
      if (!ready || canvas.width === 0) return;

      if (redrawn || !input) input = sized.ctx.getImageData(0, 0, sized.width, sized.height);
      if (!output) output = ctx.createImageData(sized.width, sized.height);
      if (params !== lutsFor || !luts) {
        luts = buildChannelLuts(params);
        lutsFor = params;
      }

      const table = luts;
      const source = input.data;
      const result = output.data;
      const width = sized.width;
      /* The cross-channel stages are told where each pixel sits — in the frame,
         and in output pixels — so a vignette darkens the corners and a grain
         speck lands on the same pixel here as it does on the graphics card. */
      const px = { u: 0, v: 0.5, x: 0, y: 0 };
      for (let y = 0; y < sized.height; y++) {
        px.v = (y + 0.5) / sized.height;
        px.y = y;
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
          const i = row + x * 4;
          px.u = (x + 0.5) / width;
          /* Left of the divider: the bytes as they arrived, no stage applied. */
          if (split >= 0 && px.u < split) {
            result[i] = source[i];
            result[i + 1] = source[i + 1];
            result[i + 2] = source[i + 2];
            result[i + 3] = source[i + 3];
            continue;
          }
          px.x = x;
          pixel[0] = table[source[i]];
          pixel[1] = table[256 + source[i + 1]];
          pixel[2] = table[512 + source[i + 2]];
          applyCrossChannel(pixel, params, px);
          result[i] = toByte(pixel[0]);
          result[i + 1] = toByte(pixel[1]);
          result[i + 2] = toByte(pixel[2]);
          result[i + 3] = source[i + 3];
        }
      }
      ctx.putImageData(output, 0, 0);
      drawnParams = params;
      drawnSplit = split;
    },
    destroy() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

export function createRenderer(canvas: HTMLCanvasElement): PreviewRenderer {
  return supportsWebgl() ? createWebgl(canvas) : createCanvas2d(canvas);
}

/**
 * The CPU path on its own, for work the graphics card should not be bought for:
 * a preset thumbnail is the same pipeline, the same stages and the same
 * arithmetic as the fallback preview, only smaller.
 */
export function createCpuPreview(canvas: HTMLCanvasElement): PreviewRenderer {
  return createCanvas2d(canvas);
}
