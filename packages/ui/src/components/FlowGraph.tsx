import { useMemo } from 'react';
import type { ExecutionRecord } from '@recurr/core/types';
import { fmtMs, statusClass } from '../lib/format';
import { eventLabel } from './Timeline';
import { KIND_FILL } from '../lib/kinds';

/* Dependency flow graph — derived strictly from the recorded event sequence.
   Edges are sequential (the record carries no parent/child links); the view
   says so rather than implying traced causality. */

const NODE_W = 200;
const NODE_H = 34;
const ROW_PITCH = 46;
const COL_X = [20, 280, 540];
const TOP = 24;
const MAX_NODES = 60;

function kindColor(kind: string): string {
  return KIND_FILL[kind] ?? 'var(--text-faint)';
}

export function FlowGraph({ record }: { record: ExecutionRecord }) {
  const events = record.events;
  const clipped = events.slice(0, MAX_NODES);
  const hidden = events.length - clipped.length;

  const { height, totalRows } = useMemo(() => {
    const rows = clipped.length + (hidden > 0 ? 1 : 0) + 2; // + request + terminal
    return { height: TOP * 2 + rows * ROW_PITCH, totalRows: rows };
  }, [clipped.length, hidden]);

  if (!record.request && events.length === 0 && !record.response) {
    return (
      <div className="state">
        <div className="title">no dependency data</div>
        <div className="hint">this record captured no request, events, or response — nothing to graph</div>
      </div>
    );
  }

  const midY = (i: number) => TOP + i * ROW_PITCH + NODE_H / 2;
  const reqLabel = record.request ? `${record.request.method} ${record.request.path ?? record.request.url}` : 'execution (no request)';
  const respLabel = record.error
    ? `${record.error.name}${record.response ? ` · HTTP ${record.response.status}` : ''}`
    : record.response
      ? `HTTP ${record.response.status}`
      : 'no response captured';

  let row = 0;
  const reqRow = row++;
  const eventRows = clipped.map(() => row++);
  if (hidden > 0) row++; // overflow marker
  const termRow = row;

  return (
    <div className="graph-wrap">
      <div className="graph-note">
        derived from the recorded event sequence — edges are sequential, not traced causality
        {hidden > 0 && ` · ${hidden} events hidden (use the timeline for the full record)`}
      </div>
      <svg className="graph-svg" width={740} height={Math.max(height, 200)} role="img" aria-label="execution flow graph">
        {/* edges — drawn under nodes */}
        <path className="g-edge" d={`M ${COL_X[0] + NODE_W} ${midY(reqRow)} C ${COL_X[1] - 40} ${midY(reqRow)}, ${COL_X[1] - 40} ${midY(eventRows[0] ?? reqRow)}, ${COL_X[1]} ${midY(eventRows[0] ?? reqRow)}`} />
        {eventRows.slice(0, -1).map((r, i) => (
          <path key={i} className="g-edge" d={`M ${COL_X[1] + NODE_W / 2} ${midY(r) + NODE_H / 2} L ${COL_X[1] + NODE_W / 2} ${midY(eventRows[i + 1]) - NODE_H / 2}`} />
        ))}
        {hidden > 0 && (
          <path className="g-edge" d={`M ${COL_X[1] + NODE_W / 2} ${midY(eventRows[eventRows.length - 1] ?? 0) + NODE_H / 2} L ${COL_X[1] + NODE_W / 2} ${midY(termRow - 1) - NODE_H / 2}`} />
        )}
        {/* terminal edges fan out from the last event row (or request when empty) */}
        <path
          className={`g-edge ${record.error || (record.response?.status ?? 0) >= 500 ? 'err' : ''}`}
          d={`M ${COL_X[1] + NODE_W} ${midY(termRow - 1)} C ${COL_X[2] - 40} ${midY(termRow - 1)}, ${COL_X[2] - 40} ${midY(termRow)}, ${COL_X[2]} ${midY(termRow)}`}
        />

        {/* request node */}
        <g className="g-node">
          <rect x={COL_X[0]} y={midY(reqRow) - NODE_H / 2} width={NODE_W} height={NODE_H} rx={4} stroke="var(--accent)" strokeWidth={1} />
          <text className="g-label" x={COL_X[0] + 10} y={midY(reqRow) - 2}>{reqLabel.slice(0, 26)}</text>
          <text className="g-sub" x={COL_X[0] + 10} y={midY(reqRow) + 11}>captured request · {record.service.name}</text>
        </g>

        {/* event nodes */}
        {clipped.map((e, i) => {
          const y = midY(eventRows[i]) - NODE_H / 2;
          const isErr = e.status === 'error' || e.kind === 'error';
          return (
            <g className="g-node" key={e.seq}>
              <rect x={COL_X[1]} y={y} width={NODE_W} height={NODE_H} rx={4} stroke={kindColor(e.kind)} strokeWidth={1} />
              <circle cx={COL_X[1] + 12} cy={midY(eventRows[i])} r={3.5} fill={kindColor(e.kind)} />
              <text className="g-label" x={COL_X[1] + 22} y={midY(eventRows[i]) - 2}>
                {eventLabel(e).slice(0, 22)}
              </text>
              <text className="g-sub" x={COL_X[1] + 22} y={midY(eventRows[i]) + 11}>
                {e.kind} · +{fmtMs(e.offsetMs)}{e.durationMs !== undefined ? ` · ${fmtMs(e.durationMs)}` : ''}
              </text>
              {isErr && <text x={COL_X[1] + NODE_W - 14} y={midY(eventRows[i]) + 4} fill="var(--err)" fontSize={11}>✗</text>}
            </g>
          );
        })}
        {hidden > 0 && (
          <g className="g-node">
            <rect x={COL_X[1]} y={midY(termRow - 1) - NODE_H / 2} width={NODE_W} height={NODE_H} rx={4} stroke="var(--border-strong)" strokeDasharray="4 3" />
            <text className="g-sub" x={COL_X[1] + 10} y={midY(termRow - 1) + 3}>+{hidden} more events</text>
          </g>
        )}

        {/* terminal node */}
        <g className="g-node">
          <rect
            x={COL_X[2]}
            y={midY(termRow) - NODE_H / 2}
            width={NODE_W}
            height={NODE_H}
            rx={4}
            stroke={record.error ? 'var(--err)' : `var(--${statusClass(record.response?.status) === 'dim' ? 'border-strong' : statusClass(record.response?.status)})`}
            strokeWidth={1}
          />
          <text className="g-label" x={COL_X[2] + 10} y={midY(termRow) - 2}>{respLabel.slice(0, 26)}</text>
          <text className="g-sub" x={COL_X[2] + 10} y={midY(termRow) + 11}>
            {record.error ? 'error' : 'response'}{record.response ? ` · ${fmtMs(record.response.durationMs)}` : ''}
          </text>
        </g>
      </svg>
      <div style={{ height: totalRows ? 0 : 0 }} />
    </div>
  );
}
