import childProcess from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { installReplayIsolation, RecurrIsolationError } from '../src/patches/isolation.js';

/**
 * Egress guard: installed in replay mode, it must refuse outbound TCP, DNS,
 * UDP, child processes and workers. This file intentionally poisons those
 * globals — vitest runs each test file in its own process, so it's safe here.
 *
 * installReplayIsolation only applies on first call — the first test installs
 * it with one allowlisted loopback target (the "store endpoint"), so later
 * tests exercise both the blocked and allowed paths of the same install.
 */
describe('installReplayIsolation', () => {
  it('blocks outbound TCP while allowlisting the store endpoint — including (port, host) form', async () => {
    const allowedListener = await new Promise<net.Server>((resolve) => {
      const s = net.createServer(() => {}).listen(0, '127.0.0.1', () => resolve(s));
    });
    const allowedPort = (allowedListener.address() as { port: number }).port;
    const blockedListener = await new Promise<net.Server>((resolve) => {
      const s = net.createServer(() => {}).listen(0, '127.0.0.1', () => resolve(s));
    });
    const blockedPort = (blockedListener.address() as { port: number }).port;

    // 'localhost' spec → normalized to 127.0.0.1 inside the guard.
    installReplayIsolation({ allowHosts: [`localhost:${allowedPort}`] });

    // Allowlisted store endpoint stays reachable — pg's (port, host) convention.
    const okSock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(allowedPort, '127.0.0.1');
      s.on('connect', () => resolve(s));
      s.on('error', reject);
    });
    okSock.destroy();

    // Same host, different port → refused.
    const err = await new Promise<Error>((resolve) => {
      const s = net.connect(blockedPort, '127.0.0.1');
      s.on('error', resolve);
      s.on('connect', () => resolve(new Error('should never connect')));
    });
    expect(err).toBeInstanceOf(RecurrIsolationError);

    allowedListener.close();
    blockedListener.close();
  });

  it('blocks dns.lookup for real hosts but allows IP literals + allowlisted names', async () => {
    installReplayIsolation();
    const err = await new Promise<Error | null>((resolve) => {
      dns.lookup('example.com', (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(RecurrIsolationError);
    expect((err as { code?: string }).code).toBe('ENOTFOUND');
    // IP literals resolve locally (no DNS egress) — server.listen needs this.
    const lit = await new Promise<Error | null>((resolve) => {
      dns.lookup('127.0.0.1', (e) => resolve(e));
    });
    expect(lit).toBeNull();
  });

  it('forces raw net.Server.listen onto loopback ephemeral', async () => {
    installReplayIsolation();
    const s = net.createServer(() => {});
    await new Promise<void>((resolve) => s.listen(50505, '0.0.0.0', resolve));
    const addr = s.address() as { address: string; port: number };
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).not.toBe(50505);
    s.close();
  });

  it('blocks child_process spawn/exec/sync variants', async () => {
    installReplayIsolation();
    expect(() => childProcess.spawn('echo', ['x'])).toThrow(RecurrIsolationError);
    expect(() => childProcess.exec('echo x')).toThrow(RecurrIsolationError);
    expect(() => childProcess.execSync('echo x')).toThrow(RecurrIsolationError);
    expect(() => childProcess.fork('/tmp/x.js')).toThrow(RecurrIsolationError);
    const out = childProcess.spawnSync('echo', ['x']);
    expect(out.error).toBeInstanceOf(RecurrIsolationError);
  });

  it('blocks worker_threads.Worker (fresh module graph = unguarded egress)', async () => {
    installReplayIsolation();
    // Default export = module.exports (live); the namespace binding may be a
    // pre-patch snapshot for builtins.
    const Worker = (await import('node:worker_threads')).default.Worker;
    expect(() => new Worker('x', { eval: true })).toThrow(RecurrIsolationError);
  });

  it('blocks cluster.fork — reaches spawn internals past the child_process patch', async () => {
    installReplayIsolation();
    const cluster = (await import('node:cluster')).default;
    expect(() => cluster.fork()).toThrow(RecurrIsolationError);
  });

  it('blocks native addon loading — unguarded native code', async () => {
    installReplayIsolation();
    expect(() => process.dlopen({}, '/tmp/evil.node', undefined as never)).toThrow(RecurrIsolationError);
  });

  it('blocks dangerous process.binding / _linkedBinding internals', async () => {
    installReplayIsolation();
    // Internal code uses internalBinding, not these public wrappers — gating
    // them only affects app code reaching for C++ internals to bypass patches.
    expect(() => process.binding('spawn_sync')).toThrow(RecurrIsolationError);
    expect(() => process.binding('tcp_wrap')).toThrow(RecurrIsolationError);
    expect(() => process.binding('udp_wrap')).toThrow(RecurrIsolationError);
    const linked = (process as unknown as { _linkedBinding?: (n: string) => unknown })._linkedBinding;
    if (linked) expect(() => linked('spawn_sync')).toThrow(RecurrIsolationError);
    // Safe bindings still resolve — the gate is a blocklist, not a blanket ban.
    expect(() => process.binding('natives')).not.toThrow();
  });

  it('blocks dgram sends via callback error', async () => {
    installReplayIsolation();
    const sock = (await import('node:dgram')).createSocket('udp4');
    const err = await new Promise<Error | null>((resolve) => {
      sock.send(Buffer.from('x'), 9999, '127.0.0.1', (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(RecurrIsolationError);
    sock.close();
  });
});
