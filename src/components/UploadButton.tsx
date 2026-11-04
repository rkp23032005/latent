import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { btnClass, type ButtonSize, type ButtonVariant } from './Button';
import { Icon, type IconName } from './Icon';
import { ACCEPT_ATTR, loadPhotoFromFile, PhotoError } from '../lib/photoStore';

type UploadButtonProps = {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  className?: string;
  id?: string;
  /** Pure picker: hands the raw file over and stays out of the way. */
  onFile?: (file: File) => void;
  /** Parent-owned busy flag, for pure-picker callers. */
  busy?: boolean;
};

/**
 * The one file-picker control. Entry points on the homepage load the photo and
 * route; the toolbar hands the file to the workspace's own loader so every
 * state change runs through a single place.
 */
export function UploadButton({
  label,
  variant = 'primary',
  size = 'md',
  icon = 'upload',
  className,
  id = 'upload-button-input',
  onFile,
  busy: busyProp = false,
}: UploadButtonProps) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = pending || busyProp;

  async function handle(file: File) {
    if (onFile) {
      onFile(file);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await loadPhotoFromFile(file);
      navigate('/edit');
    } catch (e) {
      setError(
        e instanceof PhotoError ? e.message : 'That file could not be opened as a photograph.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="upload-button">
      <label
        className={btnClass(variant, size, [className, busy && 'is-busy'].filter(Boolean).join(' '))}
        htmlFor={id}
      >
        <Icon className="btn__icon" name={busy ? 'history' : icon} size={18} />
        {busy ? 'Reading…' : label}
        <input
          id={id}
          className="sr-only"
          type="file"
          accept={ACCEPT_ATTR}
          disabled={busy}
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handle(file);
            // Reset so choosing the same file again still fires a change.
            e.target.value = '';
          }}
        />
      </label>
      {error && (
        <span className="meta meta--micro upload-button__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
