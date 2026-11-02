import { Link } from 'react-router-dom';
import { brand } from '../brand';

/**
 * Wordmark: a frame marker, the name in the display face, and the signal dot
 * that stands for the safelight. Deliberately typographic, not a logo blob.
 */
export function Wordmark({ to = '/' }: { to?: string }) {
  return (
    <Link className="wordmark" to={to} aria-label={`${brand.name} — home`}>
      <svg width="17" height="17" viewBox="0 0 17 17" aria-hidden="true" focusable="false">
        <rect
          x="0.75"
          y="2.75"
          width="15.5"
          height="11.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <rect x="4.5" y="5.5" width="8" height="6" fill="currentColor" opacity="0.18" />
      </svg>
      <span className="wordmark__text">{brand.mark}</span>
      <span className="wordmark__dot" aria-hidden="true" />
      <span className="wordmark__sup">{brand.superscript}</span>
    </Link>
  );
}
