import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../hooks';
import { fmtMs, fmtTimeShort } from '../lib/format';
import { Empty, ErrorState, Loading } from '../components/states';
import { StatusBadge } from '../components/bits';

/* All replay records — grouped under their source incident. */

export function ReplaysPage() {
  const nav = useNavigate();
  const q = useApi(() => api.listExecutions({ kind: 'replay', limit: 500 }), []);
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const setSearch = (v: string) =>
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (v) p.set('q', v);
      else p.delete('q');
      return p;
    }, { replace: true });

  const rows = useMemo(() => {
    let list = q.data ?? [];
    if (search) {
      const n = search.toLowerCase();
      list = list.filter((s) => [s.id, s.replayOf, s.service, s.errorName].filter(Boolean).some((v) => String(v).toLowerCase().includes(n)));
    }
    return list;
  }, [q.data, search]);

  return (
    <div className="page">
      <div className="page-h">
        <span className="page-title">Replays</span>
        <input type="text" className="search-input" placeholder="filter by id, incident, service" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="dim" style={{ marginLeft: 'auto', fontSize: 11 }}>{rows.length} replays</span>
      </div>
      <div className="page-body">
        {q.loading ? (
          <Loading label="loading replays" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={q.refetch} />
        ) : rows.length === 0 ? (
          <Empty
            title="no replays yet"
            hint="open an incident and press ↺ replay — replay records appear here and under the incident's replay count"
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>status</th>
                <th>replay id</th>
                <th>incident</th>
                <th>request</th>
                <th>service</th>
                <th>duration</th>
                <th>captured</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} onClick={() => nav(`/replays/${s.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/replays/${s.id}`)}>
                  <td><StatusBadge status={s.status} /></td>
                  <td className="mono nowrap">{s.id}</td>
                  <td className="mono nowrap">
                    {s.replayOf ? (
                      <Link to={`/incidents/${s.replayOf}`} onClick={(e) => e.stopPropagation()}>
                        {s.replayOf}
                      </Link>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td className="mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span className="dim">{s.method}</span> {s.path ?? '—'}
                  </td>
                  <td>{s.service}</td>
                  <td className="mono nowrap">{fmtMs(s.durationMs)}</td>
                  <td className="dim nowrap">{fmtTimeShort(s.capturedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
