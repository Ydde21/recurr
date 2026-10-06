import { registerHooks } from 'node:module';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkRuntime } from '../src/doctor.js';

const tmpStore = async () => `fs:${path.join(await mkdtemp(path.join(tmpdir(), 'recurr-doctor-')), 'store')}`;

describe('checkRuntime', () => {
  it('report is internally consistent (replayable ⇔ no findings)', () => {
    // Test hosts (vitest workers, tsx, …) legitimately load blocked builtins —
    // what matters is the verdict tracks the findings, not a clean env.
    const report = checkRuntime();
    expect(report.replayable).toBe(report.findings.length === 0);
    if (typeof registerHooks !== 'function') {
      // Node <22.15: the version gap must always surface.
      expect(report.findings.some((f) => f.code === 'replay-unsupported-node')).toBe(true);
    }
  });

  it('flags a process that already loaded child_process', async () => {
    const require = createRequire(import.meta.url);
    require('node:child_process');
    const report = checkRuntime();
    expect(report.replayable).toBe(false);
    expect(report.findings.some((f) => f.code === 'blocked-module-loaded' && f.detail.includes('child_process'))).toBe(true);
  });

  it('findings always carry a remediation', () => {
    for (const f of checkRuntime().findings) {
      expect(f.remediation.length).toBeGreaterThan(0);
    }
  });
});

describe('init auto-warn', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits [recurr] doctor warnings on capture-only runtimes', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { init } = await import('../src/init.js');
    const recurr = await init({ service: 'doctor-test', store: await tmpStore() });
    const report = recurr.doctor();
    const emitted = spy.mock.calls.map((c) => String(c[0]));
    expect(emitted.filter((l) => l.includes('[recurr] doctor:')).length).toBe(report.findings.length);
    if (report.findings.length === 0) expect(emitted.some((l) => l.includes('doctor:'))).toBe(false);
  });

  it('doctor.warn: false silences the notice', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { init } = await import('../src/init.js');
    await init({ service: 'doctor-test', store: await tmpStore(), doctor: { warn: false } });
    expect(spy.mock.calls.some((c) => String(c[0]).includes('[recurr] doctor:'))).toBe(false);
  });
});
