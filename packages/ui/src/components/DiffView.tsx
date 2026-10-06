import { useMemo, useState } from 'react';
import type { DiffReport, Divergence } from '@recurr-dev/core/diff';
import type { ExecutionRecord } from '@recurr-dev/core/types';
import { diffLines, fmtMs, prettyBody, statusClass } from '../lib/format';
import { Timeline } from './Timeline';
import { JsonTree } from './JsonTree';

/* Original vs Replay diff — score summary, divergence list with navigation,
   synced split timelines, response/error/seed comparison. Uses the engine's
   report verbatim — never recomputes a softer verdict. */

function ScoreRing({ score }: { score: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(100, score)) / 100;
  const color = score >= 99 ? 'var(--ok)' : score >= 70 ? 'var(--warn)' : 'var(--err)';
  return (
    <div className="score" title={`match score ${score}/100`}>
      <svg width={56} height={56} viewBox="0 0 56 56" aria-hidden>
        <circle cx={28} cy={28} r={r} fill="none" stroke="var(--bg-3)" strokeWidth={5} />
        <circle
          cx={28}
          cy={28}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={5}
          strokeDasharray={`${frac * c} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 28 28)"
        />
        <text x={28} y={32} textAnchor="middle" fill={color} fontSize={14} fontWeight={700} fontFamily="var(--mono)">
          {score}
        </text>
      </svg>
    </div>
  );
}

const SEVERITY_LABEL: Record<string, string> = {
  'missing-event': 'missing',
  'extra-event': 'extra',
  'field-mismatch': 'mismatch',
  'response-status': 'status',
  'response-body': 'body',
  error: 'error',
  'seed-usage': 'seed',
};

function sevClass(d: Divergence): string {
  if (d.severity === 'info') return 'st-dim';
  switch (d.type) {
    case 'missing-event':
    case 'error':
    case 'response-status':
    case 'response-body':
      return 'st-err';
    case 'extra-event':
      return 'st-purple';
    default:
      return 'st-warn';
  }
}

function Value({ v }: { v: unknown }) {
  if (v === undefined) return <span className="jt-null">—</span>;
  if (typeof v === 'object' && v !== null) return <JsonTree value={v} defaultDepth={2} />;
  return <span className="mono">{String(v)}</span>;
}

export function DiffView({ original, replay, report }: { original: ExecutionRecord; replay: ExecutionRecord; report: DiffReport }) {
  const [selDiv, setSelDiv] = useState<number>(-1);
  const [focus, setFocus] = useState<{ seq: number; side: 'orig' | 'repl' | 'both' } | undefined>();
  const [syncScroll, setSyncScroll] = useState(0);
  const [showInfo, setShowInfo] = useState(true);

  const { flagsOrig, flagsRepl } = useMemo(() => {
    const fo = new Map<number, 'missing' | 'extra' | 'mismatch'>();
    const fr = new Map<number, 'missing' | 'extra' | 'mismatch'>();
    for (const d of report.divergences) {
      if (d.type === 'missing-event' && d.seq !== undefined) fo.set(d.seq, 'missing');
      if (d.type === 'extra-event' && d.seq !== undefined) fr.set(d.seq, 'extra');
      if (d.type === 'field-mismatch' && d.seq !== undefined && d.seq >= 0) {
        if (!fo.has(d.seq)) fo.set(d.seq, 'mismatch');
        fr.set(d.seq, 'mismatch');
      }
    }
    return { flagsOrig: fo, flagsRepl: fr };
  }, [report]);

  const scored = report.divergences.filter((d) => d.severity !== 'info');
  const info = report.divergences.filter((d) => d.severity === 'info');
  const vis = showInfo ? report.divergences : scored;

  const origBody = prettyBody(original.response?.body);
  const replBody = prettyBody(replay.response?.body);
  const bodyDiff = useMemo(
    () => diffLines(origBody.text || '(no body captured)', replBody.text || '(no body captured)'),
    [origBody.text, replBody.text],
  );
  const [bodyOpen, setBodyOpen] = useState(false);

  const jump = (d: Divergence, i: number) => {
    setSelDiv(i);
    if (d.seq === undefined || d.seq < 0) return;
    if (d.type === 'extra-event') setFocus({ seq: d.seq, side: 'repl' });
    else setFocus({ seq: d.seq, side: 'orig' });
  };

  return (
    <div className="page">
      <div className="diff-h">
        <ScoreRing score={report.matchScore} />
        <div>
          <div className="flex" style={{ gap: 8 }}>
            {report.outcomeMatch ? (
              <span className="st st-ok">reproduced</span>
            ) : report.statusChanged ? (
              <span className="st st-info">outcome changed</span>
            ) : (
              <span className="st st-warn">diverged</span>
            )}
            <span className="chip mono">{report.stats.matched} matched</span>
            {report.stats.missing > 0 && <span className="chip" style={{ color: 'var(--err)' }}>{report.stats.missing} missing</span>}
            {report.stats.extra > 0 && <span className="chip" style={{ color: 'var(--purple)' }}>{report.stats.extra} extra</span>}
            {report.stats.eventsWithMismatch > 0 && <span className="chip" style={{ color: 'var(--warn)' }}>{report.stats.eventsWithMismatch} mismatched</span>}
          </div>
          <div className="dim" style={{ marginTop: 4, fontSize: 11 }}>
            timing {fmtMs(report.timing.originalMs)} → {fmtMs(report.timing.replayMs)} ({report.timing.driftPct > 0 ? '−' : '+'}{Math.abs(report.timing.driftPct).toFixed(1)}%)
            {' · '}score counts aligned events + outcome divergence; informational notes don't lower it
          </div>
        </div>
        <div className="grow" />
        <div className="mono faint" style={{ fontSize: 11 }}>
          {report.incidentId} vs {report.replayId}
        </div>
      </div>

      {/* outcome comparison strip */}
      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)', flexShrink: 0 }}>
        <div className="flex" style={{ gap: 16, fontSize: 11.5 }}>
          <span className="faint">response</span>
          <span className={`st st-${statusClass(original.response?.status)}`}>{original.response?.status ?? '—'}</span>
          <span className="faint">→</span>
          <span className={`st st-${statusClass(replay.response?.status)}`}>{replay.response?.status ?? '—'}</span>
          {original.error || replay.error ? (
            <>
              <span className="faint">error</span>
              <span className="mono" style={{ color: 'var(--err)' }}>{original.error?.name ?? '—'}</span>
              <span className="faint">→</span>
              <span className="mono" style={{ color: 'var(--err)' }}>{replay.error?.name ?? '—'}</span>
            </>
          ) : null}
          <button className="btn small" onClick={() => setBodyOpen(!bodyOpen)}>
            {bodyOpen ? 'hide body diff' : 'body diff'}
          </button>
        </div>
        {bodyOpen && (
          <div className="code" style={{ marginTop: 8, maxHeight: 260 }}>
            {bodyDiff.map((l, i) => (
              <span key={i} className={l.kind === 'del' ? 'ln-del' : l.kind === 'add' ? 'ln-add' : 'ln-ctx'}>
                {l.kind === 'del' ? '− ' : l.kind === 'add' ? '+ ' : '  '}
                {l.text}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* divergence list */}
      {report.divergences.length > 0 ? (
        <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-1)', flexShrink: 0, maxHeight: 200, overflowY: 'auto' }}>
          <div className="flex" style={{ padding: '5px 12px', gap: 10, borderBottom: '1px solid var(--bg-2)', position: 'sticky', top: 0, background: 'var(--bg-1)', zIndex: 1 }}>
            <span className="faint" style={{ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              divergences ({scored.length}{info.length ? ` + ${info.length} info` : ''})
            </span>
            {info.length > 0 && (
              <button className="btn small" onClick={() => setShowInfo(!showInfo)} style={{ marginLeft: 'auto' }}>
                {showInfo ? 'hide info' : 'show info'}
              </button>
            )}
          </div>
          <div className="dv-list">
            {vis.slice(0, 300).map((d) => {
              const i = report.divergences.indexOf(d);
              return (
                <div key={i}>
                  <div className={`dv-row ${selDiv === i ? 'sel' : ''}`} onClick={() => jump(d, i)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && jump(d, i)}>
                    <span className={`st ${sevClass(d)}`}>{SEVERITY_LABEL[d.type] ?? d.type}</span>
                    {d.kind && <span className="kind-tag faint">{d.kind}</span>}
                    <span className="dv-msg" title={d.message}>{d.message}</span>
                    {d.seq !== undefined && d.seq >= 0 && <span className="mono faint">seq {d.seq}</span>}
                  </div>
                  {selDiv === i && (d.expected !== undefined || d.actual !== undefined || d.path) && (
                    <div style={{ padding: '0 12px 8px' }}>
                      {d.path && <div className="mono faint" style={{ fontSize: 10.5, margin: '4px 0' }}>{d.path}</div>}
                      <div className="dv-vals">
                        <div className="exp"><span className="lbl">original</span><Value v={d.expected} /></div>
                        <div className="act"><span className="lbl">replay</span><Value v={d.actual} /></div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {vis.length > 300 && (
              <div className="faint" style={{ padding: '6px 12px', fontSize: 11 }}>
                … {vis.length - 300} more divergences — the diff engine lists all of them in the report; fetch the record via CLI for the full set
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="banner info">no divergences reported — the replay reproduced every recorded event and the outcome</div>
      )}

      {/* synced split timelines */}
      <div className="dsplit">
        <div>
          <div className="dsplit-h">
            <span>original</span>
            <span className="mono faint">{report.incidentId}</span>
            <span className="faint" style={{ marginLeft: 'auto' }}>{report.stats.originalEvents} events</span>
          </div>
          <Timeline
            events={original.events}
            flags={flagsOrig}
            scrollTop={syncScroll}
            onScrollPos={setSyncScroll}
            focusSeq={focus && focus.side === 'orig' ? focus.seq : undefined}
          />
        </div>
        <div>
          <div className="dsplit-h">
            <span>replay</span>
            <span className="mono faint">{report.replayId}</span>
            <span className="faint" style={{ marginLeft: 'auto' }}>{report.stats.replayEvents} events</span>
          </div>
          <Timeline
            events={replay.events}
            flags={flagsRepl}
            scrollTop={syncScroll}
            onScrollPos={setSyncScroll}
            focusSeq={focus && focus.side === 'repl' ? focus.seq : undefined}
          />
        </div>
      </div>
    </div>
  );
}
