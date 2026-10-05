import { useState } from 'react';
import { isRedactedValue } from './bits';

/* Lazy JSON tree — expands nodes on demand so large records stay cheap.
   Long strings truncate with click-to-expand. Depth-capped defensively. */

const MAX_DEPTH = 40;
const STRING_CLIP = 220;
const ARRAY_PREVIEW = 6;

function JScalar({ v }: { v: unknown }) {
  if (v === null) return <span className="jt-null">null</span>;
  if (v === undefined) return <span className="jt-null">undefined</span>;
  switch (typeof v) {
    case 'string': {
      const [open, setOpen] = useState(false);
      if (isRedactedValue(v)) return <span className="jt-redacted">{v}</span>;
      if (v.length > STRING_CLIP && !open) {
        return (
          <span className="jt-str" title="click to expand" style={{ cursor: 'pointer' }} onClick={() => setOpen(true)}>
            "{v.slice(0, STRING_CLIP)}<span className="jt-count">… +{v.length - STRING_CLIP} chars</span>"
          </span>
        );
      }
      return <span className="jt-str">"{v}"</span>;
    }
    case 'number':
      return <span className="jt-num">{String(v)}</span>;
    case 'boolean':
      return <span className="jt-bool">{String(v)}</span>;
    case 'bigint':
      return <span className="jt-num">{String(v)}n</span>;
    default:
      return <span className="jt-null">{typeof v === 'object' ? '[unserializable]' : String(v)}</span>;
  }
}

function JNode({ k, v, depth, defaultOpen }: { k?: string; v: unknown; depth: number; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? depth < 2);
  const isArr = Array.isArray(v);
  const isObj = v !== null && typeof v === 'object';
  if (!isObj || depth >= MAX_DEPTH) {
    return (
      <div className="jt-row">
        {k !== undefined && <span className="jt-key">{k}: </span>}
        <JScalar v={v} />
      </div>
    );
  }
  const entries = isArr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  const label = isArr ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <div className="jt-row">
      <span className="jt-toggle" onClick={() => setOpen(!open)} role="button" aria-expanded={open} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(!open)}>
        {open ? '▾' : '▸'}
      </span>
      {k !== undefined && <span className="jt-key">{k}: </span>}
      {!open && (
        <span className="jt-count" style={{ cursor: 'pointer' }} onClick={() => setOpen(true)}>
          {isArr ? `Array(${entries.length})` : `Object {${entries.slice(0, 4).map(([kk]) => kk).join(', ')}${entries.length > 4 ? ', …' : ''}}`}
        </span>
      )}
      {open && (
        <>
          {entries.slice(0, 400).map(([kk, vv]) => (
            <JNode key={kk} k={isArr ? undefined : kk} v={vv} depth={depth + 1} />
          ))}
          {entries.length > 400 && <div className="jt-row jt-count">… {entries.length - 400} more entries</div>}
        </>
      )}
      {open && <div className="jt-row jt-count">{label}</div>}
    </div>
  );
}

export function JsonTree({ value, defaultDepth }: { value: unknown; defaultDepth?: number }) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return <div className="jt"><JScalar v={value} /></div>;
    }
  }
  return (
    <div className="jt">
      <JNode v={value} depth={0} defaultOpen={(defaultDepth ?? 2) > 0} />
    </div>
  );
}
