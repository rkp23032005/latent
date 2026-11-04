import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Progress } from './Progress';
import { DropZone } from './DropZone';
import { FramingBar } from './FramingBar';
import { PreviewCanvas } from './PreviewCanvas';
import { formatLabel, type Photo } from '../lib/photoStore';
import { describeAdjustments, isIdentity, type Adjustments } from '../lib/image/adjustments';
import type { CropRect } from '../lib/image/crop';
import type { WorkspaceStatus } from '../lib/usePhotoLoader';

type StageProps = {
  photo: Photo | null;
  values: Adjustments;
  /** Skin tone protection, 0–100, as the session holds it. */
  skinGuard: number;
  /** Where the picture is cut, and the only way a frame is ever chosen. */
  crop: CropRect | null;
  onCrop: (crop: CropRect | null, gesture?: 'across' | 'down' | 'size' | null) => void;
  status: WorkspaceStatus;
  error: { code: string; message: string } | null;
  onFile: (file: File) => void;
  onDismissError: () => void;
};

/** The headline surface: the photograph, or an honest account of why it isn't. */
export function PhotoStage({
  photo,
  values,
  skinGuard,
  crop,
  onCrop,
  status,
  error,
  onFile,
  onDismissError,
}: StageProps) {
  const [settled, setSettled] = useState(false);

  // The photograph is decoded before it reaches the stage, so the fade is
  // timed off the paint after a new url arrives rather than an img load event
  // that can fire while React is still attaching handlers.
  useEffect(() => {
    if (!photo) return;
    setSettled(false);
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [photo]);

  if (status === 'empty') {
    return (
      <section className="stage stage--empty" aria-labelledby="stage-empty-title">
        <div className="stage__notice">
          <span className="stage__mark" aria-hidden="true">
            <Icon name="image" size={30} />
          </span>
          <p className="caps">The stage is empty</p>
          <h2 className="display display--m" id="stage-empty-title">
            Put a photograph here.
          </h2>
          <p className="lede stage__lede">
            Drag a file anywhere onto this window, or choose one below. It is read in this tab and
            never sent to a server.
          </p>
          <DropZone
            id="stage-photo-input"
            index="STAGE"
            title="Drop a photograph"
            hint="JPEG, PNG or WebP · up to 40 MB"
            onFile={onFile}
          />
        </div>
      </section>
    );
  }

  if (status === 'invalid' || status === 'failed') {
    return (
      <section className="stage stage--error" aria-live="assertive" aria-labelledby="stage-error-title">
        <div className="stage__notice">
          <span className="stage__mark stage__mark--signal" aria-hidden="true">
            <Icon name={status === 'invalid' ? 'close' : 'history'} size={26} />
          </span>
          <p className="caps caps--signal">
            {status === 'invalid' ? 'Unsupported file' : 'Could not open the file'}
          </p>
          <h2 className="display display--m" id="stage-error-title">
            {status === 'invalid'
              ? 'That one is not a photograph we take.'
              : error?.code === 'too-large'
                ? 'That file is too large to open.'
                : 'The file would not decode.'}
          </h2>
          <p className="lede stage__lede">{error?.message}</p>
          <DropZone
            id="stage-retry-input"
            index="RETRY"
            title="Try another file"
            hint="JPEG, PNG or WebP · up to 40 MB"
            onFile={onFile}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="stage" aria-label="Photograph preview">
      {/* A replacement in flight keeps the previous print on the stage. */}
      {status === 'loading' && (
        <div className="stage__loading">
          <Progress label="Reading photograph" />
          <span className="meta meta--micro">Decoding…</span>
        </div>
      )}

      {photo && (
        <figure className={['stage__plate', settled && 'is-settled'].filter(Boolean).join(' ')}>
          <PreviewCanvas photo={photo} values={values} skinGuard={skinGuard} crop={crop} />
          <figcaption className="stage__meta">
            <span className="stage__facts">
              <span className="meta meta--micro stage__file" title={photo.name}>
                {photo.name}
              </span>
              <span className="meta meta--micro">{formatLabel(photo)}</span>
              <span className="meta meta--micro">{photo.orientation}</span>
            </span>
            <span
              className={[
                'meta',
                'meta--micro',
                'stage__edited',
                !isIdentity(values) && 'is-moved',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {describeAdjustments(values)}
              {skinGuard > 0 ? ` · skin guard ${Math.round(skinGuard)}%` : ''}
            </span>
          </figcaption>
          <FramingBar photo={photo} crop={crop} onCrop={onCrop} />
        </figure>
      )}

      {error && photo && (
        <div className="stage__banner" role="alert">
          <Icon name="close" size={15} />
          <span className="meta meta--micro">{error.message}</span>
          <button
            type="button"
            className="stage__banner-x"
            onClick={onDismissError}
            aria-label="Dismiss"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </section>
  );
}
