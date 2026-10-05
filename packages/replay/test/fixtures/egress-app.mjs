// Hostile-pattern app for isolation e2e — on every request it attempts every
// known escape path and reports which ones were reachable. During capture the
// attempts run live; during replay every one must be blocked.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { createRequire } from 'node:module';
import { init } from '@recurr/sdk';

const require = createRequire(import.meta.url);
const recurr = await init({ service: 'egress-app', capture: { on: 'always' } });
const mw = recurr.middleware();

const isBlocked = (e) =>
  e?.code === 'ERECURR_ISOLATION' || /isolation|recurr|blocked/i.test(e?.message ?? '') || e?.code === 'ENOTFOUND';

async function attempt(fn) {
  try {
    const v = await fn();
    return typeof v === 'string' ? v : 'REACHABLE';
  } catch (e) {
    return isBlocked(e) ? 'blocked' : `error:${String(e?.message ?? e).slice(0, 80)}`;
  }
}

const tcp = (port, host) =>
  new Promise((res, rej) => {
    const s = net.connect(port, host);
    s.once('connect', res);
    s.once('error', rej);
    setTimeout(() => rej(Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' })), 3000);
  });

http
  .createServer((req, res) => {
    mw(req, res, async () => {
      const out = {};
      out.tcp44 = await attempt(() => tcp(443, '1.1.1.1'));
      out.metadata = await attempt(() => fetch('http://169.254.169.254/latest/meta-data').then((r) => String(r.status)));
      out.dns = await attempt(() => dns.promises.resolve('evil.example.com').then((a) => `REACHABLE:${a[0]}`));
      out.dnsLookup = await attempt(() => new Promise((res2, rej) => dns.lookup('evil.example.com', (e, a) => (e ? rej(e) : res2(`REACHABLE:${a}`)))));
      out.unix = await attempt(() => tcp('/tmp/nonexistent-recurr.sock'));
      out.tls = await attempt(() => tcpTls(443, '1.1.1.1'));
      out.udp = await attempt(
        () =>
          new Promise((res2, rej) => {
            const s = require('node:dgram').createSocket('udp4');
            s.send('x', 53, '8.8.8.8', (e) => (e ? rej(e) : res2('REACHABLE')));
          }),
      );
      out.spawn = await attempt(() => require('node:child_process').execSync('echo REACHED'));
      out.fork = await attempt(() => require('node:child_process').exec('echo REACHED'));
      out.worker = await attempt(async () => {
        const wt = await import('node:worker_threads');
        return new wt.Worker('1+1', { eval: true }) ? 'REACHABLE' : 'blocked';
      });
      out.esmNamedSpawn = await attempt(() => import('node:child_process').then((m) => m.execSync('echo REACHED')));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  })
  .listen(Number(process.env.PORT ?? 0), '127.0.0.1');

function tcpTls(port, host) {
  return new Promise((res, rej) => {
    const s = tls.connect(port, host, () => res('REACHABLE'));
    s.once('error', rej);
    setTimeout(() => rej(Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' })), 3000);
  });
}
