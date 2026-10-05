import type { DiffReport, ExecutionRecord, ExecutionSummary, TimelineEvent } from '@recurr/core';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code: number) => (s: string | number) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);
export const gray = paint(90);

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms * 10) / 10}ms`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => c + ' '.repeat(Math.max(0, widths[i] - stripAnsi(c).length))).join('  ');
  return [line(headers.map((h) => bold(h))), ...rows.map(line)].join('\n');
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[\d+m/g, '');
}

function statusColor(status: number | undefined): string {
  if (status === undefined) return dim('-');
  if (status >= 500) return red(String(status));
  if (status >= 400) return yellow(String(status));
  return green(String(status));
}

export function incidentRow(s: ExecutionSummary): string[] {
  return [
    s.id,
    s.service,
    `${s.method ?? '-'} ${s.path ?? '-'}`,
    statusColor(s.status),
    s.errorName ?? dim('-'),
    fmtTime(s.capturedAt),
    fmtMs(s.durationMs),
  ];
}

export const INCIDENT_HEADERS = ['ID', 'SERVICE', 'REQUEST', 'STATUS', 'ERROR', 'TIME', 'DURATION'];

function eventLine(e: TimelineEvent): string {
  const offset = `+${fmtMs(e.offsetMs)}`.padStart(8);
  const dur = e.durationMs !== undefined ? dim(` (${fmtMs(e.durationMs)})`) : '';
  const status = e.status === 'error' ? red(' ✗') : e.status === 'ok' ? '' : '';
  const name = e.name ? ` ${e.name}` : '';
  return `${dim(offset)}  ${e.kind.padEnd(11)}${name}${dur}${status}`;
}

export function printRecord(rec: ExecutionRecord, out: (s: string) => void): void {
  const req = rec.request;
  const res = rec.response;
  out('');
  out(`${bold(rec.id)}  ${rec.kind === 'replay' ? `(replay of ${rec.replayOf})` : ''}`);
  out(`${dim('service')}  ${rec.service.name}${rec.service.version ? `@${rec.service.version}` : ''} · ${rec.environment.name} · ${rec.service.runtime}`);
  out(`${dim('when')}     ${fmtTime(rec.capturedAt)}`);
  if (req) {
    out(`${dim('request')}  ${req.method} ${req.url}`);
    if (req.body) out(`${dim('body')}     ${truncate(req.body, 300)}`);
  }
  if (res) out(`${dim('response')} ${statusColor(res.status)} ${dim('in')} ${fmtMs(res.durationMs)}`);
  if (rec.error) out(`${dim('error')}    ${red(`${rec.error.name}: ${rec.error.message}`)}`);
  if (rec.auth?.principal) out(`${dim('auth')}     ${truncate(JSON.stringify(rec.auth.principal), 120)}`);
  out('');
  out(bold('timeline'));
  for (const e of rec.events) {
    out(eventLine(e));
    if (e.kind === 'db.query' && e.data) {
      const d = e.data as { text?: string; rowCount?: number };
      if (d.text) out(`${' '.repeat(10)}${dim('sql')} ${truncate(d.text.replace(/\s+/g, ' '), 110)}${d.rowCount !== undefined ? dim(` → ${d.rowCount} rows`) : ''}`);
    }
    if (e.kind === 'http.out' && e.data) {
      const d = e.data as { status?: number; error?: string };
      out(`${' '.repeat(10)}${d.status ? dim(`→ ${d.status}`) : red(`→ ${d.error ?? 'failed'}`)}`);
    }
    if (e.kind === 'replay.note' && e.data) {
      out(`${' '.repeat(10)}${yellow(String((e.data as { message?: string }).message ?? 'note'))}`);
    }
  }
  if (rec.redaction.redactedPaths.length) {
    out('');
    out(`${dim('redacted')} ${rec.redaction.redactedPaths.length} field(s): ${rec.redaction.redactedPaths.slice(0, 8).join(', ')}${rec.redaction.redactedPaths.length > 8 ? '…' : ''}`);
  }
  if (rec.response?.body) {
    out('');
    out(`${dim('response body')} ${truncate(rec.response.body, 400)}`);
  }
}

export function printDiffReport(report: DiffReport, out: (s: string) => void): void {
  out('');
  out(bold(`diff: ${report.incidentId} vs ${report.replayId}`));
  if (report.outcomeMatch) {
    out(`outcome   ${green('reproduced')} — same result as the original execution`);
  } else if (report.statusChanged) {
    out(`outcome   ${yellow('changed')} — replay produced a different result (expected if a fix landed)`);
  } else {
    out(`outcome   ${yellow('diverged')} — same status, different error path`);
  }
  out(`match     ${report.matchScore}%`);
  const s = report.stats;
  out(`events    ${s.matched} matched · ${s.missing} missing · ${s.extra} extra · ${s.eventsWithMismatch} mismatched`);
  out(`timing    original ${fmtMs(report.timing.originalMs)} → replay ${fmtMs(report.timing.replayMs)} (${report.timing.driftPct >= 0 ? '+' : ''}${report.timing.driftPct}%)`);
  if (report.divergences.length) {
    out('');
    out(bold('divergences'));
    for (const d of report.divergences.slice(0, 25)) {
      const seq = d.seq !== undefined && d.seq >= 0 ? ` seq ${d.seq}` : '';
      out(`  ${yellow('•')} ${d.type}${seq}${d.path ? ` ${d.path}` : ''}: ${d.message}`);
    }
    if (report.divergences.length > 25) out(dim(`  …and ${report.divergences.length - 25} more`));
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
