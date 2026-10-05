#!/usr/bin/env node
/**
 * End-to-end Recurr demo:
 *   1. start payment-sim + instrumented checkout-api
 *   2. trigger the payment-timeout bug (order > $500)
 *   3. recurr incidents / inspect
 *   4. recurr replay            → reproduces the 500
 *   5. recurr replay (fixed)    → 202, fix verified
 *   6. recurr regression save/run
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(demoDir, '../..');
const cli = path.join(repoRoot, 'packages/cli/dist/cli.js');
const storeDir = path.join(demoDir, '.recurr/store');
const storeSpec = `fs:${storeDir}`;

const PAYMENT_PORT = process.env.PAYMENT_PORT ?? '4781';
const PORT = process.env.PORT ?? '4790';
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;

const children = [];
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', cwd: demoDir, ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

async function waitReady(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} never became ready`);
}

async function main() {
  await fs.rm(storeDir, { recursive: true, force: true });
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(demoDir, '.recurr/config.json'), JSON.stringify({ service: 'checkout-api', store: storeSpec }, null, 2));

  console.log('\x1b[1m▶ starting payment-sim + checkout-api\x1b[0m');
  const sim = spawn('node', ['dist/payment-sim.js'], { cwd: demoDir, env: { ...process.env, PAYMENT_PORT }, stdio: 'inherit' });
  const api = spawn('node', ['dist/index.js'], {
    cwd: demoDir,
    env: { ...process.env, PORT, PAYMENT_URL, RECURR_STORE: storeSpec },
    stdio: 'inherit',
  });
  children.push(sim, api);
  await waitReady(`${PAYMENT_URL}/healthz`);
  await waitReady(`http://127.0.0.1:${PORT}/healthz`);

  console.log('\n\x1b[1m▶ POST /api/orders — sku-server ×1 ($899 > $500 threshold → payment hangs)\x1b[0m');
  const res = await fetch(`http://127.0.0.1:${PORT}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer demo-u1' },
    body: JSON.stringify({ items: [{ sku: 'sku-server', qty: 1 }] }),
  });
  console.log(`→ HTTP ${res.status}`, await res.json());

  // wait for the incident to land in the store
  let incidentId;
  for (let i = 0; i < 40 && !incidentId; i++) {
    const dir = path.join(storeDir, 'executions');
    const files = await fs.readdir(dir).catch(() => []);
    incidentId = files.find((f) => f.startsWith('RUN-') && f.endsWith('.json'))?.replace('.json', '');
    if (!incidentId) await new Promise((r) => setTimeout(r, 250));
  }
  if (!incidentId) throw new Error('no incident captured');

  console.log('\n\x1b[1m▶ recurr incidents\x1b[0m');
  await run('node', [cli, 'incidents', '--store', storeSpec]);
  console.log('\n\x1b[1m▶ recurr inspect\x1b[0m');
  await run('node', [cli, 'inspect', incidentId, '--store', storeSpec]);

  console.log('\n\x1b[1m▶ recurr replay (same code — should reproduce the 500)\x1b[0m');
  await run('node', [cli, 'replay', incidentId, '-t', 'node dist/index.js', '--cwd', demoDir, '--store', storeSpec]);

  console.log('\n\x1b[1m▶ recurr replay against the FIXED build (index-fixed.js)\x1b[0m');
  await run('node', [cli, 'replay', incidentId, '-t', 'node dist/index-fixed.js', '--cwd', demoDir, '--store', storeSpec]);

  console.log('\n\x1b[1m▶ recurr regression save + run\x1b[0m');
  await run('node', [cli, 'regression', 'save', incidentId, '--name', 'checkout payment timeout', '--store', storeSpec]);
  await run('node', [cli, 'regression', 'run', 'checkout payment timeout', '-t', 'node dist/index-fixed.js', '--cwd', demoDir, '--store', storeSpec]);
}

main()
  .catch((err) => {
    console.error('\x1b[31mdemo failed:\x1b[0m', err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const c of children) c.kill('SIGTERM');
  });
