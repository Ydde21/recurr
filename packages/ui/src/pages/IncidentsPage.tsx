import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExecutionSummary } from '@recurr/core/types';
import { api } from '../api';
import { useApi } from '../hooks';
import { fmtMs, fmtTimeShort } from '../lib/format';
import { Empty, ErrorState, Loading } from '../components/states';
import { StatusBadge } from '../components/bits';

type SortKey = 'capturedAt' | 'durationMs' | 'status' | 'service';
type StatusBucket = 'all' | 'error' | '5xx' | '4xx' | '2xx';

function bucket(s: ExecutionSummary, b: StatusBucket): boolean {
  switch (b) {
    case 'all':
      return true;
    case 'error':
      return s.errorName !== undefined;
    case '5xx':
      return (s.status ?? 0) >= 500;
    case '4xx':
      return (s.status ?? 0) >= 400 && (s.status ?? 0) < 500;
    case '2xx':
      return (s.status ?? 0) < 400 && s.status !== undefined;
  }
}

export function IncidentsPage({ searchRef }: { searchRef?: React.RefObject<HTMLInputElement> }) {
  const nav = useNavigate();
  const q = useApi(() => api.listExecutions({ kind: 'incident', limit: 500 }), []);
  const replays = useApi(() => api.listExecutions({ kind: 'replay', limit: 1000 }), []);
  const replayCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of replays.data ?? []) {
      if (r.replayOf) m.set(r.replayOf, (m.get(r.replayOf) ?? 0) + 1);
    }
    return m;
  }, [replays.data]);
  const [search, setSearch] = useState('');
  const [service, setService] = useState('all');
  const [env, setEnv] = useState('all');
  const [status, setStatus] = useState<StatusBucket>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'capturedAt', dir: -1 });

  const services = useMemo(() => [...new Set((q.data ?? []).map((s) => s.service))].sort(), [q.data]);
  const envs = useMemo(() => [...new Set((q.data ?? []).map((s) => s.env))].sort(), [q.data]);

  const rows = useMemo(() => {
    let list = q.data ?? [];
    if (search) {
      const needle = search.toLowerCase();
      list = list.filter((s) => [s.id, s.path, s.method, s.errorName, s.service].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)));
    }
    if (service !== 'all') list = list.filter((s) => s.service === service);
    if (env !== 'all') list = list.filter((s) => s.env === env);
    list = list.filter((s) => bucket(s, status));
    const dir = sort.dir;
    return [...list].sort((a, b) => {
      const av = a[sort.key] ?? '';
      const bv = b[sort.key] ?? '';
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
  }, [q.data, search, service, env, status, sort]);

  const th = (key: SortKey, label: string) => (
    <th
      className="sortable"
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((s.dir * -1) as 1 | -1) : -1 }))}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
    >
      {label} {sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : ''}
    </th>
  );

  return (
    <div className="page">
      <div className="page-h">
        <span className="page-title">Incidents</span>
        <div className="filterbar">
          <input ref={searchRef} type="text" className="search-input" placeholder="filter by id, path, error, service — / to focus" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={service} onChange={(e) => setService(e.target.value)} aria-label="service">
            <option value="all">all services</option>
            {services.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select value={env} onChange={(e) => setEnv(e.target.value)} aria-label="environment">
            <option value="all">all envs</option>
            {envs.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusBucket)} aria-label="status">
            <option value="all">all statuses</option>
            <option value="error">error thrown</option>
            <option value="5xx">5xx</option>
            <option value="4xx">4xx</option>
            <option value="2xx">&lt;400</option>
          </select>
        </div>
        <span className="dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
          {rows.length} {q.data && `of ${q.data.length}`} incidents
        </span>
      </div>
      <div className="page-body">
        {q.loading ? (
          <Loading label="loading incidents" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={q.refetch} />
        ) : rows.length === 0 ? (
          <Empty
            title={q.data?.length ? 'no incidents match the filters' : 'no incidents captured yet'}
            hint={
              q.data?.length
                ? 'try widening the search or clearing filters'
                : 'instrument a service with @recurr/sdk and it will persist captured executions here'
            }
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>status</th>
                <th>id</th>
                <th>request</th>
                <th>error</th>
                {th('service', 'service')}
                <th>env</th>
                {th('durationMs', 'duration')}
                {th('capturedAt', 'captured')}
                <th>replays</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} onClick={() => nav(`/incidents/${s.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/incidents/${s.id}`)}>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="mono nowrap">{s.id}</td>
                  <td className="mono" style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span className="dim">{s.method}</span> {s.path ?? '—'}
                  </td>
                  <td className="mono" style={{ color: s.errorName ? 'var(--err)' : 'var(--text-faint)' }}>
                    {s.errorName ?? '—'}
                  </td>
                  <td>{s.service}</td>
                  <td className="dim">{s.env}</td>
                  <td className="mono nowrap">{fmtMs(s.durationMs)}</td>
                  <td className="dim nowrap">{fmtTimeShort(s.capturedAt)}</td>
                  <td>
                    {(replayCounts.get(s.id) ?? 0) > 0 ? (
                      <span className="chip mono" title={`${replayCounts.get(s.id)} replay(s)`}>
                        ↺ {replayCounts.get(s.id)}
                      </span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="footer-hint">
        <span><kbd>/</kbd> search</span>
        <span><kbd>↵</kbd> open</span>
        <span>single-service replay — records captured per request lifecycle</span>
      </div>
    </div>
  );
}
