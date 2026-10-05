import { useMemo, useState, type ReactNode } from 'react';
import type { ExecutionRecord } from '@recurr/core/types';
import { fmtBytes, fmtMs, fmtTime } from '../lib/format';
import { BodyViewer, HeadersTable } from './BodyViewer';
import { JsonTree } from './JsonTree';
import { StatusBadge } from './bits';

/* Right-rail record context — request, response, error, auth, seed, redaction.
   Collapsible sections; everything shown comes from the record itself. */

function Section({ title, children, defaultOpen = true, badge }: { title: string; children: ReactNode; defaultOpen?: boolean; badge?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sec">
      <button className={`sec-h ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev">▸</span>
        {title}
        {badge && <span style={{ marginLeft: 'auto' }}>{badge}</span>}
      </button>
      {open && <div className="sec-b">{children}</div>}
    </div>
  );
}

export function RecordContext({ record }: { record: ExecutionRecord }) {
  // Serialized size is computed once per record — stringify of a large record
  // is not free.
  const recordBytes = useMemo(() => new Blob([JSON.stringify(record)]).size, [record]);
  const req = record.request;
  const resp = record.response;
  const err = record.error;
  return (
    <div>
      {req && (
        <Section title="request" badge={<span className="chip mono">{req.method}</span>}>
          <dl className="kv" style={{ marginBottom: 8 }}>
            <dt>method</dt>
            <dd>{req.method}</dd>
            <dt>url</dt>
            <dd>{req.url}</dd>
            {req.remoteAddr && (
              <>
                <dt>remote</dt>
                <dd>{req.remoteAddr}</dd>
              </>
            )}
          </dl>
          <div className="sub">headers</div>
          <HeadersTable headers={req.headers} />
          <div className="sub">body</div>
          <BodyViewer body={req.body} base64={req.bodyBase64} truncated={req.bodyTruncated} label="request body" />
        </Section>
      )}

      {resp && (
        <Section title="response" badge={<StatusBadge status={resp.status} />} defaultOpen={!err}>
          <dl className="kv" style={{ marginBottom: 8 }}>
            <dt>status</dt>
            <dd>{resp.status}</dd>
            <dt>duration</dt>
            <dd>{fmtMs(resp.durationMs)}</dd>
          </dl>
          <div className="sub">headers</div>
          <HeadersTable headers={resp.headers} />
          <div className="sub">body</div>
          <BodyViewer body={resp.body} base64={resp.bodyBase64} truncated={resp.bodyTruncated} label="response body" />
        </Section>
      )}

      {err && (
        <Section title="error" badge={<span className="st st-err">{err.name}</span>}>
          <div className="hrows">
            <div className="hr">
              <div className="hk">name</div>
              <div className="hv">{err.name}</div>
            </div>
            <div className="hr">
              <div className="hk">message</div>
              <div className="hv">{err.message}</div>
            </div>
            {err.code && (
              <div className="hr">
                <div className="hk">code</div>
                <div className="hv">{err.code}</div>
              </div>
            )}
          </div>
          {err.stack && (
            <>
              <div className="sub">stack</div>
              <div className="code" style={{ maxHeight: 240 }}>{err.stack}</div>
            </>
          )}
        </Section>
      )}

      {record.auth && (record.auth.principal !== undefined || record.auth.scheme) && (
        <Section title="auth principal" defaultOpen={false}>
          <div className="hint" style={{ marginBottom: 6 }}>
            captured principal — replay re-injects this; the credential itself is never stored.
          </div>
          {record.auth.scheme && (
            <dl className="kv" style={{ marginBottom: 6 }}>
              <dt>scheme</dt>
              <dd>{record.auth.scheme}</dd>
            </dl>
          )}
          <JsonTree value={record.auth.principal} defaultDepth={2} />
        </Section>
      )}

      <Section title="deterministic inputs" defaultOpen={false}>
        <dl className="kv">
          <dt>started</dt>
          <dd>{fmtTime(new Date(record.seed.startedAtWallMs).toISOString())}</dd>
          <dt>random values</dt>
          <dd>{record.seed.random.length}</dd>
          <dt>uuids</dt>
          <dd>{record.seed.uuids.length}</dd>
          {record.seed.timeReads !== undefined && (
            <>
              <dt>clock reads</dt>
              <dd>{record.seed.timeReads}</dd>
            </>
          )}
          {record.seed.randomConsumed !== undefined && (
            <>
              <dt>random consumed</dt>
              <dd>{record.seed.randomConsumed} / {record.seed.random.length || '—'}</dd>
            </>
          )}
          {record.seed.uuidConsumed !== undefined && (
            <>
              <dt>uuid consumed</dt>
              <dd>{record.seed.uuidConsumed} / {record.seed.uuids.length || '—'}</dd>
            </>
          )}
          <dt>prng seed</dt>
          <dd>{record.seed.prngSeed}</dd>
        </dl>
      </Section>

      <Section title="redaction" defaultOpen={false} badge={<span className="chip">{record.redaction.redactedPaths.length} paths</span>}>
        {record.redaction.redactedPaths.length === 0 && record.redaction.truncatedPaths.length === 0 ? (
          <div className="faint">nothing redacted or truncated</div>
        ) : (
          <>
            {record.redaction.redactedPaths.length > 0 && (
              <>
                <div className="sub">redacted</div>
                <div className="code" style={{ maxHeight: 160 }}>{record.redaction.redactedPaths.join('\n')}</div>
              </>
            )}
            {record.redaction.truncatedPaths.length > 0 && (
              <>
                <div className="sub">truncated by capture limits</div>
                <div className="code" style={{ maxHeight: 160 }}>{record.redaction.truncatedPaths.join('\n')}</div>
              </>
            )}
          </>
        )}
      </Section>

      <Section title="record" defaultOpen={false}>
        <dl className="kv">
          <dt>id</dt>
          <dd>{record.id}</dd>
          <dt>kind</dt>
          <dd>{record.kind}{record.replayOf ? ` of ${record.replayOf}` : ''}</dd>
          <dt>schema</dt>
          <dd>v{record.schemaVersion}</dd>
          <dt>captured</dt>
          <dd>{fmtTime(record.capturedAt)}</dd>
          <dt>service</dt>
          <dd>{record.service.name}{record.service.version ? `@${record.service.version}` : ''}</dd>
          <dt>runtime</dt>
          <dd>{record.service.runtime}</dd>
          {record.service.gitSha && (
            <>
              <dt>git</dt>
              <dd>{record.service.gitSha}</dd>
            </>
          )}
          <dt>env</dt>
          <dd>{record.environment.name}</dd>
          <dt>trigger</dt>
          <dd>{record.trigger.type}</dd>
          <dt>events</dt>
          <dd>{record.events.length}</dd>
          <dt>size</dt>
          <dd>{fmtBytes(recordBytes)}</dd>
        </dl>
        {record.labels && Object.keys(record.labels).length > 0 && (
          <>
            <div className="sub">labels</div>
            <JsonTree value={record.labels} defaultDepth={1} />
          </>
        )}
      </Section>
    </div>
  );
}
