import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/redact.js';

/**
 * Adversarial redaction — hostile payload shapes must never crash capture,
 * must never leak a sensitive value, and must honestly mark what was dropped.
 */

const r = createRedactor();

describe('redactValue — hostile shapes', () => {
  it('BigInt serializes instead of crashing JSON.stringify', () => {
    const out = r.redactValue({ n: BigInt('9007199254740993') }, 'x');
    expect(out.value).toEqual({ n: '9007199254740993n' });
    expect(() => JSON.stringify(out.value)).not.toThrow();
  });

  it('Map / Set / WeakMap render as markers, never silent empties', () => {
    const out = r.redactValue(
      { m: new Map([['a', 1]]), s: new Set([1, 2]), w: new WeakMap() },
      'x',
    ) as { value: { m: string; s: string; w: string }; truncated: string[] };
    expect(out.value.m).toBe('[Map:1]');
    expect(out.value.s).toBe('[Set:2]');
    expect(out.value.w).toBe('[WeakMap]');
    // Markers are flagged as truncations — honest about the loss.
    expect(out.truncated.length).toBeGreaterThanOrEqual(3);
    expect(() => JSON.stringify(out.value)).not.toThrow();
  });

  it('throwing getters do not abort the walk', () => {
    const evil = {
      ok: 1,
      get boom(): never {
        throw new Error('getter trap');
      },
      token: 'leak-me',
    };
    const out = r.redactValue(evil, 'x');
    const v = out.value as Record<string, unknown>;
    expect(v.ok).toBe(1);
    expect(v.boom).toBe('[getter threw]');
    expect(v.token).toBe('[REDACTED]');
    expect(out.truncated).toContain('x.boom');
  });

  it('hostile Proxy with throwing ownKeys cannot crash capture', () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys(): string[] {
          throw new Error('ownKeys trap');
        },
      },
    );
    const out = r.redactValue({ wrapped: proxy, ok: true }, 'x');
    expect((out.value as { wrapped: string }).wrapped).toBe('[unreadable]');
    expect((out.value as { ok: boolean }).ok).toBe(true);
  });

  it('deep nesting past maxDepth is marked, not walked forever', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    const out = r.redactValue(deep, 'x');
    expect(out.truncated.length).toBeGreaterThan(0);
    expect(() => JSON.stringify(out.value)).not.toThrow();
  });

  it('true cycles → [CIRCULAR]; shared DAG refs serialize twice (not circular)', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const cyc = r.redactValue(cyclic, 'x');
    expect((cyc.value as { self: string }).self).toBe('[CIRCULAR]');

    const shared = { cfg: 'same' };
    const dag = { first: shared, second: shared };
    const out = r.redactValue(dag, 'x');
    // A shared reference is NOT a cycle — both copies must survive.
    expect(out.value).toEqual({ first: { cfg: 'same' }, second: { cfg: 'same' } });
    expect(out.truncated.length).toBe(0);
  });

  it('Buffer/Uint8Array become $base64 with honest bounds', () => {
    const buf = Buffer.from('binary-\x00\x01-data');
    const out = r.redactValue({ raw: buf }, 'x');
    const v = out.value as { raw: { $base64: string } };
    expect(Buffer.from(v.raw.$base64, 'base64').toString('utf8')).toBe('binary-\x00\x01-data');

    const big = r.redactValue({ raw: Buffer.alloc(200 * 1024, 1) }, 'x');
    const bv = big.value as { raw: { $base64: string } };
    expect(Buffer.from(bv.raw.$base64, 'base64').length).toBe(64 * 1024);
    expect(big.truncated).toContain('x.raw');
  });

  it('__proto__ key in a captured object does not pollute the output prototype', () => {
    const hostile = JSON.parse('{"__proto__": {"isAdmin": true}, "name": "x"}');
    const out = r.redactValue(hostile, 'x') as { value: Record<string, unknown> };
    expect((out.value as { isAdmin?: boolean }).isAdmin).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out.value, '__proto__')).toBe(true);
    expect((out.value as { __proto__: { isAdmin: boolean } }).__proto__.isAdmin).toBe(true);
    // And the global prototype is untouched.
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
    expect(() => JSON.stringify(out.value)).not.toThrow();
  });

  it('constructor/prototype keys are walked without special-casing crashes', () => {
    const hostile = JSON.parse('{"constructor": {"prototype": {"token": "t"}}, "prototype": {"secret": "s"}}');
    const out = r.redactValue(hostile, 'x');
    const v = out.value as { constructor: { prototype: { token: string } }; prototype: { secret: string } };
    expect(v.constructor.prototype.token).toBe('[REDACTED]');
    expect(v.prototype.secret).toBe('[REDACTED]');
  });

  it('arrays nested with sensitive keys still redact by name', () => {
    const out = r.redactValue({ list: [{ password: 'p' }, { password: 'q', ok: 1 }] }, 'x');
    const v = out.value as { list: Array<Record<string, unknown>> };
    expect(v.list[0].password).toBe('[REDACTED]');
    expect(v.list[1].ok).toBe(1);
  });

  it('symbols and functions get markers — never crash, never leak a callable', () => {
    const out = r.redactValue({ sym: Symbol('s'), fn: () => 'x', ok: 1 }, 'x');
    const v = out.value as Record<string, unknown>;
    expect(v.sym).toBe('[symbol]');
    expect(v.fn).toBe('[function]');
    expect(v.ok).toBe(1);
    expect(() => JSON.stringify(out.value)).not.toThrow();
  });

  it('compound sensitive names are caught as substrings', () => {
    const out = r.redactValue(
      {
        'x-session-id': 'abc',
        'x-csrf-token': 'abc',
        'x-jwt': 'abc',
        'user_password_hash': 'abc',
        'stripe_api_key': 'abc',
        'my-secret-value': 'abc',
        'oauth-token': 'abc',
        'harmless': 'keep',
      },
      'x',
    );
    const v = out.value as Record<string, unknown>;
    for (const k of ['x-session-id', 'x-csrf-token', 'x-jwt', 'user_password_hash', 'stripe_api_key', 'my-secret-value', 'oauth-token']) {
      expect(v[k], `${k} not redacted`).toBe('[REDACTED]');
    }
    expect(v.harmless).toBe('keep');
  });
});

describe('redactHeaders / redactBody / redactUrl — hostile inputs', () => {
  it('header __proto__ key does not pollute output prototype', () => {
    const headers: Record<string, string> = Object.create(null);
    headers['__proto__'] = 'injected';
    headers['x-normal'] = 'ok';
    const out = r.redactHeaders(headers, 'h');
    expect(({} as { injected?: string }).injected).toBeUndefined();
    expect((out.value as Record<string, unknown>)['x-normal']).toBe('ok');
  });

  it('authorization/cookie/set-cookie/session headers always redact', () => {
    const out = r.redactHeaders(
      {
        'authorization': 'Bearer abc',
        'proxy-authorization': 'Basic abc',
        'cookie': 'sid=abc',
        'set-cookie': 'sid=abc',
        'x-session-id': 'abc',
        'x-csrf-token': 'abc',
        'x-api-key': 'abc',
        'content-type': 'application/json',
      },
      'h',
    );
    for (const k of ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-session-id', 'x-csrf-token', 'x-api-key']) {
      expect(out.value[k], `${k} not redacted`).toBe('[REDACTED]');
    }
    expect(out.value['content-type']).toBe('application/json');
    expect(out.hits.length).toBe(7);
  });

  it('urlencoded bodies redact sensitive params', () => {
    const out = r.redactBody('user=a&password=hunter2&csrf_token=t&ok=1', 'application/x-www-form-urlencoded', 'b');
    expect(out.value).toContain('password=%5BREDACTED%5D');
    expect(out.value).toContain('csrf_token=%5BREDACTED%5D');
    expect(out.value).toContain('ok=1');
  });

  it('JSON bodies redact nested secrets; malformed JSON stays text', () => {
    const json = r.redactBody('{"user":{"token":"abc","name":"n"}}', 'application/json', 'b');
    expect(JSON.parse(json.value!)).toEqual({ user: { token: '[REDACTED]', name: 'n' } });
    const bad = r.redactBody('{"unterminated', 'application/json', 'b');
    expect(bad.value).toBe('{"unterminated');
  });

  it('URL userinfo password + sensitive query params redact; host preserved for absolute URLs', () => {
    const abs = r.redactUrl('https://admin:hunter2@api.prod.com/x?token=abc&ok=1');
    // URL serialization percent-encodes the placeholder — check the effect.
    expect(abs.value).not.toContain('hunter2');
    expect(abs.value).not.toContain('token=abc');
    expect(abs.value).toContain('api.prod.com');
    expect(abs.hits.length).toBeGreaterThanOrEqual(2);

    const rel = r.redactUrl('/x?api_key=abc&ok=1');
    expect(rel.value).toBe('/x?api_key=%5BREDACTED%5D&ok=1');

    const upper = r.redactUrl('HTTP://u:p@h/x?secret=s');
    expect(upper.value).toContain('h');
    expect(upper.value).not.toContain(':p@');
  });

  it('maxBodyBytes truncation is flagged, and a body cut mid-UTF8 stays decodable', () => {
    const small = createRedactor({ maxBodyBytes: 16 });
    const out = small.redactBody('é'.repeat(20), 'text/plain', 'b'); // 40 bytes of 2-byte chars
    expect(out.truncated).toContain('b');
    expect(() => JSON.stringify(out.value)).not.toThrow();
    expect(out.value!.length).toBeLessThanOrEqual(16 + 4);
  });
});
