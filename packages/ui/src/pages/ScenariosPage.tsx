import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RegressionScenario } from '@recurr/core/types';
import { api, ApiError } from '../api';
import { useApi } from '../hooks';
import { fmtTimeShort } from '../lib/format';
import { Empty, ErrorState, Loading } from '../components/states';
import { StatusBadge } from '../components/bits';
import { Dialog, TargetFields, type ReplayTargetForm } from '../components/dialogs';

/* Regression scenarios — saved incidents re-runnable against fixed builds. */

export function ScenariosPage() {
  const nav = useNavigate();
  const q = useApi(() => api.listRegressions(), []);
  const replays = useApi(() => api.listExecutions({ kind: 'replay', limit: 1000 }), []);
  const [running, setRunning] = useState<RegressionScenario | undefined>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Replay count per incident. Replay capturedAt is the *replayed* clock, so
  // ordering among them is not meaningful — show counts, not "latest".
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of replays.data ?? []) {
      if (r.replayOf) m.set(r.replayOf, (m.get(r.replayOf) ?? 0) + 1);
    }
    return m;
  }, [replays.data]);

  return (
    <div className="page">
      <div className="page-h">
        <span className="page-title">Regression scenarios</span>
        <span className="dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
          {q.data?.length ?? 0} scenarios
        </span>
      </div>
      <div className="page-body">
        {q.loading ? (
          <Loading label="loading scenarios" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={q.refetch} />
        ) : !q.data?.length ? (
          <Empty
            title="no regression scenarios"
            hint="open an incident and press ★ save scenario — it becomes a permanent check you can re-run against fixed builds"
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>id</th>
                <th>name</th>
                <th>incident</th>
                <th>bug status</th>
                <th>created</th>
                <th>replays</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((s) => {
                const n = counts.get(s.incidentId) ?? 0;
                return (
                  <tr key={s.id} onClick={() => nav(`/incidents/${s.incidentId}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/incidents/${s.incidentId}`)}>
                    <td className="mono nowrap">{s.id}</td>
                    <td style={{ maxWidth: 280 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                      {s.notes && <div className="faint" style={{ fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.notes}</div>}
                    </td>
                    <td className="mono nowrap">
                      <Link to={`/incidents/${s.incidentId}`} onClick={(e) => e.stopPropagation()}>{s.incidentId}</Link>
                    </td>
                    <td><StatusBadge status={s.expectedBugStatus} /></td>
                    <td className="dim nowrap">{fmtTimeShort(s.createdAt)}</td>
                    <td className="mono nowrap">
                      {n > 0 ? (
                        <span className="chip mono" title={`${n} replay(s) recorded`}>↺ {n}</span>
                      ) : (
                        <span className="faint">never run</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="btn small"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRunning(s);
                        }}
                      >
                        ▶ run
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {running && (
        <RunScenarioDialog
          scenario={running}
          onClose={() => setRunning(undefined)}
          onDone={(replayId) => {
            if (!mounted.current) return;
            setRunning(undefined);
            nav(`/incidents/${running.incidentId}/diff/${replayId}`);
          }}
        />
      )}
    </div>
  );
}

function RunScenarioDialog({ scenario, onClose, onDone }: { scenario: RegressionScenario; onClose: () => void; onDone: (replayId: string) => void }) {
  const [form, setForm] = useState<ReplayTargetForm>({ command: 'node dist/index.js', cwd: '', timeoutMs: '60000' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const run = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const res = await api.runRegression(
        scenario.id,
        { command: form.command.trim(), ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}) },
        { timeoutMs: Number(form.timeoutMs) || undefined },
      );
      onDone(res.replayId);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={<>run scenario <span className="mono">{scenario.id}</span></>}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          {err && <span className="mono" style={{ color: 'var(--err)', fontSize: 11, marginRight: 'auto', maxWidth: 300 }}>{err}</span>}
          <button className="btn" onClick={onClose} disabled={busy}>cancel</button>
          <button className="btn primary" onClick={() => void run()} disabled={busy || !form.command.trim()}>
            {busy ? 'running…' : 'run against target'}
          </button>
        </>
      }
    >
      <div className="hint">
        replays <span className="mono">{scenario.incidentId}</span> inside an isolated process. The bug{' '}
        <b>{scenario.expectedBugStatus !== undefined ? `reproduces if the outcome matches HTTP ${scenario.expectedBugStatus}` : 'reproduces if the outcome matches'}</b>
        — a changed outcome means the fix worked.
      </div>
      <TargetFields form={form} setForm={setForm} />
    </Dialog>
  );
}
