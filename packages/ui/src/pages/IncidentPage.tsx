import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ExecutionRecord, TimelineEvent } from '@recurr-dev/core/types';
import { api } from '../api';
import { useApi, useHotkey } from '../hooks';
import { fmtMs, fmtTime } from '../lib/format';
import { Empty, ErrorState, Loading } from '../components/states';
import { StatusBadge } from '../components/bits';
import { Timeline } from '../components/Timeline';
import { EventInspector } from '../components/EventInspector';
import { FlowGraph } from '../components/FlowGraph';
import { RecordContext } from '../components/RecordContext';
import { ReplayDialog, Dialog, type ReplayTargetForm } from '../components/dialogs';

export function IncidentPage({ isReplay }: { isReplay?: boolean }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const q = useApi(() => api.getRecord(id!), [id]);
  const replaysQ = useApi(() => (id ? api.listReplays(id).catch(() => [] as never) : Promise.resolve([] as never)), [id]);
  const [selEvent, setSelEvent] = useState<TimelineEvent | undefined>();
  const [view, setView] = useState<'timeline' | 'graph'>('timeline');
  const [replayOpen, setReplayOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  // A replay can take a minute — if the user navigates away meanwhile, the
  // deferred navigate() must not fire from an unmounted page.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const record = q.data;
  const replays = useMemo(() => replaysQ.data ?? [], [replaysQ.data]);

  useHotkey((e) => {
    if (!record) return;
    if (e.key === 'r' && record.kind === 'incident') setReplayOpen(true);
    if (e.key === 'd' && replays.length) setDiffOpen(true);
    if (e.key === 'Escape') {
      setReplayOpen(false);
      setDiffOpen(false);
      setSaveOpen(false);
    }
  }, [record, replays.length]);

  const runReplay = async (form: ReplayTargetForm) => {
    const res = await api.startReplay(
      id!,
      { command: form.command.trim(), ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}) },
      { timeoutMs: Number(form.timeoutMs) || undefined },
    );
    if (!mounted.current) return; // replay persisted; user navigated away
    setReplayOpen(false);
    nav(`/incidents/${id}/diff/${res.replayId}`);
  };

  return (
    <div className="page">
      {q.loading ? (
        <Loading label={`loading ${id}`} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={q.refetch} />
      ) : !record ? (
        <Empty title="record not found" />
      ) : (
        <RecordWorkspace
          record={record}
          replays={replays}
          selEvent={selEvent}
          setSelEvent={setSelEvent}
          view={view}
          setView={setView}
          onReplay={() => setReplayOpen(true)}
          onDiff={() => setDiffOpen(true)}
          onSaveScenario={() => setSaveOpen(true)}
        />
      )}

      {replayOpen && record && (
        <ReplayDialog incidentId={record.id} onClose={() => setReplayOpen(false)} onRun={runReplay} />
      )}
      {diffOpen && record && replays.length > 0 && (
        <Dialog title={<>diff {record.id} against…</>} onClose={() => setDiffOpen(false)}>
          {replays.map((r) => (
            <button
              key={r.id}
              className="btn"
              style={{ justifyContent: 'flex-start' }}
              onClick={() => nav(record.kind === 'replay' ? `/incidents/${record.replayOf}/diff/${record.id}` : `/incidents/${record.id}/diff/${r.id}`)}
            >
              <span className="mono">{r.id}</span>
              <StatusBadge status={r.status} />
              <span className="faint">{fmtTime(r.capturedAt)}</span>
            </button>
          ))}
        </Dialog>
      )}
      {saveOpen && record && <SaveScenarioDialog record={record} onClose={() => setSaveOpen(false)} />}
    </div>
  );
}

function RecordWorkspace({
  record,
  replays,
  selEvent,
  setSelEvent,
  view,
  setView,
  onReplay,
  onDiff,
  onSaveScenario,
}: {
  record: ExecutionRecord;
  replays: { id: string; status?: number; capturedAt: string; errorName?: string }[];
  selEvent: TimelineEvent | undefined;
  setSelEvent: (e: TimelineEvent | undefined) => void;
  view: 'timeline' | 'graph';
  setView: (v: 'timeline' | 'graph') => void;
  onReplay: () => void;
  onDiff: () => void;
  onSaveScenario: () => void;
}) {
  const isReplay = record.kind === 'replay';
  return (
    <>
      <div className="record-h">
        <div>
          <div className="record-id">
            {record.id}
            <span className={`st ${isReplay ? 'st-purple' : 'st-info'}`}>{record.kind}</span>
            {record.request && <StatusBadge status={record.response?.status} />}
            {record.error && <span className="st st-err">{record.error.name}</span>}
          </div>
          <div className="record-meta">
            {record.request && (
              <span className="mono">
                {record.request.method} {record.request.url}
              </span>
            )}
            <span>{record.service.name} · {record.environment.name}</span>
            <span>{fmtTime(record.capturedAt)}</span>
            {record.response && <span>{fmtMs(record.response.durationMs)}</span>}
            <span>{record.events.length} events</span>
          </div>
        </div>
        <div className="record-actions">
          {!isReplay && (
            <button className="btn primary" onClick={onReplay} title="replay this incident (r)">
              ↺ replay <kbd>r</kbd>
            </button>
          )}
          {replays.length > 0 && (
            <button className="btn" onClick={onDiff} title="diff against a replay (d)">
              ⇄ diff <kbd>d</kbd>
            </button>
          )}
          {isReplay && record.replayOf && (
            <Link className="btn" to={`/incidents/${record.replayOf}/diff/${record.id}`}>
              ⇄ diff vs {record.replayOf}
            </Link>
          )}
          {!isReplay && (
            <button className="btn" onClick={onSaveScenario}>
              ★ save scenario
            </button>
          )}
        </div>
      </div>

      {isReplay && (
        <div className="banner info">
          replay record — generated inside an isolated replay process of{' '}
          <Link to={`/incidents/${record.replayOf}`}>{record.replayOf}</Link>; outbound calls were served from the
          record, not the real network.
        </div>
      )}
      {isReplay && !record.replayOf && <div className="banner warn">replay record without a linked incident — cannot diff</div>}
      {record.environment.name === 'replay' && !isReplay && (
        <div className="banner warn">captured inside a replay environment — treated as an incident record</div>
      )}
      {record.redaction.truncatedPaths.length > 0 && (
        <div className="banner warn">
          capture truncated {record.redaction.truncatedPaths.join(', ')} — record is honest about the gap; replay uses
          the clipped payload.
        </div>
      )}

      <div className="ws">
        <div className="ws-main">
          <div className="ws-tabs" role="tablist">
            <button className={view === 'timeline' ? 'active' : ''} onClick={() => setView('timeline')} role="tab" aria-selected={view === 'timeline'}>
              Timeline · {record.events.length}
            </button>
            <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')} role="tab" aria-selected={view === 'graph'}>
              Flow graph
            </button>
          </div>
          {view === 'timeline' ? (
            record.events.length === 0 ? (
              <Empty title="no events captured" hint="the record has no timeline events — see request/response/context in the right panel" />
            ) : (
              <Timeline events={record.events} selected={selEvent?.seq} onSelect={setSelEvent} />
            )
          ) : (
            <FlowGraph record={record} />
          )}
          {selEvent && view === 'timeline' && (
            <div style={{ borderTop: '1px solid var(--border)', maxHeight: 280, overflowY: 'auto', background: 'var(--bg-1)', flexShrink: 0 }}>
              <div className="flex" style={{ padding: '4px 12px 0', justifyContent: 'space-between' }}>
                <span className="faint" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4 }}>event detail</span>
                <button className="btn small" onClick={() => setSelEvent(undefined)}>close ✕</button>
              </div>
              <EventInspector event={selEvent} />
            </div>
          )}
        </div>
        <div className="ws-side">
          <RecordContext record={record} />
        </div>
      </div>

      <div className="footer-hint">
        <span><kbd>j</kbd>/<kbd>k</kbd> move</span>
        <span><kbd>g</kbd>/<kbd>G</kbd> first/last event</span>
        <span><kbd>r</kbd> replay</span>
        <span><kbd>d</kbd> diff</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </>
  );
}

function SaveScenarioDialog({ record, onClose }: { record: ExecutionRecord; onClose: () => void }) {
  const nav = useNavigate();
  const incidentRef = record.kind === 'replay' && record.replayOf ? record.replayOf : record.id;
  const [name, setName] = useState(`${record.service.name} ${record.error?.name ?? 'incident'}`);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const existing = useApi(() => api.listRegressions().then((l) => l.find((s) => s.incidentId === incidentRef)), [incidentRef]);
  const save = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.saveRegression({
        id: `REG-${incidentRef.replace(/^[A-Z]+-/, '')}`,
        name: name.trim() || 'unnamed scenario',
        incidentId: incidentRef,
        createdAt: new Date().toISOString(),
        expectedBugStatus: record.response?.status,
        notes: notes.trim() || undefined,
      });
      nav('/scenarios');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={<>save regression scenario</>}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          {err && <span className="mono" style={{ color: 'var(--err)', fontSize: 11, marginRight: 'auto' }}>{err}</span>}
          <button className="btn" onClick={onClose} disabled={busy}>cancel</button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'saving…' : 'save scenario'}
          </button>
        </>
      }
    >
      <div className="hint">
        promotes <span className="mono">{incidentRef}</span> to a permanent regression scenario — re-run it against a
        fixed build to verify the incident no longer reproduces.
        {record.kind === 'replay' && <> (this record is a replay — the scenario points at its source incident)</>}
      </div>
      {existing.data && (
        <div className="banner warn" style={{ marginBottom: 8 }}>
          scenario <span className="mono">{existing.data.id}</span> already watches this incident — saving overwrites it
        </div>
      )}
      <div className="field">
        <label htmlFor="s-name">name</label>
        <input id="s-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="s-notes">notes (optional)</label>
        <input id="s-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <dl className="kv">
        <dt>expected bug</dt>
        <dd>HTTP {record.response?.status ?? '—'} {record.error ? `· ${record.error.name}` : ''}</dd>
      </dl>
    </Dialog>
  );
}
