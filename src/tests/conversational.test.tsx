// @vitest-environment jsdom
/**
 * End-to-end checks for natural-language editing.
 *
 * Three things are proven here, because each one alone would let the other two
 * hide a bug:
 *
 * 1. A parsed instruction, folded into the current edit and handed to the real
 *    engine, changes actual pixels in the direction the words asked for.
 * 2. Preview → accept → undo → redo → hand-edit keeps the photograph and the
 *    history honest, and a command lands *on top of* the look already there.
 * 3. The interface itself — chips, typing, ambiguity choices, unsupported
 *    requests — drives those paths and never invents a control or a preset.
 */

import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/* The session asks for a photograph before anything can be previewed; give it
   one, the same way the proposal tests do, without decoding a file. */
vi.mock('../lib/usePhotoLoader', () => ({
  usePhotoLoader: () => ({
    photo: { url: 'blob:photo-1', name: 'p.jpg' },
    status: 'ready',
    error: null,
    load: () => {},
    dismissError: () => {},
  }),
}));

import {
  IDENTITY,
  clampToControl,
  scaleRecipe,
  toPipelineParams,
  type Adjustments,
} from '../lib/image/adjustments';
import {
  conversationalPreset,
  parseNlRequest,
  resolveDeltas,
  resolvedToAdjustments,
  movingKnobs,
  type ParsedInstruction,
} from '../lib/ai/nlParser';
import { renderChart } from '../lib/preset/effect';
import { presetAdjustments, type Preset } from '../lib/preset/schema';
import { generateOptions } from '../lib/ai/enhance';
import { useAdjustments } from '../lib/useAdjustments';
import { useProposal } from '../lib/useProposal';
import { useEditingSession } from '../lib/useEditingSession';
import { ConversationalEdit } from '../components/ConversationalEdit';
import { analyseSample, library, loadSamples } from './helpers';

const sample = loadSamples(64)[0];
const analysis = analyseSample(sample);
const enhanceOptions = generateOptions(library, analysis);
const full = (p: Preset) => presetAdjustments(p, IDENTITY);

// ── Measuring what the engine drew ────────────────────────────────────────────

type Stats = { luma: number; spread: number; warmth: number; chroma: number };

/** Read the rendered test chart back as numbers the claims can be checked against. */
function measure(adjust: Partial<Adjustments>): Stats {
  const rgb = renderChart(adjust);
  let lumaSum = 0;
  let chromaSum = 0;
  let warmSum = 0;
  const lumas: number[] = [];
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumas.push(luma);
    lumaSum += luma;
    chromaSum += Math.max(r, g, b) - Math.min(r, g, b);
    warmSum += r - b;
  }
  const mean = lumaSum / lumas.length;
  const variance = lumas.reduce((s, l) => s + (l - mean) ** 2, 0) / lumas.length;
  const n = lumas.length;
  return {
    luma: mean,
    spread: Math.sqrt(variance),
    warmth: warmSum / n,
    chroma: chromaSum / n,
  };
}

/** The recipe a command produces against a photograph that already has an edit on it. */
function applyInstruction(current: Adjustments, instruction: ParsedInstruction): Adjustments {
  if (instruction.kind !== 'adjustments') throw new Error(`not an adjustment instruction: ${instruction.kind}`);
  const merged = resolvedToAdjustments(resolveDeltas(current, instruction.deltas));
  return { ...current, ...merged } as Adjustments;
}

// ── 1. The words land on the photograph ───────────────────────────────────────

describe('a spoken instruction changes real pixels the way it says', () => {
  // Every case starts from a look that is already on the photograph, so these
  // are testing a command added on top, not a command applied from nothing.
  const prior: Adjustments = { ...full(enhanceOptions[1].preset) };

  it('brighter lifts the image', () => {
    const after = applyInstruction(prior, parseNlRequest('Make this image brighter'));
    expect(measure(after).luma).toBeGreaterThan(measure(prior).luma);
  });

  it('darker drops it', () => {
    const after = applyInstruction(prior, parseNlRequest('Make it darker'));
    expect(measure(after).luma).toBeLessThan(measure(prior).luma);
  });

  it('reduce the contrast slightly flattens the tone spread a little', () => {
    const after = applyInstruction(prior, parseNlRequest('Reduce the contrast slightly'));
    const before = measure(prior);
    const now = measure(after);
    expect(now.spread).toBeLessThan(before.spread);
    expect(after.contrast).toBe(prior.contrast - 12);
  });

  it('warmer colours push red against blue', () => {
    const after = applyInstruction(prior, parseNlRequest('Make the colours warmer'));
    expect(measure(after).warmth).toBeGreaterThan(measure(prior).warmth);
  });

  it('cooler colours pull red back against blue', () => {
    const after = applyInstruction(prior, parseNlRequest('Make the colours cooler'));
    expect(measure(after).warmth).toBeLessThan(measure(prior).warmth);
  });

  it('less saturated drains colour', () => {
    const after = applyInstruction(prior, parseNlRequest('Make it less saturated'));
    expect(measure(after).chroma).toBeLessThan(measure(prior).chroma);
  });

  it('black and white leaves almost no colour at all', () => {
    const after = applyInstruction(prior, parseNlRequest('Black and white'));
    expect(measure(after).chroma).toBeLessThan(1);
  });

  it('a faded film appearance lifts the darkest part of the chart', () => {
    const before = renderChart(prior);
    const after = renderChart(applyInstruction(prior, parseNlRequest('Create a faded film appearance')));
    // The chart's blackest ramp pixel sits at index 0.
    expect(after[0]).toBeGreaterThan(before[0]);
  });

  it('moodier deepens the dark end while lifting the edges off', () => {
    const after = applyInstruction(prior, parseNlRequest('Make the background moodier'));
    expect(after.shadows).toBeLessThan(prior.shadows);
    expect(after.contrast).toBeGreaterThan(prior.contrast);
    expect(after.vignette).toBeGreaterThan(prior.vignette);
  });

  it('a request for a look resolves to a preset that exists in the library', () => {
    for (const family of ['cinematic', 'natural', 'creative'] as const) {
      const option = enhanceOptions.find((o) => o.kind === family);
      expect(option, family).toBeTruthy();
      expect(library.presets.some((p) => p.id === option!.preset.id), family).toBe(true);
      // It is not a recipe that does nothing.
      expect(measure(full(option!.preset)).luma).not.toBeCloseTo(measure(IDENTITY).luma, 1);
    }
  });

  it('an ambiguous request moves nothing until the user chooses', () => {
    const instruction = parseNlRequest('Give it more pop');
    expect(instruction.kind).toBe('ambiguous');
    if (instruction.kind !== 'ambiguous') return;
    expect(instruction.options.length).toBeGreaterThanOrEqual(2);
    // The ask itself is not a recipe, but every choice offered is one that acts.
    for (const option of instruction.options) {
      expect(movingKnobs(resolveDeltas(prior, option.deltas)).length).toBeGreaterThan(0);
    }
  });

  it('the renderer is handed the same numbers in the same order as any other edit', () => {
    // A conversational recipe reaches the pipeline through the one conversion
    // every other edit uses — there is no second rendering path for AI words.
    const after = applyInstruction(prior, parseNlRequest('Make it brighter'));
    const params = toPipelineParams(after);
    expect(params.gain).toBeGreaterThan(toPipelineParams(prior).gain);
    expect(Object.keys(params).sort()).toEqual(Object.keys(toPipelineParams(prior)).sort());
  });
});

// ── 2. Preview, accept, undo, redo, keep editing ──────────────────────────────

describe('the conversational path through the editing history', () => {
  function setup() {
    return renderHook(() => {
      const edits = useAdjustments('u');
      const proposals = useProposal(edits, 'u');
      let n = 0;
      /** Exactly what the Editor does when the panel proposes an edit: the
          resolved knobs folded over the edit already on the photograph, because
          a preview replaces the stage rather than adding to it. */
      const previewInstruction = (current: Adjustments, instruction: ParsedInstruction) => {
        if (instruction.kind !== 'adjustments') return false;
        const knobs = resolveDeltas(current, instruction.deltas);
        if (movingKnobs(knobs).length === 0) return false;
        const next = { ...current, ...resolvedToAdjustments(knobs) } as Adjustments;
        proposals.preview(conversationalPreset(`conv:${++n}`, instruction.summary, next), 'rules', 'Your words');
        return true;
      };
      return { edits, proposals, previewInstruction };
    });
  }

  it('a command lands on top of the look and the hand turn already there', () => {
    const { result } = setup();
    const cinematic = enhanceOptions.find((o) => o.kind === 'cinematic')!.preset;
    act(() => result.current.edits.applyPreset(full(cinematic), cinematic.id, 60));
    act(() => result.current.edits.set('contrast', result.current.edits.values.contrast + 10));
    const before = { ...result.current.edits.values };

    const instruction = parseNlRequest('Make it brighter');
    if (instruction.kind !== 'adjustments') throw new Error('expected adjustments');
    act(() => {
      expect(result.current.previewInstruction(before, instruction)).toBe(true);
    });

    // The stage shows the request added to the photograph as it stands.
    const wanted = clampToControl('exposure', before.exposure + instruction.deltas.find((d) => d.id === 'exposure')!.value);
    expect(result.current.proposals.stageValues!.exposure).toBeCloseTo(wanted, 5);
    expect(result.current.proposals.stageValues.brightness).toBeCloseTo(
      clampToControl('brightness', before.brightness + 14),
      5,
    );
    // Everything the request did not name still reads as the edit it was.
    for (const id of Object.keys(before) as (keyof Adjustments)[]) {
      if (id === 'exposure' || id === 'brightness') continue;
      expect(result.current.proposals.stageValues[id]).toBe(before[id]);
    }
  });

  it('previewing touches no history, and rejecting leaves the edit exactly as it was', () => {
    const { result } = setup();
    act(() => result.current.edits.applyPreset(full(enhanceOptions[0].preset), enhanceOptions[0].preset.id));
    const before = {
      values: result.current.edits.values,
      steps: result.current.edits.steps,
      preset: result.current.edits.activePreset,
    };

    act(() => result.current.previewInstruction(result.current.edits.values, parseNlRequest('Add a vignette')));
    expect(result.current.proposals.proposal).not.toBeNull();
    expect(result.current.edits.values).toEqual(before.values);
    expect(result.current.edits.steps).toBe(before.steps);

    act(() => result.current.proposals.reject());
    expect(result.current.proposals.proposal).toBeNull();
    expect(result.current.edits.values).toEqual(before.values);
    expect(result.current.edits.steps).toBe(before.steps);
  });

  it('accept is one undoable step; undo returns the previous look, redo restores it', () => {
    const { result } = setup();
    const natural = enhanceOptions[0].preset;
    act(() => result.current.edits.applyPreset(full(natural), natural.id));
    const prior = result.current.edits.values;
    const priorSteps = result.current.edits.steps;

    act(() => result.current.previewInstruction(prior, parseNlRequest('Make it brighter')));
    const proposed = result.current.proposals.stageValues;
    act(() => result.current.proposals.accept());

    const e = result.current.edits;
    expect(result.current.proposals.proposal).toBeNull();
    expect(e.values.exposure).toBeCloseTo(proposed.exposure, 5);
    expect(e.values.brightness).toBeCloseTo(proposed.brightness, 5);
    // Everything the command did not mention survives the accept.
    expect(e.values.warmth).toBe(prior.warmth);
    expect(e.steps).toBe(priorSteps + 1);
    expect(e.activePreset).toMatch(/^conv:/);

    act(() => e.undo());
    expect(result.current.edits.values).toEqual(prior);

    act(() => result.current.edits.redo());
    expect(result.current.edits.values.exposure).toBeCloseTo(proposed.exposure, 5);
  });

  it('manual editing stays available after accepting, and turns on top of it', () => {
    const { result } = setup();
    act(() => result.current.previewInstruction(IDENTITY, parseNlRequest('Make the colours warmer')));
    act(() => result.current.proposals.accept());
    const accepted = result.current.edits.values;
    expect(accepted.warmth).toBeGreaterThan(0);

    act(() => result.current.edits.set('warmth', accepted.warmth - 20));
    expect(result.current.edits.values.warmth).toBeCloseTo(accepted.warmth - 20, 5);
    expect(result.current.edits.modified).toBe(true);

    act(() => result.current.edits.undo());
    expect(result.current.edits.values.warmth).toBeCloseTo(accepted.warmth, 5);
  });

  it('what is accepted is what export renders', () => {
    const { result } = setup();
    act(() => result.current.previewInstruction(IDENTITY, parseNlRequest('Make it brighter')));
    const previewed = result.current.proposals.stageValues;
    act(() => result.current.proposals.accept());
    // ExportPanel is handed edits.values; the preview was handed stageValues.
    expect(result.current.edits.values).toEqual(previewed);
    expect(toPipelineParams(result.current.edits.values).gain).toBeGreaterThan(1);
    // A rejected preview never reaches the export numbers.
    act(() => result.current.previewInstruction(result.current.edits.values, parseNlRequest('Add film grain')));
    act(() => result.current.proposals.reject());
    expect(result.current.edits.values.grain).toBe(0);
  });

  it('a command that cannot move anything proposes nothing at all', () => {
    const { result } = setup();
    const atTheTop: Adjustments = { ...IDENTITY, exposure: 2, brightness: 100 };
    act(() => result.current.edits.applyPreset(atTheTop, 'manual-max'));
    expect(result.current.previewInstruction(atTheTop, parseNlRequest('Make it brighter'))).toBe(false);
    expect(result.current.proposals.proposal).toBeNull();
    expect(result.current.edits.steps).toBe(1); // the preset only; no phantom step
  });

  it('the session’s undo drops a pending preview rather than committing it', () => {
    const { result } = renderHook(() => useEditingSession());
    act(() => result.current.setMode('ai'));
    const current = result.current.edits.values;
    const instruction = parseNlRequest('Make it brighter');
    if (instruction.kind !== 'adjustments') throw new Error('expected adjustments');

    act(() => {
      const next = { ...current, ...resolvedToAdjustments(resolveDeltas(current, instruction.deltas)) } as Adjustments;
      result.current.proposals.preview(
        conversationalPreset('conv:test', instruction.summary, next),
        'rules',
        'Your words',
      );
    });
    expect(result.current.proposals.proposal).not.toBeNull();
    act(() => result.current.undo());
    expect(result.current.proposals.proposal).toBeNull();
    expect(result.current.edits.values).toEqual(current);
  });
});

// ── 3. The panel a beginner actually uses ─────────────────────────────────────

describe('ConversationalEdit interface', () => {
  type Props = React.ComponentProps<typeof ConversationalEdit>;

  function setup(over: Partial<Props> = {}) {
    const onPreviewAdjustments = vi.fn();
    const onPreviewPreset = vi.fn();
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const props: Props = {
      enhanceOptions,
      currentAdjustments: IDENTITY,
      onPreviewAdjustments,
      onPreviewPreset,
      onAccept,
      onReject,
      isPreviewing: true,
      hasPhoto: true,
      ...over,
    };
    const view = render(<ConversationalEdit {...props} />);
    return { ...view, props, onPreviewAdjustments, onPreviewPreset, onAccept, onReject };
  }

  const input = (view: ReturnType<typeof setup>) => {
    const node = view.container.querySelector('#conv-edit-input') as HTMLInputElement;
    return node;
  };

  function ask(view: ReturnType<typeof setup>, text: string) {
    fireEvent.change(input(view), { target: { value: text } });
    fireEvent.submit(view.container.querySelector('form')!);
  }

  it('offers a field, an Apply button and quick commands', () => {
    const view = setup();
    expect(input(view)).toBeTruthy();
    expect(input(view).disabled).toBe(false);
    expect(view.container.querySelectorAll('.conv-edit__chips .chip').length).toBeGreaterThan(4);
    expect(view.container.textContent).toMatch(/Describe an edit/i);
    // The promise about privacy and undo is in the panel, not hidden in a doc.
    expect(view.container.textContent).toMatch(/sent anywhere/i);
    expect(view.container.textContent).toMatch(/Undo/i);
  });

  it('the input is locked, and says why, until a photograph is loaded', () => {
    const view = setup({ hasPhoto: false });
    expect(input(view).disabled).toBe(true);
    expect(input(view).placeholder).toMatch(/Load a photo/i);
  });

  it('typing a request previews it and lists the knobs it moves', () => {
    const view = setup();
    ask(view, 'Reduce the contrast slightly');
    expect(view.onPreviewAdjustments).toHaveBeenCalledTimes(1);
    const [values, summary] = view.onPreviewAdjustments.mock.calls[0];
    expect(values.contrast).toBeLessThan(0);
    expect(Object.keys(values)).toEqual(['contrast']);
    expect(summary).toMatch(/contrast/i);
    expect(view.container.textContent).toMatch(/Reduce the contrast/i);
    expect(view.container.querySelector('.conv-response__delta-value')!.textContent).toMatch(/−12/);
    expect(view.container.querySelectorAll('.conv-response__actions .btn')).toHaveLength(2);
  });

  it('a chip sends the same command as typing it', () => {
    const view = setup();
    const chip = Array.from(view.container.querySelectorAll<HTMLButtonElement>('.chip')).find((c) => c.textContent === 'Warmer colours')!;
    fireEvent.click(chip);
    expect(view.onPreviewAdjustments).toHaveBeenCalledTimes(1);
    expect(view.onPreviewAdjustments.mock.calls[0][0].warmth).toBeGreaterThan(0);
  });

  it('a command is added to the edit in place, and the panel shows before and after', () => {
    const withLook: Adjustments = { ...IDENTITY, contrast: 40, vignette: 20 };
    const view = setup({ currentAdjustments: withLook });
    ask(view, 'Make it brighter');
    const [values] = view.onPreviewAdjustments.mock.calls[0];
    // The vignette and contrast the photograph already carries are not touched.
    expect(Object.keys(values).sort()).toEqual(['brightness', 'exposure']);
    expect(view.container.textContent).toMatch(/→/);
  });

  it('a request for a look previews a preset, never a made-up one', () => {
    const view = setup();
    ask(view, 'Give it a cinematic look');
    expect(view.onPreviewPreset).toHaveBeenCalledTimes(1);
    const preset = view.onPreviewPreset.mock.calls[0][0] as Preset;
    expect(library.presets.some((p) => p.id === preset.id)).toBe(true);
    expect(view.onPreviewAdjustments).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/real preset|library/i);
  });

  it('an ambiguous request offers choices and previews nothing until one is picked', () => {
    const view = setup();
    ask(view, 'Make it better');
    expect(view.onPreviewAdjustments).not.toHaveBeenCalled();
    expect(view.onPreviewPreset).not.toHaveBeenCalled();
    const options = view.container.querySelectorAll<HTMLButtonElement>('.conv-option');
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(3);
    const labels = Array.from(options).map((o) => o.textContent);
    expect(labels.join(' ')).toMatch(/Natural/);
    expect(labels.join(' ')).toMatch(/Cinematic/);
    expect(labels.join(' ')).toMatch(/Bright/);

    fireEvent.click(Array.from(options).find((o) => o.textContent!.includes('Bright'))!);
    expect(view.onPreviewAdjustments).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('.conv-option.is-chosen')).toBeTruthy();
    // The chosen interpretation is a proposal like any other: it can be accepted
    // or rejected from the conversation, not only from the bar above the stage.
    const actions = view.container.querySelectorAll('.conv-response__actions .btn');
    expect(actions).toHaveLength(2);
    fireEvent.click(Array.from(actions).find((b) => b.textContent === 'Accept')!);
    expect(view.onAccept).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toMatch(/Applied/i);
  });

  it('picking a preset option previews that family’s real preset', () => {
    const view = setup();
    ask(view, 'Make it better');
    const cinematic = Array.from(view.container.querySelectorAll<HTMLButtonElement>('.conv-option')).find((o) => o.textContent!.includes('Cinematic'))!;
    fireEvent.click(cinematic);
    expect(view.onPreviewPreset).toHaveBeenCalledTimes(1);
    // and the exchange itself offers the way to keep it
    expect(view.container.querySelectorAll('.conv-response__actions .btn')).toHaveLength(2);
  });

  it('an unsupported request explains the limit and offers a way round it, and changes nothing', () => {
    const view = setup();
    ask(view, 'Remove the person in the background');
    expect(view.onPreviewAdjustments).not.toHaveBeenCalled();
    expect(view.onPreviewPreset).not.toHaveBeenCalled();
    const block = view.container.querySelector('.conv-response--unsupported')!;
    expect(block.textContent).toMatch(/not available/i);
    expect(block.textContent).toMatch(/retouching|Moody/i);
    // Nothing to accept, because nothing was proposed.
    expect(view.container.querySelector('.conv-response__actions')).toBeNull();
  });

  it('gibberish is answered with examples rather than a guess', () => {
    const view = setup();
    ask(view, 'frobnicate the quux');
    expect(view.onPreviewAdjustments).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/wasn.t recognised/i);
    expect(view.container.textContent).toMatch(/make it brighter/i);
  });

  it('a request already satisfied proposes nothing and says so', () => {
    const maxed: Adjustments = { ...IDENTITY, exposure: 2, brightness: 100 };
    const view = setup({ currentAdjustments: maxed });
    ask(view, 'Make it brighter');
    expect(view.onPreviewAdjustments).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/already/i);
  });

  it('accept commits the proposal and reject turns it down', () => {
    const view = setup();
    ask(view, 'Add a vignette');
    fireEvent.click(Array.from(view.container.querySelectorAll<HTMLButtonElement>('.btn')).find((b) => b.textContent === 'Accept')!);
    expect(view.onAccept).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toMatch(/Applied/i);

    ask(view, 'Add film grain');
    fireEvent.click(Array.from(view.container.querySelectorAll<HTMLButtonElement>('.btn')).find((b) => b.textContent === 'Reject')!);
    expect(view.onReject).toHaveBeenCalled();
  });

  it('a later request drops the earlier proposal’s accept controls', () => {
    const view = setup();
    ask(view, 'Add a vignette');
    ask(view, 'Add film grain');
    const items = view.container.querySelectorAll('.conv-item');
    expect(items).toHaveLength(2);
    expect(view.container.querySelectorAll('.conv-response__actions')).toHaveLength(1);
  });

  it('a look requested for one area of the frame says it applies to the whole photograph', () => {
    const view = setup();
    ask(view, 'Make the background moodier');
    expect(view.onPreviewAdjustments).toHaveBeenCalledTimes(1);
    const caveat = view.container.querySelector('.conv-response__caveat')!.textContent ?? '';
    expect(caveat).toMatch(/no mask/i);
    expect(caveat).toMatch(/lands everywhere/i);
  });

  it('the same answer for skin names the one protection the engine does have', () => {
    const view = setup();
    ask(view, 'Warm the skin tones');
    const caveat = view.container.querySelector('.conv-response__caveat')!.textContent ?? '';
    expect(caveat).toMatch(/Skin guard/);
    expect(caveat).toMatch(/no mask/i);
  });

  it('nothing is proposed while the photograph is still being measured', () => {
    const view = setup({ enhanceOptions: [] });
    ask(view, 'Give it a cinematic look');
    expect(view.onPreviewPreset).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/not ready yet/i);
    // and crucially, no accept control for a change that never happened
    expect(view.container.querySelector('.conv-response__actions')).toBeNull();
  });

  it('intensity on a conversational proposal still scales from the untouched photo', () => {
    const { result } = renderHook(() => {
      const edits = useAdjustments('u');
      const proposals = useProposal(edits, 'u');
      return { edits, proposals };
    });
    const instruction = parseNlRequest('Make it brighter');
    if (instruction.kind !== 'adjustments') throw new Error('expected adjustments');
    const preset = conversationalPreset('conv:x', instruction.summary, resolvedToAdjustments(resolveDeltas(IDENTITY, instruction.deltas)));
    act(() => result.current.proposals.preview(preset));
    act(() => result.current.proposals.setIntensity(0));
    expect(result.current.proposals.stageValues).toEqual(IDENTITY);
    act(() => result.current.proposals.setIntensity(50));
    const half = scaleRecipe(full(preset), 50);
    expect(result.current.proposals.stageValues.exposure).toBeCloseTo(half.exposure, 5);
  });
});
