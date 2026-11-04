import { useMemo } from 'react';
import { Icon } from './Icon';
import type { Photo } from '../lib/photoStore';
import {
  bestPlacement,
  centreCrop,
  clampCrop,
  cropRatio,
  cropTravel,
  detailShareOf,
  framingLabel,
  framingsFor,
  isFullFrame,
  largestWindow,
  percent,
  placeCrop,
  retainedArea,
  scaleCrop,
  type CropRect,
  type DetailMap,
  type SourceSize,
} from '../lib/image/crop';
import { useDetailMap } from '../lib/image/framing';

/**
 * The frame the photograph is shown and written at.
 *
 * Nothing is cropped until a control is pressed, and the whole file is one press
 * away from then on: the frame is a parameter the renderer reads, not something
 * done to the user's file. The geometry is in `crop.ts`, the measurement in
 * `framing.ts`, and this component states both in numbers a person can check —
 * how much of the picture is left, how much of its measured detail came with it.
 *
 * The marks on three of the chips are a ranking of detail kept per area retained.
 * That is all they claim. They are not advice about composition, and they are not
 * a detector: the measure is local contrast, so a shingle roof or a band of grain
 * will out-pull a softly lit face, and a photograph whose interest is tonal lands
 * near the centre because there is nothing else for the numbers to follow.
 */

type FramingGesture = 'across' | 'down' | 'size';

type FramingBarProps = {
  photo: Photo;
  crop: CropRect | null;
  onCrop: (crop: CropRect | null, gesture?: FramingGesture | null) => void;
};

/** How far this frame is from the largest window of its own shape. */
function scaleOf(crop: CropRect, source: SourceSize): number {
  const largest = largestWindow(cropRatio(crop, source), source);
  if (!(largest.w > 0)) return 1;
  return Math.min(1, Math.max(0.3, crop.w / largest.w));
}

function fitSentence(map: DetailMap | null, crop: CropRect): string {
  const share = detailShareOf(map, crop);
  if (share === null) {
    return 'The photograph has not been measured, so this frame is placed by its shape alone.';
  }
  return `This frame holds ${percent(share)} of the photograph's measured detail. The measure is local contrast, so texture and noise count as much as a subject does.`;
}

export function FramingBar({ photo, crop, onCrop }: FramingBarProps) {
  const map = useDetailMap(photo);
  const source = useMemo<SourceSize>(() => ({ width: photo.width, height: photo.height }), [photo]);
  const rows = useMemo(() => framingsFor(source, map), [source, map]);
  /* One clamp for the whole render: the controls below only exist for a frame
     that is actually a frame. */
  const framed = isFullFrame(crop) ? null : clampCrop(crop);
  const travel = framed ? cropTravel(framed) : { fx: 0.5, fy: 0.5 };
  const scale = framed ? Math.round(scaleOf(framed, source) * 100) : 100;

  return (
    <div className="framing" role="group" aria-label="Framing">
      <div className="framing__head">
        <span className="caps framing__title">
          <Icon name="crop" size={12} /> Framing
        </span>
        <span className="meta meta--micro framing__state">
          {framed ? framingLabel(framed, source) : 'The whole photograph'}
        </span>
      </div>

      <div className="framing__chips">
        <button
          type="button"
          className={['caps', 'framing__chip', framed === null && 'is-active'].filter(Boolean).join(' ')}
          aria-pressed={framed === null}
          onClick={() => onCrop(null)}
          title="Show every pixel the file holds."
        >
          Whole
        </button>
        {rows.map((row) => {
          const active =
            framed !== null &&
            Math.abs(cropRatio(framed, source) - row.ratio.ratio) / row.ratio.ratio < 0.01;
          return (
            <button
              key={row.ratio.id}
              type="button"
              className={[
                'caps',
                'framing__chip',
                active && 'is-active',
                row.suggested && 'is-suggested',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-pressed={active}
              onClick={() => onCrop(row.cuts ? row.crop : null)}
              title={
                row.cuts
                  ? `${row.ratio.note} This fit keeps ${percent(row.retained)} of the picture` +
                    `${row.detailShare === null ? '' : ` and ${percent(row.detailShare)} of its measured detail`}.` +
                    ' Nothing is cropped until you press it.'
                  : `${row.ratio.note} The photograph is already this shape, so this puts the whole of it back.`
              }
            >
              {row.ratio.label}
              {row.cuts && <span className="framing__keeps">{percent(row.retained)}</span>}
            </button>
          );
        })}
      </div>

      {framed && (
        <div className="framing__moves">
          <label className="framing__slider">
            <span className="meta meta--micro">Frame size</span>
            <input
              type="range"
              className="quick__slider"
              id="framing-size"
              min={30}
              max={100}
              step={1}
              value={scale}
              aria-describedby="framing-note"
              aria-valuetext={`${percent(retainedArea(framed))} of the photograph left`}
              title="How much of the frame is kept. The shape does not change."
              onChange={(event) =>
                onCrop(scaleCrop(framed, Number(event.target.value) / 100, source), 'size')
              }
            />
          </label>

          <label className="framing__slider">
            <span className="meta meta--micro">Across</span>
            <input
              type="range"
              className="quick__slider"
              id="framing-across"
              min={0}
              max={100}
              step={1}
              value={Math.round(travel.fx * 100)}
              disabled={framed.w > 1 - 1e-6}
              aria-describedby="framing-note"
              title="Slide the frame left and right."
              onChange={(event) =>
                onCrop(placeCrop(framed, Number(event.target.value) / 100, travel.fy), 'across')
              }
            />
          </label>

          <label className="framing__slider">
            <span className="meta meta--micro">Down</span>
            <input
              type="range"
              className="quick__slider"
              id="framing-down"
              min={0}
              max={100}
              step={1}
              value={Math.round(travel.fy * 100)}
              disabled={framed.h > 1 - 1e-6}
              aria-describedby="framing-note"
              title="Slide the frame up and down."
              onChange={(event) =>
                onCrop(placeCrop(framed, travel.fx, Number(event.target.value) / 100), 'down')
              }
            />
          </label>

          <div className="framing__buttons">
            <button
              type="button"
              className="caps framing__button"
              onClick={() => onCrop(centreCrop(framed))}
              title="Put the frame back in the middle of the photograph."
            >
              Centre
            </button>
            <button
              type="button"
              className="caps framing__button"
              disabled={map === null}
              onClick={() => onCrop(bestPlacement(map, framed.w, framed.h).crop)}
              title={
                map === null
                  ? 'The photograph has not been measured, so there is nothing to fit to.'
                  : 'Move the frame to where the picture carries the most local contrast.'
              }
            >
              Fit to detail
            </button>
            <button
              type="button"
              className="caps framing__button"
              onClick={() => onCrop(null)}
              title="Give up the frame and show every pixel again. The file was never changed."
            >
              Give it back
            </button>
          </div>
        </div>
      )}

      <p className="meta meta--micro framing__note" id="framing-note">
        {framed
          ? fitSentence(map, framed)
          : map === null
            ? 'The shapes are offered centred until the photograph has been measured — a few milliseconds after it arrives.'
            : 'The three marked shapes are where this file’s own contrast says the frame would cut best. Press one; nothing is cropped until you do.'}
      </p>
    </div>
  );
}
