import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

type PanelProps = {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
};

/**
 * The one dialog shell. A native <dialog> gives Escape, focus containment and
 * the top layer for free; only the surface is ours to draw.
 */
export function Panel({ title, eyebrow, onClose, children, footer, wide = false }: PanelProps) {
  const node = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = node.current;
    if (!dialog) return;
    /* The dialog unmounts when React closes it, which can happen before the
       native close() has put focus back where it came from. Remember the
       trigger and restore it ourselves. */
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={node}
      className={['sheet', wide && 'sheet--wide'].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === node.current) onClose();
      }}
    >
      <div className="sheet__inner">
        <header className="sheet__head">
          <div className="sheet__heading">
            <p className="caps sheet__eyebrow">{eyebrow}</p>
            <h2 className="sheet__title" id={titleId}>
              {title}
            </h2>
          </div>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="sheet__body">{children}</div>

        {footer && <footer className="sheet__foot">{footer}</footer>}
      </div>
    </dialog>
  );
}
