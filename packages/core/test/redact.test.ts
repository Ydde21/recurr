import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/redact.js';

describe('Redactor', () => {
  it('redacts default sensitive fields in nested objects', () => {
    const r = new Redactor();
    const res = r.redactValue({
      user: 'ada',
      password: 'hunter2',
      nested: { Authorization: 'Bearer x', 'x-api-key': 'k', keep: 'me' },
    });
    const v = res.value as Record<string, unknown>;
    expect(v.user).toBe('ada');
    expect(v.password).toBe('[REDACTED]');
    const nested = v.nested as Record<string, unknown>;
    expect(nested.Authorization).toBe('[REDACTED]');
    expect(nested['x-api-key']).toBe('[REDACTED]');
    expect(nested.keep).toBe('me');
    expect(res.hits.length).toBe(3);
  });

  it('redacts compound sensitive names (password_hash, session_token)', () => {
    const r = new Redactor();
    const res = r.redactValue({ password_hash: 'abc', user_session_token: 't', author: 'grace' });
    const v = res.value as Record<string, string>;
    expect(v.password_hash).toBe('[REDACTED]');
    expect(v.user_session_token).toBe('[REDACTED]');
    expect(v.author).toBe('grace');
  });

  it('redacts headers', () => {
    const r = new Redactor();
    const res = r.redactHeaders(
      { authorization: 'Bearer sekret', 'content-type': 'application/json', cookie: 's=1' },
      'request.headers',
    );
    expect(res.value.authorization).toBe('[REDACTED]');
    expect(res.value.cookie).toBe('[REDACTED]');
    expect(res.value['content-type']).toBe('application/json');
  });

  it('redacts JSON bodies', () => {
    const r = new Redactor();
    const res = r.redactBody('{"items":[],"card":{"card_number":"4242","cvv":"123"}}', 'application/json', 'request.body');
    const parsed = JSON.parse(res.value!);
    expect(parsed.card.card_number).toBe('[REDACTED]');
    expect(parsed.card.cvv).toBe('[REDACTED]');
    expect(parsed.items).toEqual([]);
  });

  it('redacts urlencoded bodies', () => {
    const r = new Redactor();
    const res = r.redactBody('user=a&password=b', 'application/x-www-form-urlencoded', 'request.body');
    const params = new URLSearchParams(res.value!);
    expect(params.get('user')).toBe('a');
    expect(params.get('password')).toBe('[REDACTED]');
  });

  it('redacts sensitive query params in URLs', () => {
    const r = new Redactor();
    const res = r.redactUrl('/api/x?api_key=sekret&safe=1');
    expect(res.value).toContain('safe=1');
    expect(res.value).not.toContain('sekret');
  });

  it('supports custom fields and explicit paths', () => {
    const r = new Redactor({ fields: ['internal_score'], paths: ['request.body.deep.secret_place'] });
    const res = r.redactValue({ internal_score: 5, deep: { secret_place: 9, fine: 1 } }, 'request.body');
    const v = res.value as { internal_score: unknown; deep: { secret_place: unknown; fine: number } };
    expect(v.internal_score).toBe('[REDACTED]');
    expect(v.deep.secret_place).toBe('[REDACTED]');
    expect(v.deep.fine).toBe(1);
  });

  it('truncates oversized bodies', () => {
    const r = new Redactor({ maxBodyBytes: 64 });
    const big = JSON.stringify({ data: 'x'.repeat(500) });
    const res = r.redactBody(big, 'text/plain', 'response.body');
    expect(res.truncated.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(res.value!, 'utf8')).toBeLessThanOrEqual(64);
  });
});
