/**
 * Automatic redaction — runs in the SDK before anything is persisted.
 *
 * Two layers:
 *  1. Field-name denylist (case-insensitive, `-`/`_` normalized). A field named
 *     `Authorization`, `x-api-key`, `password`, `credit_card`, … is replaced
 *     with the placeholder wherever it appears: headers, JSON bodies,
 *     query params, captured rows.
 *  2. Explicit paths: `request.body.ssn`, `db.rows.*.token` style rules
 *     configured by the developer.
 */

export interface RedactionConfig {
  /** Extra sensitive field names. `*foo*` enables substring matching. */
  fields?: string[];
  /** Explicit dotted paths to always redact (e.g. 'request.body.ssn'). */
  paths?: string[];
  /** Replacement value. Default '[REDACTED]'. */
  placeholder?: string;
  /** Max bytes kept for any captured body. Default 64 KiB. */
  maxBodyBytes?: number;
  /** Max depth walked into any single value. Default 12. */
  maxDepth?: number;
}

export interface RedactionResult<T> {
  value: T;
  hits: string[];
  truncated: string[];
}

export const DEFAULT_SENSITIVE_FIELDS: readonly string[] = [
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xapikey',
  'apikey',
  'api_key',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'session',
  'sessionid',
  'ssn',
  'socialsecuritynumber',
  'creditcard',
  'cardnumber',
  'cvv',
  'cvc',
  'pin',
  'privatekey',
  'clientsecret',
  'authtoken',
  'bearertoken',
];

const DEFAULT_PLACEHOLDER = '[REDACTED]';
const DEFAULT_MAX_BODY = 64 * 1024;
const MAX_STRING = 32 * 1024;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, '');
}

/**
 * Terms matched as *substrings* of a normalized field name — catches compound
 * keys like `password_hash`, `user_secret`, `x-auth-token`. Deliberately
 * conservative list; the exact-match denylist above covers the rest.
 */
const SENSITIVE_SUBSTRINGS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'ssn',
  'creditcard',
  'cardnumber',
  'cvv',
  'privatekey',
];

export class Redactor {
  private readonly exact = new Set<string>();
  private readonly contains: string[] = [...SENSITIVE_SUBSTRINGS];
  private readonly paths: string[];
  readonly placeholder: string;
  readonly maxBodyBytes: number;
  private readonly maxDepth: number;

  constructor(config: RedactionConfig = {}) {
    for (const f of DEFAULT_SENSITIVE_FIELDS) this.exact.add(normalizeKey(f));
    for (const f of config.fields ?? []) {
      const n = normalizeKey(f);
      if (n.startsWith('*') || n.endsWith('*')) {
        this.contains.push(n.replace(/\*/g, ''));
      } else {
        this.exact.add(n);
      }
    }
    this.paths = config.paths ?? [];
    this.placeholder = config.placeholder ?? DEFAULT_PLACEHOLDER;
    this.maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY;
    this.maxDepth = config.maxDepth ?? 12;
  }

  isSensitiveKey(key: string): boolean {
    const n = normalizeKey(key);
    if (this.exact.has(n)) return true;
    return this.contains.some((c) => c.length > 0 && n.includes(c));
  }

  private pathIsTargeted(path: string): boolean {
    return this.paths.some((p) => p === path || path.startsWith(p + '.') || path.startsWith(p + '['));
  }

  /** Deep-redact an arbitrary JSON-ish value. */
  redactValue<T>(value: T, basePath = ''): RedactionResult<T> {
    const hits: string[] = [];
    const truncated: string[] = [];
    const out = this.walk(value, basePath, 0, hits, truncated);
    return { value: out as T, hits, truncated };
  }

  private walk(value: unknown, path: string, depth: number, hits: string[], truncated: string[]): unknown {
    if (value === null || value === undefined) return value;
    if (this.pathIsTargeted(path)) {
      hits.push(path);
      return this.placeholder;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_STRING) {
        truncated.push(path);
        return value.slice(0, MAX_STRING) + '…[TRUNCATED]';
      }
      return value;
    }
    if (typeof value !== 'object') return value;
    if (depth > this.maxDepth) {
      truncated.push(path);
      return '[MAX_DEPTH]';
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const clipped = b.length > this.maxBodyBytes;
      if (clipped) truncated.push(path);
      return { $base64: (clipped ? b.subarray(0, this.maxBodyBytes) : b).toString('base64') };
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => this.walk(v, `${path}[${i}]`, depth + 1, hits, truncated));
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const childPath = path ? `${path}.${k}` : k;
      if (this.isSensitiveKey(k) || this.pathIsTargeted(childPath)) {
        hits.push(childPath);
        out[k] = this.placeholder;
      } else {
        out[k] = this.walk(v, childPath, depth + 1, hits, truncated);
      }
    }
    return out;
  }

  /** Redact a header map. Sensitive headers are replaced wholesale. */
  redactHeaders(
    headers: Record<string, string | string[]>,
    basePath: string,
  ): RedactionResult<Record<string, string | string[]>> {
    const hits: string[] = [];
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (this.isSensitiveKey(k)) {
        hits.push(`${basePath}.${k}`);
        out[k] = this.placeholder;
      } else {
        out[k] = v;
      }
    }
    return { value: out, hits, truncated: [] };
  }

  /**
   * Redact a serialized body. JSON and urlencoded bodies are parsed, walked
   * and re-serialized; anything else is returned unchanged (binary bodies
   * should be base64'd by the caller before capture).
   */
  redactBody(body: string | undefined, contentType: string | undefined, basePath: string): RedactionResult<string | undefined> {
    if (body === undefined) return { value: body, hits: [], truncated: [] };
    const hits: string[] = [];
    const truncated: string[] = [];
    let truncatedBody = body;
    if (Buffer.byteLength(body, 'utf8') > this.maxBodyBytes) {
      const buf = Buffer.from(body, 'utf8').subarray(0, this.maxBodyBytes);
      truncatedBody = buf.toString('utf8');
      truncated.push(basePath);
    }
    const ct = (contentType ?? '').toLowerCase();
    if (ct.includes('json') || /^[\[{]/.test(body.trimStart())) {
      try {
        const parsed: unknown = JSON.parse(truncatedBody);
        const r = this.redactValue(parsed, basePath);
        return { value: JSON.stringify(r.value), hits: r.hits, truncated: [...truncated, ...r.truncated] };
      } catch {
        /* fall through — keep as text */
      }
    }
    if (ct.includes('x-www-form-urlencoded')) {
      try {
        const params = new URLSearchParams(truncatedBody);
        for (const key of [...params.keys()]) {
          if (this.isSensitiveKey(key)) {
            params.set(key, this.placeholder);
            hits.push(`${basePath}.${key}`);
          }
        }
        return { value: params.toString(), hits, truncated };
      } catch {
        /* fall through */
      }
    }
    return { value: truncatedBody, hits, truncated };
  }

  /** Redact sensitive query params inside a URL string. */
  redactUrl(url: string): { value: string; hits: string[] } {
    const hits: string[] = [];
    try {
      const u = new URL(url, 'http://recurr.local');
      let touched = false;
      for (const key of [...u.searchParams.keys()]) {
        if (this.isSensitiveKey(key)) {
          u.searchParams.set(key, this.placeholder);
          hits.push(`url.query.${key}`);
          touched = true;
        }
      }
      if (!touched) return { value: url, hits };
      // Preserve relative form if input was relative.
      const serialized = url.startsWith('http') ? u.toString() : u.pathname + u.search + u.hash;
      return { value: serialized, hits };
    } catch {
      return { value: url, hits };
    }
  }
}

export function createRedactor(config?: RedactionConfig): Redactor {
  return new Redactor(config);
}
