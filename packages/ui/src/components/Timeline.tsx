import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineEvent } from '@recurr/core/types';
import { fmtMs } from '../lib/format';
import { KindDot } from './bits';

/* Virtualized event timeline — renders a window around the scroll position.
   Row height is fixed (26px) so position is pure arithmetic; handles the
   100k-event cap without layout cost. */

const ROW_H = 26;
const OVERSCAN = 12;

export function eventLabel(e: TimelineEvent): string {
  if (e.name) return e.name;
  const d = e.data as Record<string, unknown> | undefined;
  if (!d) return e.kind;
  if (e.kind === 'db.query') return String(d.text ?? '').split('\n')[0].slice(0, 80);
  if (e.kind === 'http.out') return `${d.method ?? ''} ${d.url ?? ''}`.trim();
  if (e.kind === 'error') return String(d.message ?? 'error');
  return JSON.stringify(d).slice(0, 80);
}

export interface TimelineProps {
  events: TimelineEvent[];
  selected?: number; // seq
  onSelect?: (e: TimelineEvent) => void;
  /** seqs to flag visually (diff view: missing/extra/mismatch). */
  flags?: Map<number, 'missing' | 'extra' | 'mismatch'>;
  focusSeq?: number; // scroll to + select this seq once mounted
  /** Controlled scroll (diff split view syncs both sides). */
  scrollTop?: number;
  onScrollPos?: (top: number) => void;
}

export function Timeline({ events, selected, onSelect, flags, focusSeq, scrollTop, onScrollPos }: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [cursor, setCursor] = useState(-1);
  const [viewH, setViewH] = useState(600);

  const maxEnd = useMemo(() => Math.max(1, ...events.map((e) => e.offsetMs + (e.durationMs ?? 0))), [events]);
  const start = Math.max(0, Math.floor(scroll / ROW_H) - OVERSCAN);
  const count = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const slice = events.slice(start, start + count);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Controlled scroll sync (diff view keeps both sides aligned).
  useEffect(() => {
    if (scrollTop !== undefined && ref.current && Math.abs(ref.current.scrollTop - scrollTop) > 1) {
      ref.current.scrollTop = scrollTop;
    }
  }, [scrollTop]);

  // Jump to a flagged/focused event (diff navigation).
  useEffect(() => {
    if (focusSeq === undefined) return;
    const idx = events.findIndex((e) => e.seq === focusSeq);
    if (idx < 0) return;
    ref.current?.scrollTo({ top: Math.max(0, idx * ROW_H - viewH / 2) });
    setCursor(idx);
    onSelect?.(events[idx]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq]);

  const move = useCallback(
    (dir: 1 | -1) => {
      const next = Math.max(0, Math.min(events.length - 1, (cursor < 0 ? (dir === 1 ? -1 : events.length) : cursor) + dir));
      setCursor(next);
      const el = ref.current;
      if (el) {
        const top = next * ROW_H;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW_H > el.scrollTop + viewH) el.scrollTop = top + ROW_H - viewH;
      }
      onSelect?.(events[next]);
    },
    [cursor, events, onSelect, viewH],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'g') {
        el.scrollTop = 0;
        setCursor(0);
        onSelect?.(events[0]);
      } else if (e.key === 'G') {
        el.scrollTop = el.scrollHeight;
        setCursor(events.length - 1);
        onSelect?.(events[events.length - 1]);
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [move, events, onSelect]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="tl-head">
        <span style={{ textAlign: 'right' }}>offset</span>
        <span>duration</span>
        <span>type</span>
        <span>event</span>
        <span style={{ textAlign: 'right' }}>time</span>
        <span />
      </div>
      <div
        className="tl"
        ref={ref}
        tabIndex={0}
        role="listbox"
        aria-label="execution timeline"
        onScroll={(e) => {
          const top = (e.target as HTMLDivElement).scrollTop;
          setScroll(top);
          onScrollPos?.(top);
        }}
      >
        <div style={{ height: events.length * ROW_H, position: 'relative' }}>
          {slice.map((e, i) => {
            const idx = start + i;
            const flag = flags?.get(e.seq);
            const w = Math.max(2, Math.min(100, ((e.durationMs ?? 0) / maxEnd) * 100));
            const color =
              e.status === 'error' || e.kind === 'error'
                ? 'var(--err)'
                : e.kind === 'db.query'
                  ? 'var(--teal)'
                  : e.kind === 'http.out'
                    ? 'var(--purple)'
                    : e.kind === 'retry'
                      ? 'var(--warn)'
                      : 'var(--accent)';
            return (
              <div
                key={e.seq}
                role="option"
                aria-selected={selected === e.seq}
                className={`tl-row ${selected === e.seq ? 'sel' : ''} ${flag === 'missing' ? 'missing-row' : ''}`}
                style={{ position: 'absolute', top: idx * ROW_H, left: 0, right: 0 }}
                onClick={() => {
                  setCursor(idx);
                  onSelect?.(e);
                }}
              >
                <span className="tl-offset">+{fmtMs(e.offsetMs)}</span>
                <span className="tl-bar" title={`${fmtMs(e.durationMs)}`}>
                  <i style={{ left: `${Math.min(99, (e.offsetMs / maxEnd) * 100)}%`, width: `${w}%`, background: color, minWidth: 3 }} />
                </span>
                <span className="kind-tag">
                  <KindDot kind={e.kind} />
                  {e.kind}
                </span>
                <span className={`tl-name ${e.status === 'error' ? 'tl-status-err' : ''}`} title={eventLabel(e)}>
                  {eventLabel(e)}
                </span>
                <span className="tl-dur">{fmtMs(e.durationMs)}</span>
                <span>
                  {flag === 'missing' && <span className="st st-dim" title="missing in replay">−</span>}
                  {flag === 'extra' && <span className="st st-purple" title="extra in replay">+</span>}
                  {flag === 'mismatch' && <span className="st st-warn" title="field mismatch">≠</span>}
                  {!flag && (e.status === 'error' || e.kind === 'error') && <span className="tl-status-err">✗</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
