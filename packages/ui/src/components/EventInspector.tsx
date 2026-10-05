import type { DbQueryData, HttpOutData, TimelineEvent } from '@recurr/core/types';
import { fmtMs, fmtTime, statusClass } from '../lib/format';
import { HeadersTable, BodyViewer } from './BodyViewer';
import { JsonTree } from './JsonTree';
import { KindBadge } from './bits';

/* Event inspector — kind-aware detail rendering. Shows everything the record
   holds for the event without fabricating fields. */

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="hr">
      <div className="hk">{k}</div>
      <div className="hv">{children}</div>
    </div>
  );
}

function SqlText({ text }: { text: string }) {
  // Light SQL formatting — collapse runs of whitespace onto keyword lines.
  const pretty = text
    .replace(/\s+/g, ' ')
    .replace(/ (FROM|WHERE|ORDER BY|GROUP BY|LIMIT|OFFSET|RETURNING|VALUES|SET|JOIN|LEFT JOIN|ON|AND|OR) /gi, '\n$1 ')
    .trim();
  return <div className="code">{pretty}</div>;
}

function DbInspector({ data }: { data: DbQueryData }) {
  return (
    <div>
      <div className="sub">statement</div>
      <SqlText text={data.text} />
      {data.params && data.params.length > 0 && (
        <>
          <div className="sub">params</div>
          <JsonTree value={data.params} defaultDepth={2} />
        </>
      )}
      <div className="hrows" style={{ marginTop: 8 }}>
        <Row k="system">{data.system}</Row>
        <Row k="rows">{data.rowCount ?? '—'}{data.rowsTruncated ? ' (truncated)' : ''}</Row>
        {data.error && <Row k="error"><span style={{ color: 'var(--err)' }}>{data.errorName ? `${data.errorName}: ` : ''}{data.error}</span></Row>}
      </div>
      {data.rows && data.rows.length > 0 && (
        <>
          <div className="sub">captured rows ({data.rows.length}{data.rowsTruncated ? '+' : ''})</div>
          <JsonTree value={data.rows} defaultDepth={1} />
        </>
      )}
    </div>
  );
}

function HttpOutInspector({ data }: { data: HttpOutData }) {
  return (
    <div>
      <div className="hrows">
        <Row k="method">{data.method}</Row>
        <Row k="url">{data.url}</Row>
        <Row k="status">{data.status !== undefined ? <span className={`st st-${statusClass(data.status)}`}>{data.status}</span> : '—'}</Row>
        {data.attempt !== undefined && <Row k="attempt">{data.attempt}</Row>}
        {data.error && <Row k="error"><span style={{ color: 'var(--err)' }}>{data.errorKind ? `[${data.errorKind}] ` : ''}{data.errorName ? `${data.errorName}: ` : ''}{data.error}</span></Row>}
        {data.responsePending && (
          <Row k="capture gap"><span style={{ color: 'var(--warn)' }}>response body never consumed — headers recorded, body not captured</span></Row>
        )}
      </div>
      {data.requestBody !== undefined && (
        <>
          <div className="sub">request body</div>
          <BodyViewer body={data.requestBody} label="request body" />
        </>
      )}
      {data.responseBody !== undefined && (
        <>
          <div className="sub">response body</div>
          <BodyViewer body={data.responseBody} label="response body" />
        </>
      )}
      {data.responseHeaders && Object.keys(data.responseHeaders).length > 0 && (
        <>
          <div className="sub">response headers</div>
          <HeadersTable headers={data.responseHeaders} />
        </>
      )}
    </div>
  );
}

export function EventInspector({ event }: { event: TimelineEvent }) {
  const d = event.data as Record<string, unknown> | undefined;
  return (
    <div className="insp">
      <div className="insp-h">
        <KindBadge kind={event.kind} />
        <span className="mono">#{event.seq}</span>
        <span className="faint mono">+{fmtMs(event.offsetMs)}</span>
        {event.durationMs !== undefined && <span className="faint mono">{fmtMs(event.durationMs)}</span>}
        {event.status && <span className={`st st-${event.status === 'error' ? 'err' : 'ok'}`}>{event.status}</span>}
      </div>
      <div className="insp-b">
        <div className="hrows">
          <Row k="at">{fmtTime(event.at)}</Row>
          {event.name && <Row k="name">{event.name}</Row>}
        </div>
        {event.kind === 'db.query' && d ? (
          <DbInspector data={d as unknown as DbQueryData} />
        ) : event.kind === 'http.out' && d ? (
          <HttpOutInspector data={d as unknown as HttpOutData} />
        ) : d && Object.keys(d).length > 0 ? (
          <>
            <div className="sub">data</div>
            <JsonTree value={d} defaultDepth={3} />
          </>
        ) : (
          <div className="faint" style={{ marginTop: 6 }}>no event data captured</div>
        )}
      </div>
    </div>
  );
}
