import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../hooks';
import { fmtTimeShort } from '../lib/format';
import { Empty, ErrorState, Loading } from '../components/states';
import { statusClass } from '../lib/format';

/* Services — grouped view of the services+environments present in the store.
   Derived from incident summaries; no synthetic service registry exists. */

export function ServicesPage() {
  const nav = useNavigate();
  const q = useApi(() => api.listExecutions({ limit: 500 }), []);

  const groups = useMemo(() => {
    const m = new Map<string, { service: string; env: string; incidents: number; replays: number; errors: number; last: string }>();
    for (const s of q.data ?? []) {
      const key = `${s.service}::${s.env}`;
      const g = m.get(key) ?? { service: s.service, env: s.env, incidents: 0, replays: 0, errors: 0, last: '' };
      if (s.kind === 'incident') {
        g.incidents++;
        // A replayed 500 is the system working — only incidents count as failures.
        if (s.errorName || (s.status ?? 0) >= 500) g.errors++;
      } else g.replays++;
      if (s.capturedAt > g.last) g.last = s.capturedAt;
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => b.last.localeCompare(a.last));
  }, [q.data]);

  return (
    <div className="page">
      <div className="page-h">
        <span className="page-title">Services</span>
        <span className="dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
          derived from stored records — no service registry exists yet
        </span>
      </div>
      <div className="page-body">
        {q.loading ? (
          <Loading label="loading services" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={q.refetch} />
        ) : groups.length === 0 ? (
          <Empty title="no services" hint="services appear here once @recurr/sdk captures executions" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>service</th>
                <th>environment</th>
                <th>incidents</th>
                <th>errors</th>
                <th>replays</th>
                <th>last capture</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={`${g.service}:${g.env}`} onClick={() => nav(`/incidents`)} tabIndex={0}>
                  <td style={{ fontWeight: 500 }}>{g.service}</td>
                  <td><span className="chip">{g.env}</span></td>
                  <td className="mono">{g.incidents}</td>
                  <td className="mono" style={{ color: g.errors ? 'var(--err)' : 'var(--text-faint)' }}>{g.errors}</td>
                  <td className="mono">{g.replays}</td>
                  <td className="dim nowrap">{fmtTimeShort(g.last)}</td>
                  <td>
                    {g.errors > 0 && <span className={`st st-${statusClass(500)}`}>failing</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
