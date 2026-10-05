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
/** Cap on nodes walked per redactValue call — bounds CPU on hostile sizes. */
const MAX_NODES = 50_000;

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
  // session/csrf/jwt as substrings catch compound header names like
  // x-session-id / x-csrf-token / x-jwt that a strict exact list misses.
  'session',
  'csrf',
  'xsrf',
  'jwt',
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

  /** Deep-redact an arbitrary JSON-ish value. Cycle-safe, depth-bounded, and
   *  node-budgeted — hostile payloads can't hang capture, and exotic types
   *  (BigInt, Map, functions) are rendered safe instead of crashing the
   *  downstream JSON.stringify. */
  redactValue<T>(value: T, basePath = ''): RedactionResult<T> {
    const hits: string[] = [];
    const truncated: string[] = [];
    const budget = { nodes: MAX_NODES };
    const out = this.walk(value, basePath, 0, hits, truncated, new WeakSet(), budget);
    return { value: out as T, hits, truncated };
  }

  private walk(
    value: unknown,
    path: string,
    depth: number,
    hits: string[],
    truncated: string[],
    seen: WeakSet<object>,
    budget: { nodes: number },
  ): unknown {
    if (value === null || value === undefined) return value;
    if (budget.nodes-- <= 0) {
      truncated.push(path);
      return '[NODE_BUDGET]';
    }
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
    // Non-JSON scalars get explicit markers — BigInt would otherwise crash
    // JSON.stringify at persist time and silently lose the whole record.
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}]`;
    if (typeof value !== 'object') return value;
    if (depth > this.maxDepth) {
      truncated.push(path);
      return '[MAX_DEPTH]';
    }
    if (seen.has(value)) {
      truncated.push(path);
      return '[CIRCULAR]';
    }
    seen.add(value);
    try {
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const clipped = b.length > this.maxBodyBytes;
        if (clipped) truncated.push(path);
        return { $base64: (clipped ? b.subarray(0, this.maxBodyBytes) : b).toString('base64') };
      }
      if (value instanceof Map) {
        truncated.push(path);
        return `[Map:${value.size}]`;
      }
      if (value instanceof Set || value instanceof WeakMap || value instanceof WeakSet) {
        truncated.push(path);
        const size = 'size' in value && typeof value.size === 'number' ? `:${value.size}` : '';
        return `[${value.constructor.name}${size}]`;
      }
      if (value instanceof Date) return value.toISOString();
      if (Array.isArray(value)) {
        return value.map((v, i) => this.walk(v, `${path}[${i}]`, depth + 1, hits, truncated, seen, budget));
      }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Object.keys itself can throw on a hostile Proxy — guard the whole
    // enumeration, not just per-key reads.
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      truncated.push(path);
      return '[unreadable]';
    }
    // Object.keys (names only) + per-key guarded reads — Object.entries would
    // let one throwing getter abort the entire walk and lose the record.
    for (const k of keys) {
      const childPath = path ? `${path}.${k}` : k;
      let v: unknown;
      try {
        v = obj[k];
      } catch {
        out[k] = '[getter threw]';
        truncated.push(childPath);
        continue;
      }
      const childVal =
        this.isSensitiveKey(k) || this.pathIsTargeted(childPath)
          ? (hits.push(childPath), this.placeholder)
          : this.walk(v, childPath, depth + 1, hits, truncated, seen, budget);
      // `out['__proto__'] = x` would mutate the prototype, not set a key.
      if (k === '__proto__') {
        Object.defineProperty(out, k, { value: childVal, enumerable: true, writable: true, configurable: true });
      } else {
        out[k] = childVal;
      }
    }
      return out;
    } finally {
      // Remove on the way out — `seen` tracks the active path, not every
      // object ever visited. A shared (DAG) reference should serialize
      // twice; only a true cycle (still on the path) is marked [CIRCULAR].
      seen.delete(value);
    }
  }

  /** Redact a header map. Sensitive headers are replaced wholesale. */
  redactHeaders(
    headers: Record<string, string | string[]>,
    basePath: string,
  ): RedactionResult<Record<string, string | string[]>> {
    const hits: string[] = [];
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) {
      const val = this.isSensitiveKey(k) ? (hits.push(`${basePath}.${k}`), this.placeholder) : v;
      if (k === '__proto__') {
        Object.defineProperty(out, k, { value: val, enumerable: true, writable: true, configurable: true });
      } else {
        out[k] = val;
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
      if (u.password) {
        u.password = this.placeholder;
        hits.push('url.userinfo.password');
        touched = true;
      }
      for (const key of [...u.searchParams.keys()]) {
        if (this.isSensitiveKey(key)) {
          u.searchParams.set(key, this.placeholder);
          hits.push(`url.query.${key}`);
          touched = true;
        }
      }
      if (!touched) return { value: url, hits };
      // Preserve relative form if input was relative. Check for a real scheme
      // (has '://') rather than a lowercase 'http' prefix — 'HTTP://' and other
      // schemes must keep their host.
      const serialized = url.includes('://') ? u.toString() : u.pathname + u.search + u.hash;
      return { value: serialized, hits };
    } catch {
      return { value: url, hits };
    }
  }
}

export function createRedactor(config?: RedactionConfig): Redactor {
  return new Redactor(config);
}
