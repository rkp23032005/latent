import { useMemo, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { Panel } from './Panel';
import { Progress } from './Progress';
import { formatBytes, type Photo } from '../lib/photoStore';
import { describeAdjustments, type Adjustments } from '../lib/image/adjustments';
import {
  ExportError,
  downloadBlob,
  exportName,
  exportSize,
  renderExport,
  type ExportFormat,
  type ExportPhase,
  type ExportResult,
} from '../lib/image/export';

type ExportPanelProps = {
  photo: Photo;
  values: Adjustments;
  onClose: () => void;
};

const PHASE_TEXT: Record<ExportPhase, string> = {
  preparing: 'Decoding the original file',
  rendering: 'Applying the recipe to every pixel',
  encoding: 'Writing the file',
};

/**
 * Export is a conversation about what will be written, not a button that
 * vanishes. The size and filename are known before the work starts, the phase
 * is named while it runs, and a failure says so instead of showing a tick.
 */
export function ExportPanel({ photo, values, onClose }: ExportPanelProps) {
  const [format, setFormat] = useState<ExportFormat>('jpeg');
  const [quality, setQuality] = useState(90);
  const [phase, setPhase] = useState<ExportPhase | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = phase !== null;
  const planned = useMemo(() => exportSize(photo), [photo]);
  const filename = exportName(photo, format);
  const recipe = useMemo(() => describeAdjustments(values), [values]);

  function choose(next: ExportFormat) {
    if (next === format || busy) return;
    setFormat(next);
    setResult(null);
    setError(null);
  }

  async function write() {
    if (busy) return;
    setResult(null);
    setError(null);
    setPhase('preparing');
    try {
      const next = await renderExport(
        photo,
        values,
        { format, quality: quality / 100 },
        (stage) => setPhase(stage),
      );
      setResult(next);
      downloadBlob(next.blob, next.name);
    } catch (caught) {
      setError(
        caught instanceof ExportError
          ? caught.message
          : 'The export failed before any file was written. The photograph on your device is unchanged.',
      );
    } finally {
      setPhase(null);
    }
  }

  return (
    <Panel
      eyebrow="Output"
      title="Write the edit"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft="download"
            disabled={busy}
            onClick={() => void write()}
          >
            {busy ? 'Writing…' : `Write ${format === 'jpeg' ? 'JPEG' : 'PNG'}`}
          </Button>
        </>
      }
    >
      <p className="sheet__lede body-muted">
        The file on your device is decoded again at its own size and the current recipe is applied
        to it. The finished image is written in this tab and handed to your downloads — nothing is
        uploaded.
      </p>

      <div className="field">
        <span className="meta meta--micro">Format</span>
        <div className="sheet__seg" role="group" aria-label="File format">
          <button
            type="button"
            className={format === 'jpeg' ? 'is-active' : undefined}
            aria-pressed={format === 'jpeg'}
            disabled={busy}
            onClick={() => choose('jpeg')}
          >
            JPEG
          </button>
          <button
            type="button"
            className={format === 'png' ? 'is-active' : undefined}
            aria-pressed={format === 'png'}
            disabled={busy}
            onClick={() => choose('png')}
          >
            PNG
          </button>
        </div>
      </div>

      {format === 'jpeg' && (
        <div className="quick__row">
          <div className="quick__row-head">
            <label className="quick__label" htmlFor="export-quality">
              Quality
            </label>
            <span className={['quick__value', quality !== 90 && 'is-moved'].filter(Boolean).join(' ')}>
              {quality}%
            </span>
          </div>
          <input
            className="quick__slider"
            type="range"
            id="export-quality"
            min={50}
            max={100}
            step={1}
            value={quality}
            disabled={busy}
            aria-describedby="export-quality-hint"
            aria-valuetext={`${quality}%`}
            onChange={(event) => {
              setQuality(Number(event.target.value));
              setResult(null);
            }}
          />
          <span className="meta meta--micro quick__hint" id="export-quality-hint">
            JPEG only. 90 is a good print; 100 keeps the most detail and writes the largest file.
          </span>
        </div>
      )}

      <dl className="export__spec">
        <div className="export__row">
          <dt className="meta meta--micro">File</dt>
          <dd>{filename}</dd>
        </div>
        <div className="export__row">
          <dt className="meta meta--micro">Output</dt>
          <dd>
            {planned.width} × {planned.height} px
            {format === 'png' ? ' · lossless' : ` · quality ${quality}%`}
          </dd>
        </div>
        <div className="export__row">
          <dt className="meta meta--micro">Source</dt>
          <dd>
            {photo.width} × {photo.height} px · {formatBytes(photo.bytes)} ·{' '}
            {photo.mime.replace('image/', '').toUpperCase()}
          </dd>
        </div>
        <div className="export__row">
          <dt className="meta meta--micro">Recipe</dt>
          <dd className="export__recipe" title={recipe}>
            {recipe}
          </dd>
        </div>
      </dl>

      {planned.reduced && (
        <p className="sheet__note">
          This file is larger than one rendering pass will take. The export keeps its aspect ratio
          and is written at {planned.width} × {planned.height} px instead.
        </p>
      )}

      {phase && (
        <div className="sheet__state" role="status">
          <Progress label={PHASE_TEXT[phase]} />
          <span className="meta meta--micro">{PHASE_TEXT[phase]}…</span>
        </div>
      )}

      {result && (
        <div className="sheet__done" role="status">
          <span className="sheet__done-head">
            <Icon name="check" size={15} />
            <span>{result.name} written</span>
          </span>
          <span className="meta meta--micro sheet__done-line">
            {result.width} × {result.height} px · {formatBytes(result.blob.size)}
            {result.reduced ? ` · reduced from ${result.sourceWidth} × ${result.sourceHeight}` : ''}
            {result.mode === 'canvas2d' ? ' · software pipeline' : ''}
          </span>
          <span className="meta meta--micro sheet__done-line">
            If no download appeared, your browser may be holding it behind a prompt.
          </span>
          <Button
            variant="ghost"
            size="sm"
            iconLeft="download"
            onClick={() => downloadBlob(result.blob, result.name)}
          >
            Download again
          </Button>
        </div>
      )}

      {error && (
        <div className="sheet__error" role="alert">
          <Icon name="close" size={16} />
          <p className="meta meta--micro">{error}</p>
        </div>
      )}
    </Panel>
  );
}
