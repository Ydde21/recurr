import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { preflightTarget } from '../src/preflight.js';

let tmp: string;
const entry = async (name: string, src: string): Promise<string> => {
  const file = path.join(tmp, name);
  await writeFile(file, src);
  return file;
};

describe('preflightTarget', () => {
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('flags dev-tool launchers as fatal', async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'recurr-preflight-'));
    for (const bin of ['tsx', 'nodemon', 'ts-node', 'next', 'vite-node', 'bun', 'vitest']) {
      const r = preflightTarget([bin, 'index.ts'], tmp);
      expect(r.ok, bin).toBe(false);
      expect(r.problems[0].severity).toBe('fatal');
      expect(r.problems[0].detail).toContain(bin);
    }
  });

  it('flags a static blocked-builtin import in the entry as fatal', async () => {
    const f = await entry('bad.mjs', `import { spawn } from 'node:child_process';\nconsole.log(spawn);\n`);
    const r = preflightTarget(['node', f], tmp);
    expect(r.ok).toBe(false);
    expect(r.problems[0].detail).toContain('statically imports');
  });

  it('warns (not fatal) on require()/dynamic import — the path may be cold', async () => {
    const f = await entry('warm.mjs', `export function f(){ return require('child_process').execSync('x'); }\n`);
    const r = preflightTarget(['node', f], tmp);
    expect(r.ok).toBe(true);
    expect(r.problems.some((p) => p.severity === 'warn')).toBe(true);
  });

  it('passes a clean entry', async () => {
    const f = await entry('ok.mjs', `import http from 'node:http';\nhttp.createServer().listen(0);\n`);
    const r = preflightTarget(['node', f], tmp);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('scans -e inline code', async () => {
    const r = preflightTarget(['node', '-e', "import('node:dgram')"], tmp);
    expect(r.problems.some((p) => p.detail.includes('inline'))).toBe(true);
  });

  it('scans --require/--import files ahead of the entry', async () => {
    const pre = await entry('pre.mjs', `import 'node:worker_threads';\n`);
    const app = await entry('app.mjs', `console.log('app');\n`);
    const r = preflightTarget(['node', '--import', pre, app], tmp);
    expect(r.ok).toBe(false);
  });

  it('ignores commented-out imports', async () => {
    const f = await entry('commented.mjs', `// import 'node:child_process'\n/* require('dgram') */\nconsole.log(1);\n`);
    const r = preflightTarget(['node', f], tmp);
    expect(r.problems).toEqual([]);
  });

  it('does not flag non-node runtimes or missing files', async () => {
    expect(preflightTarget(['python3', 'app.py'], tmp).ok).toBe(true);
    expect(preflightTarget(['node', 'does-not-exist.mjs'], tmp).ok).toBe(true);
  });
});
