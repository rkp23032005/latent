/** Indeterminate loading: a hairline that advances like a film wind. */
export function Progress({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="progress">
        <div className="progress__bar" />
      </div>
    </div>
  );
}
