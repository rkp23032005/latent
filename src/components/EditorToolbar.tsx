import { Link } from 'react-router-dom';
import { btnClass } from './Button';
import { Icon } from './Icon';
import { UploadButton } from './UploadButton';
import { Wordmark } from './Wordmark';
import { formatLabel, type Photo } from '../lib/photoStore';

type ToolbarProps = {
  photo: Photo | null;
  onFile: (file: File) => void;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  steps: number;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onProjects: () => void;
};

/** The history count is a fact about the session, not a second button. */
function stepLabel(steps: number): string {
  if (steps === 0) return 'No changes';
  return steps === 1 ? '1 change' : `${steps} changes`;
}

export function EditorToolbar({
  photo,
  onFile,
  busy,
  canUndo,
  canRedo,
  steps,
  onUndo,
  onRedo,
  onExport,
  onProjects,
}: ToolbarProps) {
  return (
    <header className="bar">
      <div className="bar__group bar__group--start">
        <Link
          className={btnClass('secondary', 'sm')}
          to="/"
          title="Back to the homepage"
          aria-label="Home"
        >
          <Icon className="btn__icon" name="arrowLeft" size={16} />
          <span className="bar__label">Home</span>
        </Link>
        <Wordmark />
      </div>

      <div className="bar__group bar__group--center" role="group" aria-label="History">
        <button
          type="button"
          className="btn btn--secondary btn--icon"
          disabled={!canUndo}
          onClick={onUndo}
          aria-label="Undo"
          title={canUndo ? 'Undo the last change (Ctrl+Z)' : 'Nothing to undo yet'}
        >
          <Icon name="undo" size={17} />
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--icon"
          disabled={!canRedo}
          onClick={onRedo}
          aria-label="Redo"
          title={canRedo ? 'Redo the next change (Ctrl+Shift+Z)' : 'Nothing to redo'}
        >
          <Icon name="redo" size={17} />
        </button>
        <span className="bar__pending caps" aria-live="polite" aria-label="History">
          {stepLabel(steps)}
        </span>
      </div>

      <div className="bar__group bar__group--end">
        <span className="meta meta--micro bar__file" title={photo ? photo.name : undefined}>
          {photo ? formatLabel(photo) : 'No photograph loaded'}
        </span>

        <UploadButton
          id="replace-photo-input"
          label={photo ? 'Replace' : 'Upload'}
          variant="secondary"
          size="sm"
          icon={photo ? 'folder' : 'upload'}
          busy={busy}
          onFile={onFile}
        />

        <button
          type="button"
          className={btnClass('secondary', 'sm')}
          aria-label="Projects"
          onClick={onProjects}
          title="Save this recipe on this device, or restore an earlier one"
        >
          <Icon className="btn__icon" name="layers" size={16} />
          <span className="bar__label">Projects</span>
        </button>

        <button
          type="button"
          className={btnClass('primary', 'sm')}
          aria-label="Export"
          disabled={!photo}
          onClick={onExport}
          title={photo ? 'Write a JPEG or PNG of this edit' : 'Load a photograph to export it'}
        >
          <Icon className="btn__icon" name="download" size={16} />
          <span className="bar__label">Export</span>
        </button>
      </div>
    </header>
  );
}
