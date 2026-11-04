import { useState, type DragEvent } from 'react';
import { Icon } from './Icon';
import { ACCEPT_ATTR } from '../lib/photoStore';

type DropZoneProps = {
  onFile: (file: File) => void;
  /** Shown while the parent is decoding or handing off. */
  busy?: boolean;
  title?: string;
  hint?: string;
  index?: string;
  id?: string;
};

/**
 * A file picker that also accepts a drop. It does not pretend to edit — it
 * loads a photograph and hands it over.
 */
export function DropZone({
  onFile,
  busy = false,
  title = 'Drop a photograph',
  hint = 'or click to choose a file — JPEG, PNG, WebP',
  index = '01',
  id = 'photo-input',
}: DropZoneProps) {
  const [over, setOver] = useState(false);

  function pick(files: FileList | null) {
    const file = files?.[0];
    if (file) onFile(file);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setOver(false);
    pick(event.dataTransfer.files);
  }

  return (
    <label
      htmlFor={id}
      className={['drop', over && 'drop--over', busy && 'is-busy'].filter(Boolean).join(' ')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <span className="meta meta--micro drop__index">{index}</span>

      <span className="drop__row">
        <span className="drop__glyph">
          <Icon name={busy ? 'history' : 'upload'} size={20} />
        </span>
        <span>
          <span className="title" style={{ display: 'block' }}>
            {busy ? 'Reading your file…' : title}
          </span>
          <span className="drop__hint">{hint}</span>
        </span>
      </span>

      <input
        id={id}
        className="sr-only"
        type="file"
        accept={ACCEPT_ATTR}
        disabled={busy}
        onChange={(e) => {
          pick(e.target.files);
          // Reset so choosing the same file again still fires a change.
          e.target.value = '';
        }}
      />
    </label>
  );
}
