import type { EventKind } from '@recurr-dev/core/types';
import { statusClass } from '../lib/format';

/* Small presentational primitives. */

export function StatusBadge({ status }: { status: number | undefined }) {
  return <span className={`st st-${statusClass(status)}`}>{status ?? '—'}</span>;
}

const KIND_META: Record<EventKind, { cls: string; label: string }> = {
  'http.in': { cls: 'k-http-in', label: 'http.in' },
  'db.query': { cls: 'k-db', label: 'db.query' },
  'http.out': { cls: 'k-http-out', label: 'http.out' },
  error: { cls: 'k-error', label: 'error' },
  retry: { cls: 'k-retry', label: 'retry' },
  log: { cls: 'k-log', label: 'log' },
  custom: { cls: 'k-custom', label: 'custom' },
  'replay.note': { cls: 'k-note', label: 'replay.note' },
};

export function KindBadge({ kind }: { kind: EventKind | string }) {
  const meta = KIND_META[kind as EventKind] ?? { cls: 'k-log', label: kind };
  return (
    <span className="kind-tag">
      <span className={`kind-dot ${meta.cls}`} />
      {meta.label}
    </span>
  );
}

export function KindDot({ kind }: { kind: EventKind | string }) {
  const meta = KIND_META[kind as EventKind] ?? { cls: 'k-log' };
  return <span className={`kind-dot ${meta.cls}`} />;
}

/** "REDACTED" marker matching what the redaction engine stores. */
export function isRedactedValue(v: unknown): boolean {
  return typeof v === 'string' && v.includes('[REDACTED]');
}
