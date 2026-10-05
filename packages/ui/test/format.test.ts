import { describe, expect, it } from 'vitest';
import { diffLines, fmtBytes, fmtMs, fmtTime, fmtTimeShort, prettyBody, statusClass } from '../src/lib/format';

describe('fmtMs', () => {
  it('formats sub-ms, ms, s, m and undefined', () => {
    expect(fmtMs(undefined)).toBe('—');
    expect(fmtMs(0.5)).toBe('0.50ms');
    expect(fmtMs(12.4)).toBe('12ms');
    expect(fmtMs(2420)).toBe('2.42s');
    expect(fmtMs(125_000)).toBe('2.1m');
  });
});

describe('fmtTime / fmtTimeShort', () => {
  it('handles missing and invalid input', () => {
    expect(fmtTime(undefined)).toBe('—');
    expect(fmtTimeShort(undefined)).toBe('—');
    expect(fmtTime('not-a-date')).toBe('not-a-date');
  });
  it('formats a real timestamp', () => {
    expect(fmtTime('2026-01-02T03:04:05.006Z')).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/);
  });
  it('renders relative ages', () => {
    expect(fmtTimeShort(new Date(Date.now() - 30_000).toISOString())).toBe('just now');
    expect(fmtTimeShort(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(fmtTimeShort(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago');
  });
});

describe('fmtBytes', () => {
  it('covers the scale ladder', () => {
    expect(fmtBytes(undefined)).toBe('—');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(20_000)).toBe('19.5 KB');
    expect(fmtBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('prettyBody', () => {
  it('pretty-prints JSON and passes through non-JSON', () => {
    const { text, isJson } = prettyBody('{"a":1,"b":[2,3]}');
    expect(isJson).toBe(true);
    expect(text).toContain('"a": 1');
    expect(prettyBody('plain text').isJson).toBe(false);
    expect(prettyBody('{broken').isJson).toBe(false);
    expect(prettyBody(undefined).text).toBe('');
  });
});

describe('statusClass', () => {
  it('maps status codes to severity classes', () => {
    expect(statusClass(undefined)).toBe('dim');
    expect(statusClass(200)).toBe('ok');
    expect(statusClass(404)).toBe('warn');
    expect(statusClass(500)).toBe('err');
  });
});

describe('diffLines', () => {
  it('marks added/removed/context lines', () => {
    const out = diffLines('a\nb\nc', 'a\nx\nc');
    expect(out).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });
  it('handles identical and empty inputs', () => {
    expect(diffLines('x\ny', 'x\ny').every((l) => l.kind === 'same')).toBe(true);
    expect(diffLines('', 'new').map((l) => l.kind)).toEqual(['del', 'add']);
  });
  it('caps pathological inputs instead of building a huge table', () => {
    const out = diffLines('l\n'.repeat(2100), 'r\n'.repeat(2100));
    expect(out).toHaveLength(2);
    expect(out[0].text).toContain('too large to diff');
  });
});
