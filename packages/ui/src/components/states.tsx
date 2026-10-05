import type { ReactNode } from 'react';
import { ApiError } from '../api';

/* Loading / empty / error states — used by every page. */

export function Loading({ label = 'loading' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <div className="spin" />
      <div className="dim">{label}…</div>
    </div>
  );
}

export function Empty({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="state">
      <div className="title">{title}</div>
      {hint && <div className="hint">{hint}</div>}
      {children}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error | undefined; onRetry?: () => void }) {
  return (
    <div className="state" role="alert">
      <div className="title" style={{ color: 'var(--err)' }}>
        {error instanceof ApiError && error.status === 0 ? 'server unreachable' : 'failed to load'}
      </div>
      <div className="hint mono">{error?.message ?? 'unknown error'}</div>
      {error instanceof ApiError && error.status === 0 && (
        <div className="hint">
          Start the collector: <span className="mono">recurr-server</span> (default :4780), or set{' '}
          <span className="mono">RECURR_API</span> for the dev server proxy.
        </div>
      )}
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          retry
        </button>
      )}
    </div>
  );
}
