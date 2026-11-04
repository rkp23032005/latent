import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Icon } from './Icon';
import { Progress } from './Progress';
import { PhotoError, type Photo } from '../lib/photoStore';
import {
  describeAdjustments,
  toPipelineParams,
  type Adjustments,
} from '../lib/image/adjustments';
import { decodeOriginal } from '../lib/image/original';
import { cropPixelRect, framingLabel, isFullFrame, type CropRect } from '../lib/image/crop';
import {
  NO_SPLIT,
  createCpuPreview,
  createRenderer,
  type PreviewRenderer,
  type RenderMode,
  RenderError,
} from '../lib/image/renderer';

/* The preview is drawn at screen size, not file size. A software pipeline has
   to cover the same ground with per-pixel loops, so it works at a lower budget
   to stay smooth while a drag is happening. */
const GPU_PREVIEW_PIXELS = 2_600_000;
const CPU_PREVIEW_PIXELS = 900_000;

type Phase = 'preparing' | 'ready' | 'failed';

/** Where the divider is, and whether it is showing at all. */
type View = 'original' | 'split' | 'edited';

const VIEWS: ReadonlyArray<{ id: View; label: string; note: string }> = [
  { id: 'original', label: 'Original', note: 'The photograph exactly as it arrived' },
  { id: 'split', label: 'Split', note: 'Original left of the divider, edit right of it' },
  { id: 'edited', label: 'Edited', note: 'Every current adjustment' },
];

/** The one number the renderer needs from the view. */
function splitOf(view: View, position: number): number {
  if (view === 'split') return position;
  return view === 'original' ? 1 : NO_SPLIT;
}

type PreviewCanvasProps = {
  photo: Photo;
  values: Adjustments;
  /** Skin tone protection, 0–100, as the session holds it. */
  skinGuard: number;
  /** Where the picture is cut, in fractions of the file. Null is all of it. */
  crop: CropRect | null;
};

/* A message that explains the problem in the space where the picture should
   be, without inventing a fix the user cannot take. */
function reasonFor(
  error: unknown,
  name: string,
  fallback = `${name} could not be prepared for editing. The file on your device is unchanged.`,
): string {
  if (error instanceof PhotoError || error instanceof RenderError) return error.message;
  return fallback;
}

function percentOf(position: number): number {
  return Math.round(position * 100);
}

/**
 * The live preview, and the before/after divider over it.
 *
 * One decoded original, one renderer, one draw per animation frame however
 * fast the knobs or the divider move — and the result is always computed from
 * the untouched photograph plus the current editing state. Left of the divider
 * the renderer is handed nothing but the source bytes, so the two halves of
 * the picture are the two things the user means when they say before and after.
 *
 * The frame is part of what is drawn rather than part of the recipe: it decides
 * which pixels the renderer is given. Changing it re-measures the box, because a
 * square cut out of a landscape file is a different shape on the screen.
 */
export function PreviewCanvas({ photo, values, skinGuard, crop }: PreviewCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<PreviewRenderer | null>(null);
  const params = useMemo(() => toPipelineParams(values, skinGuard), [values, skinGuard]);
  const frame = useRef({ params, view: 'edited' as View, split: 0.5 });
  const queued = useRef(0);
  /* The frame the renderer is showing, and the layout that knows how big it is.
     Neither is React state: the renderer, not the markup, has to be told. */
  const cropRef = useRef<CropRect | null>(crop);
  const layoutRef = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<Phase>('preparing');
  const [mode, setMode] = useState<RenderMode>('webgl');
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>('edited');
  const [split, setSplit] = useState(0.5);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [software, setSoftware] = useState(false);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);

  const paint = useCallback(() => {
    queued.current = 0;
    try {
      const current = frame.current;
      renderer.current?.draw(current.params, splitOf(current.view, current.split));
    } catch (error) {
      if (!software && error instanceof RenderError) {
        /* The old engine stays in the ref only until the effect takes it down;
           clearing it here stops any frame already scheduled from drawing into
           a context that has just failed. */
        renderer.current = null;
        setFallbackNote(
          'The graphics card stopped responding, so the preview is now drawn on the processor. Editing and export are unaffected.',
        );
        setSoftware(true);
        setPhase('preparing');
        return;
      }
      setNotice(
        reasonFor(
          error,
          photo.name,
          'The preview stopped responding. The photograph on your device is unchanged.',
        ),
      );
      setPhase('failed');
    }
  }, [photo.name, software]);

  const schedule = useCallback(() => {
    if (queued.current) return;
    queued.current = requestAnimationFrame(paint);
  }, [paint]);

  useEffect(() => {
    const node = canvas.current;
    const found = host.current;
    if (!node || !found) return;

    let alive = true;
    let bitmap: ImageBitmap | null = null;
    let source = { width: photo.width, height: photo.height };

    const fail = (error: unknown) => {
      if (!alive) return;
      setNotice(reasonFor(error, photo.name));
      setPhase('failed');
    };

    /* A renderer can refuse at any point: no graphics context at all, a lost
       context mid-drag, or a source larger than the hardware will take. The
       software pipeline is the same arithmetic, so the edit does not change
       meaning when it has to take over. */
    const recover = (error: unknown) => {
      if (!alive) return;
      if (!software && error instanceof RenderError) {
        renderer.current = null;
        setFallbackNote(
          'The graphics card could not be used, so the preview is drawn on the processor. Editing and export are unaffected.',
        );
        setSoftware(true);
        setPhase('preparing');
        return;
      }
      fail(error);
    };

    let engine: PreviewRenderer;
    try {
      engine = software ? createCpuPreview(node) : createRenderer(node);
    } catch (error) {
      recover(error);
      return;
    }
    renderer.current = engine;
    setMode(engine.mode);
    if (engine.mode === 'canvas2d' && !software) {
      setFallbackNote(
        'This browser is not providing graphics acceleration, so the preview is drawn on the processor. The edit and the export are the same; very large photographs may redraw more slowly.',
      );
      setSoftware(true);
    }
    setPhase('preparing');

    /* The part of the decoded file the frame keeps, in the bitmap's own pixels.
       Fractions are what survives a reduction: the preview may be drawn from a
       smaller decode than the file, and the same rect means the same window. */
    const shownSize = () => {
      const c = cropRef.current;
      if (!c || isFullFrame(c)) return source;
      const rect = cropPixelRect(c, source.width, source.height);
      return { width: rect.width, height: rect.height };
    };

    const layout = () => {
      const boxNode = found.getBoundingClientRect();
      if (boxNode.width < 1 || boxNode.height < 1) return;
      const shown = shownSize();

      /* Contain, never distort: the smaller of the two ratios wins, so the
         frame's own aspect ratio survives at any window size. */
      const fit = Math.min(boxNode.width / shown.width, boxNode.height / shown.height);
      const cssWidth = Math.max(1, Math.floor(shown.width * fit));
      const cssHeight = Math.max(1, Math.floor(shown.height * fit));
      const budget = engine.mode === 'canvas2d' ? CPU_PREVIEW_PIXELS : GPU_PREVIEW_PIXELS;
      const scale = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(budget / (cssWidth * cssHeight)),
      );

      setBox((previous) =>
        previous.width === cssWidth && previous.height === cssHeight ? previous : { width: cssWidth, height: cssHeight },
      );
      engine.resize(Math.round(cssWidth * scale), Math.round(cssHeight * scale));
      engine.draw(frame.current.params, splitOf(frame.current.view, frame.current.split));
    };

    /* A resize storm — a window drag, an orientation change — would otherwise
       redraw once per observer callback. One frame is enough for the size that
       actually landed. */
    let layoutFrame = 0;
    const runLayout = () => {
      try {
        layout();
      } catch (error) {
        recover(error);
      }
    };
    const observer = new ResizeObserver(() => {
      if (layoutFrame) return;
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        runLayout();
      });
    });
    observer.observe(found);

    decodeOriginal(photo).then(
      (original) => {
        if (!alive) {
          original.bitmap.close();
          return;
        }
        bitmap = original.bitmap;
        source = { width: original.width, height: original.height };
        if (layoutFrame) {
          cancelAnimationFrame(layoutFrame);
          layoutFrame = 0;
        }
        try {
          engine.setSource(bitmap);
          /* A re-decode — a new file, or the software path taking over — meets the
             frame the session is already holding. */
          engine.setCrop(cropRef.current);
          layout();
        } catch (error) {
          recover(error);
          return;
        }
        setNotice(null);
        setPhase('ready');
      },
      (error: unknown) => fail(error),
    );

    layoutRef.current = layout;

    return () => {
      alive = false;
      if (layoutRef.current === layout) layoutRef.current = null;
      if (layoutFrame) cancelAnimationFrame(layoutFrame);
      observer.disconnect();
      if (bitmap) bitmap.close();
      engine.destroy();
      if (renderer.current === engine) renderer.current = null;
    };
  }, [photo, software]);

  /* A different frame is a different shape on the screen, so it is not just a
     redraw: the box is measured again and the renderer is told which window of
     the decode to hand to the pipeline. */
  useEffect(() => {
    if (cropRef.current === crop) return;
    cropRef.current = crop;
    renderer.current?.setCrop(crop);
    layoutRef.current?.();
  }, [crop]);

  /* The frame belongs to the scheduler, so only the scheduler may cancel it —
     and a cancellation must clear the handle. A stale id left here would make
     every later schedule() believe work is already pending. */
  useEffect(
    () => () => {
      if (queued.current) cancelAnimationFrame(queued.current);
      queued.current = 0;
    },
    [],
  );

  useEffect(() => {
    frame.current = { params, view, split };
    schedule();
  }, [params, view, split, schedule]);

  /* One pointer path for mouse, pen and touch. The divider is set from the
     position inside the picture, so a tap and a drag mean the same thing. */
  const positionAt = useCallback((clientX: number, node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    if (rect.width < 1) return;
    setSplit(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (view !== 'split' || event.button > 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      positionAt(event.clientX, event.currentTarget);
    },
    [view, positionAt],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      positionAt(event.clientX, event.currentTarget);
    },
    [positionAt],
  );

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onDividerKey = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, number> = {
      ArrowLeft: -step,
      ArrowDown: -step,
      ArrowRight: step,
      ArrowUp: step,
    };
    if (event.key in moves || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setSplit((previous) => {
        if (event.key === 'Home') return 0;
        if (event.key === 'End') return 1;
        return Math.min(1, Math.max(0, previous + moves[event.key]));
      });
    }
  }, []);

  const dividerPosition = percentOf(split);

  return (
    <div className="stage__frame" ref={host} data-mode={mode}>
      <div
        className={['stage__pane', view === 'split' && 'is-split'].filter(Boolean).join(' ')}
        style={{ width: box.width, height: box.height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas
          key={software ? 'software' : 'hardware'}
          className="stage__canvas"
          ref={canvas}
          role="img"
          aria-label={`${photo.name}, ${photo.width} by ${photo.height} pixels, ${describeAdjustments(values)}${
            crop ? `, framed to ${framingLabel(crop, photo)}` : ''
          }${view === 'split' ? `, shown split at ${dividerPosition}%` : ''}`}
        />

        {view === 'split' && (
          <div className="stage__divider" style={{ left: `${split * 100}%` }}>
            <div
              className="stage__handle"
              role="slider"
              tabIndex={0}
              aria-label="Comparison divider"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={dividerPosition}
              aria-valuetext={`${dividerPosition}% — original to the left, edited to the right`}
              aria-orientation="horizontal"
              onKeyDown={onDividerKey}
              title="Drag, or use the arrow keys"
            >
              <span className="stage__grip" aria-hidden="true" />
            </div>
          </div>
        )}

        <div
          className="stage__view"
          role="group"
          aria-label="Before and after comparison"
          /* A press on the strip chooses a view; it must not also drag the
             divider to the x the button happens to sit at. */
          onPointerDown={(event) => event.stopPropagation()}
        >
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={['caps', 'stage__viewbtn', view === entry.id && 'is-active'].filter(Boolean).join(' ')}
              aria-pressed={view === entry.id}
              title={entry.note}
              onClick={() => setView(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {phase === 'preparing' && (
        <div className="stage__pending">
          <Progress label="Preparing preview" />
          <span className="meta meta--micro">Decoding original</span>
        </div>
      )}

      {phase === 'failed' && (
        <div className="stage__pending stage__pending--signal" role="alert">
          <Icon name="close" size={18} />
          <p className="meta meta--micro stage__pending-text">{notice}</p>
        </div>
      )}

      {mode === 'canvas2d' && phase === 'ready' && (
        <span
          className={['stage__mode', 'meta', 'meta--micro', fallbackNote && 'stage__mode--note']
            .filter(Boolean)
            .join(' ')}
          role={fallbackNote ? 'status' : undefined}
        >
          <span className="stage__mode-long">{fallbackNote ?? 'software pipeline'}</span>
          {fallbackNote && (
            <span className="stage__mode-short">
              Processor preview — same edit, same export.
            </span>
          )}
        </span>
      )}
    </div>
  );
}
