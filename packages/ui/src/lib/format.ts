/** Formatting helpers shared across views. */

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function fmtTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function fmtTimeShort(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const age = now - d.getTime();
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  if (age < 7 * 86_400_000) return `${Math.floor(age / 86_400_000)}d ago`;
  return fmtTime(iso).slice(0, 10);
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pretty-print a body string that may be JSON; returns {text, isJson}. */
export function prettyBody(body: string | undefined): { text: string; isJson: boolean } {
  if (body === undefined) return { text: '', isJson: false };
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { text: body, isJson: false };
  try {
    return { text: JSON.stringify(JSON.parse(body), null, 2), isJson: true };
  } catch {
    return { text: body, isJson: false };
  }
}

export function statusClass(status: number | undefined): 'ok' | 'warn' | 'err' | 'dim' {
  if (status === undefined) return 'dim';
  if (status >= 500) return 'err';
  if (status >= 400) return 'warn';
  return 'ok';
}

/** Simple LCS line diff for body comparison — added/removed/context lines. */
export interface DiffLine {
  kind: 'same' | 'del' | 'add';
  text: string;
}

export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split('\n');
  const B = b.split('\n');
  // Cap pathological sizes — a 10k×10k LCS table is not useful in a UI.
  if (A.length * B.length > 4_000_000) {
    return [
      { kind: 'del', text: `(${A.length} lines — too large to diff)` },
      { kind: 'add', text: `(${B.length} lines — too large to diff)` },
    ];
  }
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      out.push({ kind: 'same', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: A[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: B[j] });
      j++;
    }
  }
  for (; i < A.length; i++) out.push({ kind: 'del', text: A[i] });
  for (; j < B.length; j++) out.push({ kind: 'add', text: B[j] });
  return out;
}
