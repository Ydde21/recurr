import { useMemo, useState } from 'react';
import { prettyBody, fmtBytes } from '../lib/format';
import { JsonTree } from './JsonTree';

/* Body viewer — pretty JSON tree by default, raw text on demand, with
   honest base64/truncation flags. Never fabricates body content. */

export function BodyViewer({
  body,
  base64,
  truncated,
  label = 'body',
}: {
  body: string | undefined;
  base64?: boolean;
  truncated?: boolean;
  label?: string;
}) {
  const [mode, setMode] = useState<'pretty' | 'raw' | 'tree'>('tree');
  const pretty = useMemo(() => prettyBody(body), [body]);

  if (body === undefined) {
    return <div className="faint" style={{ padding: '2px 0' }}>no {label} captured</div>;
  }
  const bytes = base64 ? Math.floor((body.length * 3) / 4) : new Blob([body]).size;
  return (
    <div>
      <div className="viewer-toolbar">
        <span className="chip mono">{fmtBytes(bytes)}</span>
        {base64 && <span className="chip">base64</span>}
        {truncated && <span className="chip" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>truncated</span>}
        <span className="right">
          {pretty.isJson && (
            <>
              <button className={`btn small ${mode === 'tree' ? 'primary' : ''}`} onClick={() => setMode('tree')}>
                tree
              </button>
              <button className={`btn small ${mode === 'pretty' ? 'primary' : ''}`} onClick={() => setMode('pretty')}>
                pretty
              </button>
            </>
          )}
          <button className={`btn small ${mode === 'raw' ? 'primary' : ''}`} onClick={() => setMode('raw')}>
            raw
          </button>
          <button className="btn small" onClick={() => void navigator.clipboard.writeText(body)} title="copy body">
            copy
          </button>
        </span>
      </div>
      {base64 ? (
        <div className="code">
          {body.slice(0, 4096)}
          {body.length > 4096 && `\n… +${body.length - 4096} base64 chars`}
        </div>
      ) : mode === 'tree' && pretty.isJson ? (
        <JsonTree value={pretty.text} defaultDepth={3} />
      ) : mode === 'pretty' && pretty.isJson ? (
        <div className="code">{pretty.text.slice(0, 200_000)}</div>
      ) : (
        <div className="code">
          {body.slice(0, 200_000)}
          {body.length > 200_000 && `\n… +${body.length - 200_000} chars`}
        </div>
      )}
    </div>
  );
}

export function HeadersTable({ headers, redactedKeys }: { headers: Record<string, string | string[]> | undefined; redactedKeys?: Set<string> }) {
  if (!headers || Object.keys(headers).length === 0) {
    return <div className="faint">no headers captured</div>;
  }
  return (
    <div className="hrows">
      {Object.entries(headers).map(([k, v]) => {
        const val = Array.isArray(v) ? v.join(', ') : String(v);
        const redacted = redactedKeys?.has(k.toLowerCase()) || val.includes('[REDACTED]');
        return (
          <div className="hr" key={k}>
            <div className="hk">{k}</div>
            <div className={`hv ${redacted ? 'redacted' : ''}`}>{val}</div>
          </div>
        );
      })}
    </div>
  );
}
