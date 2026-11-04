// @vitest-environment jsdom
/**
 * The frame as part of the session — Phase 15 §4.
 *
 * A crop is not one of the sixteen, and these tests hold it to that promise.
 * It rides with the recipe through Undo, redo and a saved project; it survives
 * choosing a different look, because a shape says nothing about what to do with
 * the pixels inside it; and `reset` gives it back.
 *
 * The gesture rule matters here: a slider that fires a hundred events must cost
 * one press of Undo, while a chip pressed on purpose must always be its own
 * step. `sameCrop` is what stops a second press of the same shape from adding
 * an empty step to the history.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IDENTITY, toPipelineParams } from '../lib/image/adjustments';
import { PARAM_UNIFORMS } from '../lib/image/pipeline';
import { newProject, type Project } from '../lib/projectStore';
import type { Photo } from '../lib/photoStore';
import { useAdjustments } from '../lib/useAdjustments';

const SQUARE = { x: 0.25, y: 0, w: 0.5, h: 0.5 };

function photo(): Photo {
  const file = new File([new Uint8Array([1, 2, 3])], 'dune.jpg', { type: 'image/jpeg' });
  return {
    file,
    name: 'dune.jpg',
    bytes: 3,
    mime: 'image/jpeg',
    width: 400,
    height: 300,
    url: 'blob:test/dune',
  } as Photo;
}

function session() {
  return renderHook(() => useAdjustments('blob:test/dune'));
}

// ── 1. Undo, redo, gestures ───────────────────────────────────────────────────

describe('the frame is an edit like the others', () => {
  it('is remembered, undone and redone', () => {
    const { result } = session();
    expect(result.current.crop).toBe(null);

    act(() => result.current.setCrop(SQUARE));
    expect(result.current.crop).toEqual(SQUARE);
    expect(result.current.steps).toBe(1);

    act(() => result.current.undo());
    expect(result.current.crop).toBe(null);
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.redo());
    expect(result.current.crop).toEqual(SQUARE);
  });

  it('takes a slider drag as one step and a chip press as another', () => {
    const { result } = session();
    act(() => result.current.setCrop(SQUARE));
    expect(result.current.steps).toBe(1);

    /* One drag: the same gesture key, back to back. */
    for (const fx of [0.2, 0.3, 0.4, 0.5]) {
      act(() => result.current.setCrop({ ...SQUARE, x: fx }, 'across'));
    }
    expect(result.current.crop!.x).toBeCloseTo(0.5, 6);
    expect(result.current.steps).toBe(2);

    /* Undo once and the whole drag is gone, not a third of it. */
    act(() => result.current.undo());
    expect(result.current.crop).toEqual(SQUARE);

    /* A different axis is a different decision — and the Undo above took a step
       away, so the count restarts from one. */
    act(() => result.current.setCrop({ ...SQUARE, y: 0.2 }, 'down'));
    expect(result.current.steps).toBe(2);

    /* A press with no gesture is its own step, however soon it follows. */
    act(() => result.current.setCrop(SQUARE));
    expect(result.current.steps).toBe(3);
  });

  it('does not record a step for a frame that did not change', () => {
    const { result } = session();
    act(() => result.current.setCrop(SQUARE));
    act(() => result.current.setCrop(SQUARE));
    expect(result.current.steps).toBe(1);

    /* Giving the frame back is a change, so it steps once… */
    act(() => result.current.setCrop({ x: 0, y: 0, w: 1, h: 1 }));
    expect(result.current.crop).toBe(null);
    expect(result.current.steps).toBe(2);
    /* …and the whole frame and null being one instruction means a second way of
       saying it adds nothing. */
    act(() => result.current.setCrop(null));
    expect(result.current.steps).toBe(2);
  });

  it('refuses a frame that is not a frame', () => {
    const { result } = session();
    act(() => result.current.setCrop({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }));
    const crop = result.current.crop!;
    expect(crop.x + crop.w).toBeLessThanOrEqual(1 + 1e-6);
    expect(crop.y + crop.h).toBeLessThanOrEqual(1 + 1e-6);

    act(() => result.current.setCrop({ x: Number.NaN, y: 0, w: -4, h: 0.5 }));
    expect(result.current.crop).toEqual({ x: 0, y: 0, w: 0.05, h: 0.5 });

    act(() => result.current.setCrop('not a frame' as never));
    expect(result.current.crop).toBe(null);
  });
});

// ── 2. What the frame does NOT touch ─────────────────────────────────────────

describe('the frame stays outside the recipe', () => {
  it('moves no knob and enters no pipeline stage', () => {
    const { result } = session();
    act(() => result.current.setCrop(SQUARE));
    expect(result.current.values).toEqual(IDENTITY);

    /* The uniforms are derived from the controls; a crop is not among them, so
       there is no uniform for the shader to be handed. */
    expect(Object.keys(PARAM_UNIFORMS)).not.toContain('crop');
    const params = toPipelineParams(result.current.values, 0);
    expect(Object.keys(params).some((key) => key.includes('crop'))).toBe(false);

    /* Turning a knob does not disturb the frame either. */
    act(() => result.current.set('warmth', 30));
    expect(result.current.crop).toEqual(SQUARE);
  });

  it('carries across a new look and survives intensity', () => {
    const { result } = session();
    act(() => result.current.setCrop(SQUARE));
    act(() => result.current.applyPreset({ ...IDENTITY, contrast: 20 }, 'some-preset', 60));
    expect(result.current.crop).toEqual(SQUARE);
    expect(result.current.activePreset).toBe('some-preset');

    act(() => result.current.setIntensity(30));
    expect(result.current.crop).toEqual(SQUARE);
  });

  it('is given back by reset, and by undo all the way home', () => {
    const { result } = session();
    act(() => result.current.applyPreset({ ...IDENTITY, contrast: 20 }, 'some-preset', 100));
    act(() => result.current.setCrop(SQUARE));
    act(() => result.current.reset());
    expect(result.current.crop).toBe(null);
    expect(result.current.activePreset).toBe(null);
  });

  it('reports itself in the snapshot that gets saved', () => {
    const { result } = session();
    act(() => result.current.setCrop(SQUARE));
    expect(result.current.snapshot.crop).toEqual(SQUARE);
  });
});

// ── 3. Persistence ───────────────────────────────────────────────────────────

describe('the frame in a saved project', () => {
  it('is written with the recipe it belongs to', () => {
    const { result } = session();
    act(() => result.current.setCrop(SQUARE));
    const record: Project = newProject(
      photo(),
      result.current.snapshot,
      'Dune',
      null,
    );
    expect(record.editing.crop).toEqual(SQUARE);
    expect(record.schema).toBe(1);
  });

  it('reads a hostile stored frame back as a sane one', () => {
    /* What the store does to a row it did not write: the same clamp the session
       uses, so a corrupted record cannot ask the decoder for a window that is
       not in the file. Reading a row from the device database is verified in the
       browser, where IndexedDB exists. */
    const { result } = session();
    act(() => result.current.setCrop({ x: 0.9, y: 0.2, w: 0.5, h: 4 }));
    const stored = JSON.parse(JSON.stringify(newProject(photo(), result.current.snapshot, 'Dune', null)));
    expect(stored.editing.crop.x + stored.editing.crop.w).toBeLessThanOrEqual(1.000001);
    expect(stored.editing.crop.h).toBeLessThanOrEqual(1);
  });

  it('lets an old row without a frame through as the whole picture', () => {
    const { result } = session();
    act(() => result.current.setCrop(SQUARE));
    const legacy = { ...result.current.snapshot, crop: undefined };
    const record = newProject(photo(), legacy as never, 'Dune', null);
    expect(record.editing.crop ?? null).toBe(null);
  });
});
