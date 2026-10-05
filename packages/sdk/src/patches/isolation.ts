import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { createRequire } from 'node:module';

/**
 * Replay isolation — hard egress guard, installed only in replay mode.
 *
 * Instrumented dependencies (fetch, http(s).request, db) are intercepted at a
 * higher level. This layer exists for everything else: an uninstrumented pg
 * client, a raw socket, a spawned process, a DNS lookup must NEVER reach the
 * outside world during replay. Refuses outbound connections and child
 * processes with a clearly-named error so the failure surfaces in the replay
 * record rather than silently contacting production.
 *
 * Escape hatch (explicit, documented): RECURR_REPLAY_ALLOW_NET=1.
 */

export class RecurrIsolationError extends Error {
  code = 'ERECURR_ISOLATION';
  constructor(what: string) {
    super(`[recurr] replay isolation: blocked ${what} — replays may not touch the outside world`);
    this.name = 'RecurrIsolationError';
  }
}

let installed = false;

export interface IsolationOptions {
  /** host[:port] targets that remain reachable — the record store needs this
   *  when it's pg:/http: so the replay record can actually be persisted. */
  allowHosts?: string[];
}

export function installReplayIsolation(opts: IsolationOptions = {}): void {
  if (installed) return;
  installed = true;
  if (process.env.RECURR_REPLAY_ALLOW_NET === '1') return;

  const allowed = new Set((opts.allowHosts ?? []).map(normalizeTarget));
  const allowedDnsHosts = new Set(
    (opts.allowHosts ?? [])
      .map((t) => t.split(':')[0])
      .filter(Boolean),
  );

  // -- outbound TCP/TLS ------------------------------------------------------
  const origSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    // connect(options) | connect(port, host) | connect(path) — pg uses (port, host).
    const target =
      typeof args[0] === 'number' && typeof args[1] === 'string'
        ? normalizeTarget(`${args[1]}:${args[0]}`)
        : normalizeTarget(describeTarget(args[0]));
    if (allowed.has(target)) {
      return (origSocketConnect as (...a: unknown[]) => net.Socket).apply(this, args);
    }
    const s = this;
    queueMicrotask(() => s.destroy(new RecurrIsolationError(`tcp connect ${target}`)));
    return s;
  };
  // net.connect / net.createConnection are thin wrappers over Socket#connect.

  const origTlsConnect = tls.connect;
  tls.connect = function (...args: unknown[]): tls.TLSSocket {
    // tls.connect(options) | tls.connect(port, host[, options]) — same fix as tcp.
    const target =
      typeof args[0] === 'number' && typeof args[1] === 'string'
        ? normalizeTarget(`${args[1]}:${args[0]}`)
        : normalizeTarget(describeTarget(args.find((a) => typeof a === 'object' && a !== null)));
    if (allowed.has(target)) {
      return (origTlsConnect as (...a: unknown[]) => tls.TLSSocket)(...args);
    }
    const sock = new tls.TLSSocket(new net.Socket());
    queueMicrotask(() => sock.destroy(new RecurrIsolationError(`tls connect ${target}`)));
    return sock;
  } as typeof tls.connect;

  // -- UDP -------------------------------------------------------------------
  dgram.Socket.prototype.send = function (this: dgram.Socket, ...args: unknown[]): void {
    const cb = args.find((a): a is (err?: Error | null) => void => typeof a === 'function');
    const err = new RecurrIsolationError('udp send');
    if (cb) queueMicrotask(() => cb(err));
    else queueMicrotask(() => this.emit('error', err));
  } as dgram.Socket['send'];
  // A UDP listener is an inbound surface just like a TCP listener — force it
  // onto loopback + an ephemeral port rather than whatever the app asked for.
  const origDgramBind = dgram.Socket.prototype.bind;
  dgram.Socket.prototype.bind = function (this: dgram.Socket, ...args: unknown[]): void {
    const cb = args.find((a): a is () => void => typeof a === 'function');
    (origDgramBind as (...a: unknown[]) => void).call(this, { port: 0, address: '127.0.0.1' });
    if (cb) queueMicrotask(cb);
  } as typeof dgram.Socket.prototype.bind;

  // -- DNS -------------------------------------------------------------------
  // Lookups for allowlisted store hosts stay working — everything else fails.
  // IP literals and loopback names pass through too: getaddrinfo resolves them
  // locally (no DNS egress) and server.listen() depends on it.
  const LOCAL_LOOKUPS = new Set(['localhost', 'localhost.', '0.0.0.0', '::1', '::', '127.0.0.1', '::ffff:127.0.0.1']);
  const dnsErr = (what: string) => Object.assign(new RecurrIsolationError(`dns ${what}`), { code: 'ENOTFOUND' });
  const origLookup = dns.lookup.bind(dns);
  const lookupAllowed = (hostname: string) =>
    allowedDnsHosts.has(hostname) || LOCAL_LOOKUPS.has(hostname) || net.isIP(hostname) !== 0;
  dns.lookup = function (hostname: string, ...rest: unknown[]): void {
    if (lookupAllowed(hostname)) {
      (origLookup as (...a: unknown[]) => void)(hostname, ...rest);
      return;
    }
    const cb = rest.find((a): a is (...a: unknown[]) => void => typeof a === 'function');
    // Real DNS is async — invoke on the next tick so callers that set flags
    // after the call see the same ordering as in production.
    setImmediate(() => cb?.(dnsErr(`lookup ${hostname}`), null, null));
  } as typeof dns.lookup;
  dns.resolve = function (hostname: string, ...rest: unknown[]): void {
    const cb = rest.find((a): a is (...a: unknown[]) => void => typeof a === 'function');
    setImmediate(() => cb?.(dnsErr(`resolve ${hostname}`), []));
  } as typeof dns.resolve;
  for (const fn of ['resolve4', 'resolve6', 'resolveMx', 'resolveTxt', 'resolveSrv', 'resolveNs', 'resolveCname', 'reverse'] as const) {
    const orig = dns[fn];
    if (typeof orig === 'function') {
      (dns as Record<string, unknown>)[fn] = (...rest: unknown[]) => {
        const cb = rest.find((a): a is (...a: unknown[]) => void => typeof a === 'function');
        setImmediate(() => cb?.(dnsErr(`${fn}`), []));
      };
    }
  }
  if (dns.promises) {
    const promised = dns.promises as unknown as Record<string, (...a: never[]) => Promise<never>>;
    for (const fn of Object.keys(promised)) {
      const origFn = promised[fn];
      promised[fn] = (...a: never[]) => {
        const hostname = a[0] as unknown as string;
        if (lookupAllowed(hostname)) {
          return origFn(...a);
        }
        return Promise.reject(dnsErr(`promises.${fn}`));
      };
    }
  }

  // -- listeners -------------------------------------------------------------
  // http(s).Server.listen is already forced to 127.0.0.1:0 by replay.ts; this
  // covers raw net servers and anything else that would bind a real address.
  const origServerListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]): net.Server {
    const cb = args.find((a): a is () => void => typeof a === 'function');
    return origServerListen.call(this, { port: 0, host: '127.0.0.1' }, cb as never) as net.Server;
  } as typeof net.Server.prototype.listen;

  // -- child processes -------------------------------------------------------
  const blockSpawn = (what: string) => {
    throw new RecurrIsolationError(`child_process.${what}`);
  };
  childProcess.spawn = (() => blockSpawn('spawn')) as unknown as typeof childProcess.spawn;
  childProcess.exec = (() => blockSpawn('exec')) as unknown as typeof childProcess.exec;
  childProcess.execFile = (() => blockSpawn('execFile')) as unknown as typeof childProcess.execFile;
  childProcess.fork = (() => blockSpawn('fork')) as unknown as typeof childProcess.fork;
  childProcess.execSync = (() => blockSpawn('execSync')) as unknown as typeof childProcess.execSync;
  childProcess.execFileSync = (() => blockSpawn('execFileSync')) as unknown as typeof childProcess.execFileSync;
  childProcess.spawnSync = ((..._a: unknown[]) => ({
    status: null,
    signal: null,
    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
    pid: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error: new RecurrIsolationError('child_process.spawnSync'),
  })) as unknown as typeof childProcess.spawnSync;

  // -- worker threads / cluster --------------------------------------------------
  // A Worker runs a fresh module graph — none of our patches apply inside it,
  // so worker code would get unguarded egress. Blocked outright. cluster.fork
  // reaches internal spawn machinery that bypasses the child_process patch.
  try {
    const req = createRequire(import.meta.url);
    const wt = req('node:worker_threads') as { Worker: typeof import('node:worker_threads').Worker };
    const BlockedWorker = function (): never {
      throw new RecurrIsolationError('worker_threads.Worker');
    };
    wt.Worker = BlockedWorker as unknown as typeof wt.Worker;
  } catch {
    /* worker_threads unavailable */
  }
  try {
    const req = createRequire(import.meta.url);
    const cl = req('node:cluster') as { fork: (...a: unknown[]) => unknown };
    cl.fork = () => {
      throw new RecurrIsolationError('cluster.fork');
    };
  } catch {
    /* cluster unavailable */
  }

  // -- native addons -------------------------------------------------------------
  // A .node addon is uninstrumented native code — full host access with none
  // of these patches. A replay target must not load one.
  process.dlopen = function (...args: unknown[]): never {
    throw new RecurrIsolationError(`process.dlopen (${String(args[1] ?? 'native addon').slice(0, 80)})`);
  } as typeof process.dlopen;
  try {
    const req = createRequire(import.meta.url);
    const Module = req('node:module') as unknown as { _extensions?: Record<string, unknown> };
    if (Module._extensions?.['.node']) {
      Module._extensions['.node'] = () => {
        throw new RecurrIsolationError('require(.node native addon)');
      };
    }
  } catch {
    /* module internals unavailable */
  }

  // -- internal binding escape hatch ------------------------------------------
  // process.binding/_linkedBinding expose C++ internals — 'spawn_sync',
  // 'tcp_wrap', 'udp_wrap' etc. would bypass every JS-level patch above.
  // Internal code uses internalBinding (separate), so gating the public
  // surface only affects app code.
  const DANGEROUS_BINDINGS = new Set([
    'spawn_sync',
    'process_wrap',
    'tcp_wrap',
    'udp_wrap',
    'pipe_wrap',
    'tty_wrap',
    'signal_wrap',
    'fs_event_wrap',
    'cares_wrap',
  ]);
  const anyProc = process as unknown as {
    binding?: (...a: string[]) => unknown;
    _linkedBinding?: (...a: string[]) => unknown;
  };
  const origBinding = anyProc.binding?.bind(process);
  if (origBinding) {
    anyProc.binding = function (name: string, ...rest: string[]): unknown {
      if (DANGEROUS_BINDINGS.has(name)) throw new RecurrIsolationError(`process.binding(${name})`);
      return (origBinding as (...a: string[]) => unknown)(name, ...rest);
    };
  }
  const origLinked = anyProc._linkedBinding?.bind(process);
  if (origLinked) {
    anyProc._linkedBinding = function (name: string, ...rest: string[]): unknown {
      if (DANGEROUS_BINDINGS.has(name)) throw new RecurrIsolationError(`process._linkedBinding(${name})`);
      return (origLinked as (...a: string[]) => unknown)(name, ...rest);
    };
  }
}

function describeTarget(options: unknown): string {
  // net.connect() forwards a normalized args array [options, cb] as the first
  // argument to Socket#connect — unwrap one level when that happens.
  let o = options;
  if (Array.isArray(o)) o = o[0];
  if (typeof o === 'object' && o !== null) {
    const r = o as Record<string, unknown>;
    // Unix-domain socket / windows named pipe — filesystem IPC, never allowed.
    if (typeof r.path === 'string') return `unix:${r.path}`;
    const port = r.port ?? (r.protocol === 'https:' ? 443 : r.protocol === 'http:' ? 80 : '?');
    return `${r.host ?? r.hostname ?? '?'}:${port}`;
  }
  if (typeof o === 'string' && (o.startsWith('/') || o.startsWith('.'))) return `unix:${o}`;
  return String(o);
}

/** 'localhost' and loopback literals are interchangeable for allowlisting. */
function normalizeTarget(hostport: string): string {
  const m = /^(.*):(\d+)$/.exec(hostport);
  if (!m) return hostport;
  let host = m[1];
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost') host = '127.0.0.1';
  return `${host}:${m[2]}`;
}
