import { useState } from 'react';

type PlateProps = {
  src: string;
  alt: string;
  /** Left caption — what the frame is. */
  caption?: string;
  /** Right caption — the frame number. */
  no?: string;
  aspectRatio?: string;
  className?: string;
  perfs?: boolean;
};

/** A photograph presented as a print: mount, hairline, caption strip. */
export function Plate({
  src,
  alt,
  caption,
  no,
  aspectRatio = '3 / 4',
  className,
  perfs = false,
}: PlateProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <figure className={['frame', className].filter(Boolean).join(' ')}>
      {perfs && <span className="frame__perfs frame__perfs--left" aria-hidden="true" />}

      <div className="frame__window" style={{ aspectRatio }}>
        {!loaded && <div className="skeleton frame__skeleton" />}
        <img
          className="frame__image"
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          data-ready={loaded || undefined}
          onLoad={() => setLoaded(true)}
        />
      </div>

      {(caption || no) && (
        <figcaption className="frame__caption">
          <span className="meta meta--micro">{caption}</span>
          <span className="meta meta--micro">{no}</span>
        </figcaption>
      )}
    </figure>
  );
}
