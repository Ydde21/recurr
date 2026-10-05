import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../hooks';
import { fmtTimeShort } from '../lib/format';
import { Empty, ErrorState, Loading } from '../components/states';

/* Environments — grouped view of the environments present in the store.
   Derived from record summaries; no environment registry exists. */

export function EnvironmentsPage() {
  const nav = useNavigate();
  const q = useApi(() => api.listExecutions({ limit: 500 }), []);

  const groups = useMemo(() => {
    const m = new Map<string, { env: string; services: Set<string>; incidents: number; replays: number; errors: number; last: string }>();
    for (const s of q.data ?? []) {
      const g = m.get(s.env) ?? { env: s.env, services: new Set<string>(), incidents: 0, replays: 0, errors: 0, last: '' };
      g.services.add(s.service);
      if (s.kind === 'incident') {
        g.incidents++;
        if (s.errorName || (s.status ?? 0) >= 500) g.errors++;
      } else g.replays++;
      if (s.capturedAt > g.last) g.last = s.capturedAt;
      m.set(s.env, g);
    }
    return [...m.values()].sort((a, b) => b.last.localeCompare(a.last));
  }, [q.data]);

  return (
    <div className="page">
      <div className="page-h">
        <span className="page-title">Environments</span>
        <span className="dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
          derived from stored records — no environment registry exists
        </span>
      </div>
      <div className="page-body">
        {q.loading ? (
          <Loading label="loading environments" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={q.refetch} />
        ) : groups.length === 0 ? (
          <Empty title="no environments" hint="captured records carry an environment name — they appear here" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>environment</th>
                <th>services</th>
                <th>incidents</th>
                <th>errors</th>
                <th>replays</th>
                <th>last capture</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.env} onClick={() => nav(`/incidents?env=${encodeURIComponent(g.env)}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/incidents?env=${encodeURIComponent(g.env)}`)}>
                  <td style={{ fontWeight: 500 }}>{g.env}</td>
                  <td className="dim">{[...g.services].sort().join(', ')}</td>
                  <td className="mono">{g.incidents}</td>
                  <td className="mono" style={{ color: g.errors ? 'var(--err)' : 'var(--text-faint)' }}>{g.errors}</td>
                  <td className="mono">{g.replays}</td>
                  <td className="dim nowrap">{fmtTimeShort(g.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
