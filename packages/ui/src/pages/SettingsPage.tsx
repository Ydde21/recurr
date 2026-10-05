import { api } from '../api';
import { useApi } from '../hooks';
import { ErrorState, Loading } from '../components/states';

/* Settings — server health, store spec, schema version, and the documented
   capability limits the UI is honest about. Read-only: no invented config. */

const LIMITS: { k: string; v: string }[] = [
  { k: 'record schema', v: 'v1 — validated at ingest; unsafe ids rejected' },
  { k: 'capture body limit', v: '64 KiB default (maxBodyBytes) — clipped bodies are flagged in redaction.truncatedPaths' },
  { k: 'events per record', v: '100,000 max' },
  { k: 'seed values', v: '1,000,000 max' },
  { k: 'replay model', v: 'single-service, child-process isolation — no distributed replay' },
  { k: 'db replay fidelity', v: 'recorded rowsets in order — not a database snapshot' },
  { k: 'filesystem isolation', v: 'not sandboxed — replay untrusted targets only on disposable machines' },
  { k: 'framework support', v: 'express full · fastify/koa via adapter (unparsed body) · hono/fetch-style unsupported' },
  { k: 'native addons', v: 'blocked at replay (process.dlopen) — deps needing them fail honestly' },
];

export function SettingsPage() {
  const q = useApi(() => api.healthz(), []);
  return (
    <div className="page">
      <div className="page-h">
        <span className="page-title">Settings</span>
      </div>
      <div className="page-body" style={{ padding: 14, maxWidth: 760 }}>
        {q.loading ? (
          <Loading label="connecting" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={q.refetch} />
        ) : (
          <>
            <div className="panel" style={{ marginBottom: 14 }}>
              <div className="panel-h">server</div>
              <div className="panel-b">
                <dl className="kv">
                  <dt>status</dt>
                  <dd style={{ color: 'var(--ok)' }}>connected</dd>
                  <dt>service</dt>
                  <dd>{q.data?.service}</dd>
                  <dt>schema</dt>
                  <dd>v{q.data?.schemaVersion}</dd>
                  <dt>store</dt>
                  <dd>{q.data?.store ?? 'not reported'}</dd>
                </dl>
              </div>
            </div>
          </>
        )}
        <div className="panel">
          <div className="panel-h">capability limits</div>
          <div className="panel-b">
            <dl className="kv" style={{ gridTemplateColumns: '180px 1fr', rowGap: 7 }}>
              {LIMITS.map((l) => (
                <LimitRow key={l.k} k={l.k} v={l.v} />
              ))}
            </dl>
            <div className="divider" />
            <div className="hint faint" style={{ fontSize: 11 }}>
              These are the replay core's documented limits — the UI surfaces them rather than implying broader
              support. See README → Known limitations for the full list.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LimitRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd style={{ fontFamily: 'var(--sans)' }}>{v}</dd>
    </>
  );
}
