import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ExecutionSummary } from '@recurr/core/types';
import { api } from '../api';
import { useApi } from '../hooks';
import { fmtMs, fmtTimeShort } from '../lib/format';
import { Empty, ErrorState, Loading } from '../components/states';
import { StatusBadge } from '../components/bits';

type SortKey = 'capturedAt' | 'durationMs' | 'status' | 'service';
type StatusBucket = 'all' | 'error' | '5xx' | '4xx' | '2xx';

const LIST_LIMIT = 500;
const SORT_KEYS: SortKey[] = ['capturedAt', 'durationMs', 'status', 'service'];

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
  const q = useApi(() => api.listExecutions({ kind: 'incident', limit: LIST_LIMIT }), []);
  const replays = useApi(() => api.listExecutions({ kind: 'replay', limit: 1000 }), []);
  const replayCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of replays.data ?? []) {
      if (r.replayOf) m.set(r.replayOf, (m.get(r.replayOf) ?? 0) + 1);
    }
    return m;
  }, [replays.data]);

  // Filter/sort state lives in the URL — survives back/forward, refresh, and
  // is shareable (Services page drills in with ?svc=/&env= pre-set).
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const service = params.get('svc') ?? 'all';
  const env = params.get('env') ?? 'all';
  const statusParam = params.get('st') ?? 'all';
  const status: StatusBucket = (['all', 'error', '5xx', '4xx', '2xx'] as StatusBucket[]).includes(statusParam as StatusBucket) ? (statusParam as StatusBucket) : 'all';
  const sortKey = (SORT_KEYS.includes(params.get('sk') as SortKey) ? params.get('sk') : 'capturedAt') as SortKey;
  const sortDir = params.get('sd') === 'asc' ? 1 : -1;
  const setParam = (k: string, v: string | undefined) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (v === undefined || v === '' || v === 'all') p.delete(k);
        else p.set(k, v);
        return p;
      },
      { replace: true },
    );
  };
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
    return [...list].sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
    });
  }, [q.data, search, service, env, status, sortKey, sortDir]);

  const th = (key: SortKey, label: string) => (
    <th className="sortable" aria-sort={sortKey === key ? (sortDir === 1 ? 'ascending' : 'descending') : undefined}>
      <button
        className="th-sort"
        onClick={() => {
          // One setParams call — sequential calls each see the same stale
          // location snapshot, so the last navigation would win silently.
          setParams(
            (prev) => {
              const p = new URLSearchParams(prev);
              p.set('sk', key);
              if (sortKey === key && sortDir === -1) p.set('sd', 'asc');
              else p.delete('sd');
              return p;
            },
            { replace: true },
          );
        }}
      >
        {label} {sortKey === key ? (sortDir === 1 ? '↑' : '↓') : ''}
      </button>
    </th>
  );

  return (
    <div className="page">
      <div className="page-h">
        <span className="page-title">Incidents</span>
        <div className="filterbar">
          <input ref={searchRef} type="text" className="search-input" placeholder="filter by id, path, error, service — / to focus" value={search} onChange={(e) => setParam('q', e.target.value)} />
          <select value={service} onChange={(e) => setParam('svc', e.target.value)} aria-label="service">
            <option value="all">all services</option>
            {services.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select value={env} onChange={(e) => setParam('env', e.target.value)} aria-label="environment">
            <option value="all">all envs</option>
            {envs.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select value={status} onChange={(e) => setParam('st', e.target.value)} aria-label="status">
            <option value="all">all statuses</option>
            <option value="error">error thrown</option>
            <option value="5xx">5xx</option>
            <option value="4xx">4xx</option>
            <option value="2xx">&lt;400</option>
          </select>
        </div>
        <span className="dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
          {rows.length} {q.data && `of ${q.data.length}`} incidents
          {(q.data?.length ?? 0) >= LIST_LIMIT && <span className="faint" title={`list is capped at ${LIST_LIMIT}`}> (latest {LIST_LIMIT})</span>}
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
