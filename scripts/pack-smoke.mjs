#!/usr/bin/env node
/**
 * Packaged-install smoke test — the gap between "works in the workspace" and
 * "works when installed from npm".
 *
 * Packs every publishable package, installs the tarballs into a bare project
 * (real node_modules/@recurr-dev/* layout — no workspace links), then runs
 * capture → replay against it. This exercises tarball contents, published
 * dependency wiring, and the replay preload's SDK path exemption — which only
 * exists under a real npm layout.
 *
 * Usage: node scripts/pack-smoke.mjs   (run `pnpm build` first)
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PACKAGES = ['core', 'store', 'replay', 'sdk', 'server', 'cli'];
const PORT = 5987;

const run = (cmd, args, cwd, opts = {}) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...opts.env }, ...opts });

const fail = (msg, res) => {
  console.error(`\n✗ pack-smoke: ${msg}`);
  if (res) {
    if (res.stdout) console.error('--- stdout ---\n' + res.stdout.slice(-2000));
    if (res.stderr) console.error('--- stderr ---\n' + res.stderr.slice(-2000));
  }
  process.exit(1);
};

// 1. Pack all publishable packages
const work = mkdtempSync(path.join(tmpdir(), 'recurr-pack-smoke-'));
const packsDir = path.join(work, 'packs');
mkdirSync(packsDir);
const tarballs = [];
for (const p of PACKAGES) {
  const res = run('pnpm', ['pack', '--pack-destination', packsDir], path.join(root, 'packages', p));
  if (res.status !== 0) fail(`pnpm pack failed for ${p}`, res);
}
for (const f of readdirSync(packsDir)) if (f.endsWith('.tgz')) tarballs.push(path.join(packsDir, f));
if (tarballs.length !== PACKAGES.length) fail(`expected ${PACKAGES.length} tarballs, got ${tarballs.length}`);
console.log(`packed ${tarballs.length} tarballs`);

// 2. Bare external project — npm install resolves @recurr-dev/* from the tarballs
const appDir = path.join(work, 'app');
mkdirSync(appDir);
if (run('npm', ['init', '-y'], appDir).status !== 0) fail('npm init failed');
const inst = run('npm', ['install', '--no-audit', '--no-fund', ...tarballs, 'express'], appDir);
if (inst.status !== 0) fail('npm install of packed tarballs failed', inst);

const storeDir = path.join(appDir, '.recurr', 'store');
writeFileSync(
  path.join(appDir, 'app.mjs'),
  `import express from 'express';
import { init } from '@recurr-dev/sdk';

const recurr = await init({
  service: 'pack-smoke',
  store: 'fs:${storeDir}',
  capture: { on: 'error' },
});
const app = express();
app.use(recurr.middleware());
app.post('/boom', () => { throw new Error('pack-smoke intentional failure'); });
app.use(recurr.errorMiddleware());
app.listen(${PORT}, () => console.log('listening'));
`,
);

// 3. Capture an incident with the installed SDK
const app = spawn('node', ['app.mjs'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = '';
app.stdout.on('data', (d) => (appLog += d));
app.stderr.on('data', (d) => (appLog += d));
await new Promise((r) => setTimeout(r, 2500));
const hit = run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', `http://127.0.0.1:${PORT}/boom`], appDir);
if (hit.stdout.trim() !== '500') fail(`expected 500 from smoke app, got ${hit.stdout.trim()}\n${appLog}`);
await new Promise((r) => setTimeout(r, 800)); // let the record flush
app.kill('SIGTERM');

const execsDir = path.join(storeDir, 'executions');
const ids = existsSync(execsDir)
  ? readdirSync(execsDir).filter((f) => f.startsWith('RUN-')).map((f) => f.replace(/\.json$/, ''))
  : [];
if (ids.length === 0) fail(`no incident captured by installed SDK\n${appLog}`);
const id = ids[0];
console.log(`captured ${id}`);

// 4. Replay it with the installed CLI — the packaged-layout killer
const replay = run(
  path.join(appDir, 'node_modules', '.bin', 'recurr'),
  ['replay', id, '-t', 'node app.mjs', '--store', `fs:${storeDir}`],
  appDir,
);
if (replay.status !== 0 || !replay.stdout.includes('replay complete')) {
  fail('replay failed under npm-installed packages', replay);
}
if (!replay.stdout.includes('reproduced')) fail('replay did not reproduce the incident', replay);

console.log(`✓ pack-smoke passed — captured ${id}, replayed via installed tarball packages`);
