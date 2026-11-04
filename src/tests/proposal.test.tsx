// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IDENTITY, scaleRecipe } from '../lib/image/adjustments';
import { generateOptions } from '../lib/ai/enhance';
import { presetAdjustments, type Preset } from '../lib/preset/schema';
import { useAdjustments } from '../lib/useAdjustments';
import { useProposal } from '../lib/useProposal';
import { analyseSample, library, loadSamples } from './helpers';

vi.mock('../lib/usePhotoLoader', () => ({
  usePhotoLoader: () => ({
    photo: { url: 'blob:photo-1', name: 'p.jpg' },
    status: 'ready',
    error: null,
    load: () => {},
    dismissError: () => {},
  }),
}));

const sample = loadSamples(64)[0];
const [natural, cinematic, creative] = generateOptions(library, analyseSample(sample)).map((o) => o.preset);
const full = (p: Preset) => presetAdjustments(p, IDENTITY);

function setup() {
  return renderHook(() => {
    const edits = useAdjustments('u');
    const proposals = useProposal(edits, 'u');
    return { edits, proposals };
  });
}

describe('preview does not touch the current edit', () => {
  it('leaves values, history and preset alone while previewing, then rejects cleanly', () => {
    const { result } = setup();
    act(() => result.current.edits.applyPreset(full(natural), natural.id));
    act(() => result.current.edits.set('exposure', 0.4)); // a manual turn on top
    const before = {
      values: result.current.edits.values,
      steps: result.current.edits.steps,
      preset: result.current.edits.activePreset,
      canRedo: result.current.edits.canRedo,
    };

    act(() => result.current.proposals.preview(cinematic, 'rules', 'Cinematic'));
    expect(result.current.proposals.proposal?.preset.id).toBe(cinematic.id);
    // the stage shows the proposal…
    expect(result.current.proposals.stageValues).toEqual(full(cinematic));
    // …and the edit is exactly as it was
    expect(result.current.edits.values).toEqual(before.values);
    expect(result.current.edits.steps).toBe(before.steps);
    expect(result.current.edits.activePreset).toBe(before.preset);

    act(() => result.current.proposals.reject());
    expect(result.current.proposals.proposal).toBeNull();
    expect(result.current.proposals.stageValues).toEqual(before.values);
    expect(result.current.edits.values).toEqual(before.values);
    expect(result.current.edits.steps).toBe(before.steps);
    expect(result.current.edits.canRedo).toBe(before.canRedo);
  });

  it('rejecting does not clear the redo stack', () => {
    const { result } = setup();
    act(() => result.current.edits.applyPreset(full(natural), natural.id));
    act(() => result.current.edits.undo());
    expect(result.current.edits.canRedo).toBe(true);
    act(() => result.current.proposals.preview(creative));
    act(() => result.current.proposals.reject());
    expect(result.current.edits.canRedo).toBe(true);
  });
});

describe('accept: one undoable, redoable step', () => {
  for (const [name, preset] of [['Natural', natural], ['Cinematic', cinematic], ['Creative', creative]] as const) {
    it(`${name}: accept → undo → redo`, () => {
      const { result } = setup();
      act(() => result.current.edits.applyPreset(full(natural), natural.id, 60));
      act(() => result.current.edits.set('contrast', 20));
      const prior = { values: result.current.edits.values, steps: result.current.edits.steps };

      act(() => result.current.proposals.preview(preset));
      act(() => result.current.proposals.setIntensity(70));
      act(() => result.current.proposals.accept());

      const e = result.current.edits;
      expect(result.current.proposals.proposal).toBeNull();
      expect(e.activePreset).toBe(preset.id);
      expect(e.intensity).toBe(70);
      expect(e.steps).toBe(prior.steps + 1); // exactly one history entry
      expect(e.values).toEqual(scaleRecipe(full(preset), 70)); // offsets cleared with the new baseline
      const accepted = e.values;

      act(() => result.current.edits.undo());
      expect(result.current.edits.values).toEqual(prior.values); // previous state incl. manual turn and intensity 60
      expect(result.current.edits.steps).toBe(prior.steps);
      expect(result.current.edits.canRedo).toBe(true);

      act(() => result.current.edits.redo());
      expect(result.current.edits.values).toEqual(accepted);
      expect(result.current.edits.activePreset).toBe(preset.id);
      expect(result.current.edits.intensity).toBe(70);
    });
  }

  it('accepting from a clean photograph undoes back to the unmodified original', () => {
    const { result } = setup();
    act(() => result.current.proposals.preview(natural));
    act(() => result.current.proposals.accept());
    expect(result.current.edits.dirty).toBe(true);
    act(() => result.current.edits.undo());
    expect(result.current.edits.values).toEqual(IDENTITY);
    expect(result.current.edits.dirty).toBe(false);
  });

  it('Apply on the previewed look keeps the previewed intensity; on another look uses 100', () => {
    const { result } = setup();
    act(() => result.current.proposals.preview(natural));
    act(() => result.current.proposals.setIntensity(40));
    act(() => result.current.proposals.applyNow(natural));
    expect(result.current.edits.intensity).toBe(40);

    act(() => result.current.proposals.preview(cinematic));
    act(() => result.current.proposals.setIntensity(40));
    act(() => result.current.proposals.applyNow(creative));
    expect(result.current.edits.activePreset).toBe(creative.id);
    expect(result.current.edits.intensity).toBe(100);
    expect(result.current.proposals.proposal).toBeNull();
  });
});

describe('intensity on a proposal', () => {
  it('0 draws the unmodified photograph; growth is a straight line towards the preset', () => {
    const { result } = setup();
    act(() => result.current.proposals.preview(cinematic));
    act(() => result.current.proposals.setIntensity(0));
    expect(result.current.proposals.stageValues).toEqual(IDENTITY);
    act(() => result.current.proposals.setIntensity(50));
    const half = result.current.proposals.stageValues;
    act(() => result.current.proposals.setIntensity(100));
    const whole = result.current.proposals.stageValues;
    expect(whole).toEqual(full(cinematic));
    for (const key of Object.keys(IDENTITY) as Array<keyof typeof IDENTITY>) {
      if (whole[key] === 0) expect(half[key]).toBe(0);
      else expect(Math.abs(half[key])).toBeGreaterThan(0), expect(Math.abs(half[key])).toBeLessThan(Math.abs(whole[key]) + 1e-9);
    }
  });

  it('clamps out-of-range and non-finite values', () => {
    const { result } = setup();
    act(() => result.current.proposals.preview(natural));
    act(() => result.current.proposals.setIntensity(250));
    expect(result.current.proposals.proposal?.intensity).toBe(100);
    act(() => result.current.proposals.setIntensity(-5));
    expect(result.current.proposals.proposal?.intensity).toBe(0);
  });
});

describe('manual controls stay available after accepting', () => {
  it('a hand turn lands on top of the accepted look and is undoable', () => {
    const { result } = setup();
    act(() => result.current.proposals.preview(cinematic));
    act(() => result.current.proposals.setIntensity(80));
    act(() => result.current.proposals.accept());
    const look = result.current.edits.values;

    const lookAt80 = scaleRecipe(full(cinematic), 80).exposure;
    act(() => result.current.edits.set('exposure', 0.5));
    expect(result.current.edits.values.exposure).toBeCloseTo(0.5); // the slider lands where it was put
    expect(result.current.edits.modified).toBe(true);
    expect(result.current.edits.activePreset).toBe(cinematic.id);

    // moving AI intensity afterwards keeps the hand turn as an offset from the look
    act(() => result.current.edits.setIntensity(30));
    const lookAt30 = scaleRecipe(full(cinematic), 30).exposure;
    expect(result.current.edits.values.exposure).toBeCloseTo(lookAt30 + (0.5 - lookAt80));

    act(() => result.current.edits.undo()); // intensity
    act(() => result.current.edits.undo()); // exposure
    expect(result.current.edits.values).toEqual(look);
  });
});

describe('session: mode switching, undo and enhance request', () => {
  it('switching to Manual Edit drops a pending preview but keeps the edit; accepted looks survive', async () => {
    const { useEditingSession } = await import('../lib/useEditingSession');
    const { result } = renderHook(() => useEditingSession());

    act(() => result.current.setMode('ai'));
    act(() => result.current.proposals.preview(natural));
    act(() => result.current.proposals.accept());
    const accepted = result.current.edits.values;
    expect(result.current.edits.activePreset).toBe(natural.id);

    act(() => result.current.proposals.preview(cinematic));
    expect(result.current.proposals.proposal).not.toBeNull();
    act(() => result.current.setMode('manual'));
    expect(result.current.proposals.proposal).toBeNull();
    expect(result.current.edits.values).toEqual(accepted);
    expect(result.current.edits.activePreset).toBe(natural.id);

    act(() => result.current.edits.set('saturation', 25));
    expect(result.current.edits.values.saturation).toBeCloseTo(25, 5); // slider lands where it was put
    expect(result.current.edits.modified).toBe(true);
    act(() => result.current.setMode('ai'));
    expect(result.current.edits.activePreset).toBe(natural.id); // still there after switching back
  });

  it('undo and redo drop a pending preview first and then step the history', async () => {
    const { useEditingSession } = await import('../lib/useEditingSession');
    const { result } = renderHook(() => useEditingSession());
    act(() => result.current.proposals.preview(natural));
    act(() => result.current.proposals.accept());
    act(() => result.current.proposals.preview(creative));
    act(() => result.current.undo());
    expect(result.current.proposals.proposal).toBeNull();
    expect(result.current.edits.values).toEqual(IDENTITY);
    act(() => result.current.proposals.preview(creative));
    act(() => result.current.redo());
    expect(result.current.proposals.proposal).toBeNull();
    expect(result.current.edits.activePreset).toBe(natural.id);
  });

  it('applying a look from the Presets browser also discards a stale preview', async () => {
    const { useEditingSession } = await import('../lib/useEditingSession');
    const { result } = renderHook(() => useEditingSession());
    act(() => result.current.proposals.preview(natural));
    act(() => result.current.applyLook(creative));
    expect(result.current.proposals.proposal).toBeNull();
    expect(result.current.edits.activePreset).toBe(creative.id);
  });

  it('the toolbar Enhance action switches to AI mode and bumps the request counter', async () => {
    const { useEditingSession } = await import('../lib/useEditingSession');
    const { result } = renderHook(() => useEditingSession());
    expect(result.current.enhanceRequest).toBe(0);
    act(() => result.current.requestEnhance());
    expect(result.current.mode).toBe('ai');
    expect(result.current.enhanceRequest).toBe(1);
  });
});
