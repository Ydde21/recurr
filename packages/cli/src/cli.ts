#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { diffExecutions, validateRecord, type RegressionScenario } from '@recurr/core';
import { replayIncident, ReplayError } from '@recurr/replay';
import { CONFIG_DIR, CONFIG_FILE, loadConfig, resolveStore } from './config.js';
import { bold, cyan, dim, fmtTime, gray, green, INCIDENT_HEADERS, incidentRow, printDiffReport, printRecord, red, table, yellow } from './format.js';

const out = (s: string) => console.log(s);
const errOut = (s: string) => console.error(s);

const program = new Command();
program
  .name('recurr')
  .description('Production incident capture & replay — run production incidents back locally')
  .version('0.1.0')
  .option('--store <spec>', 'store spec: fs:<path> | pg:<conn> | http(s)://collector', undefined);

function storeOpt(cmd: Command): string | undefined {
  return (cmd.optsWithGlobals() as { store?: string }).store;
}

/** Parse a numeric CLI option; undefined default-safe. Throws on garbage. */
function numOpt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return n;
}

// ---------------------------------------------------------------------------
program
  .command('init')
  .description('Initialize recurr in the current project')
  .option('--service <name>', 'service name')
  .action(async (opts: { service?: string }, cmd: Command) => {
    const dir = path.join(process.cwd(), CONFIG_DIR);
    await fs.mkdir(path.join(dir, 'store'), { recursive: true });
    const cfgPath = path.join(process.cwd(), CONFIG_FILE);
    try {
      await fs.access(cfgPath);
      out(`${yellow('!')} ${CONFIG_FILE} already exists — leaving it alone`);
    } catch {
      const cfg = { service: opts.service ?? path.basename(process.cwd()), store: 'fs:.recurr/store' };
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
      out(`${green('✓')} wrote ${CONFIG_FILE}`);
    }
    await fs.writeFile(path.join(dir, '.gitignore'), 'store/\n');
    out(`${green('✓')} ${CONFIG_DIR}/ initialized (store/ is gitignored)`);
    out('');
    out(dim('  next: instrument your app with @recurr/sdk — see README'));
  });

// ---------------------------------------------------------------------------
program
  .command('incidents')
  .description('List captured incidents')
  .option('--service <name>', 'filter by service')
  .option('--limit <n>', 'max rows', '50')
  .option('--json', 'emit JSON')
  .action(async (opts: { service?: string; limit: string; json?: boolean }, cmd: Command) => {
    const { store } = await resolveStore(storeOpt(cmd));
    try {
      const list = await store.list({ kind: 'incident', service: opts.service, limit: numOpt(opts.limit, '--limit') });
      if (opts.json) {
        out(JSON.stringify(list, null, 2));
        return;
      }
      if (!list.length) {
        out(dim('no incidents captured yet'));
        return;
      }
      out(table(INCIDENT_HEADERS, list.map(incidentRow)));
    } finally {
      await store.close();
    }
  });

// ---------------------------------------------------------------------------
program
  .command('inspect')
  .description('Show an incident or replay: request, timeline, error, redaction')
  .argument('<id>', 'RUN-… or RPL-… id')
  .option('--json', 'emit the raw record JSON')
  .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
    const { store } = await resolveStore(storeOpt(cmd));
    try {
      const rec = await store.get(id);
      if (!rec) {
        errOut(red(`no record ${id}`));
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        out(JSON.stringify(rec, null, 2));
        return;
      }
      printRecord(rec, out);
      const seedBits = [`random×${rec.seed.random.length}`, `uuid×${rec.seed.uuids.length}`];
      if (rec.seed.timeReads !== undefined) seedBits.push(`clockReads×${rec.seed.timeReads}`);
      out(`${dim('seed')}         ${seedBits.join(' · ')}${rec.seed.randomConsumed !== undefined ? dim(`  (replay consumed ${rec.seed.randomConsumed} randoms)`) : ''}`);
      const replays = rec.kind === 'incident' ? await store.listReplays(rec.id) : [];
      if (replays.length) {
        out('');
        out(bold('replays'));
        for (const r of replays) {
          out(`  ${r.id}  ${fmtTime(r.capturedAt)}  → ${r.status ?? '?'}${r.errorName ? ` (${r.errorName})` : ''}`);
        }
      }
    } finally {
      await store.close();
    }
  });

// ---------------------------------------------------------------------------
program
  .command('replay')
  .description('Replay an incident in an isolated local process')
  .argument('<id>', 'incident id (RUN-…)')
  .requiredOption('-t, --target <cmd>', 'command that starts the app, e.g. "node dist/index.js"')
  .option('--cwd <dir>', 'target working directory')
  .option('--timeout <ms>', 'overall timeout', '60000')
  .option('--ready-timeout <ms>', 'target startup timeout', '20000')
  .option('--json', 'emit the diff report JSON')
  .action(async (id: string, opts: { target: string; cwd?: string; timeout: string; readyTimeout: string; json?: boolean }, cmd: Command) => {
    const { store, spec } = await resolveStore(storeOpt(cmd));
    try {
      const result = await replayIncident({
        store,
        storeSpec: spec,
        incidentId: id,
        target: { command: opts.target, cwd: opts.cwd },
        timeoutMs: numOpt(opts.timeout, '--timeout'),
        readyTimeoutMs: numOpt(opts.readyTimeout, '--ready-timeout'),
        onProgress: opts.json ? undefined : (m) => errOut(dim(m)),
      });
      if (opts.json) {
        out(JSON.stringify(result.report, null, 2));
        return;
      }
      out(`${green('✓')} replay complete → ${cyan(result.replay.id)} (injected → HTTP ${result.observedStatus})`);
      printDiffReport(result.report, out);
    } catch (err) {
      if (err instanceof ReplayError) {
        errOut(red(`replay failed: ${err.message}`));
        process.exitCode = 1;
        return;
      }
      throw err;
    } finally {
      await store.close();
    }
  });

// ---------------------------------------------------------------------------
program
  .command('diff')
  .description('Diff an incident against one of its replays')
  .argument('<incidentId>')
  .argument('<replayId>')
  .option('--json', 'emit the diff report JSON')
  .action(async (incidentId: string, replayId: string, opts: { json?: boolean }, cmd: Command) => {
    const { store } = await resolveStore(storeOpt(cmd));
    try {
      const [incident, replay] = await Promise.all([store.get(incidentId), store.get(replayId)]);
      if (!incident) {
        errOut(red(`no record ${incidentId}`));
        process.exitCode = 1;
        return;
      }
      if (!replay) {
        errOut(red(`no record ${replayId}`));
        process.exitCode = 1;
        return;
      }
      if (incident.kind === 'replay') {
        errOut(yellow(`warning: ${incidentId} is a replay record — did you mean to swap the arguments?`));
      }
      const report = diffExecutions(incident, replay);
      if (opts.json) {
        out(JSON.stringify(report, null, 2));
        return;
      }
      printDiffReport(report, out);
    } finally {
      await store.close();
    }
  });

// ---------------------------------------------------------------------------
program
  .command('export')
  .description('Export an incident record to a file (or stdout)')
  .argument('<id>')
  .option('-o, --out <file>', 'output file')
  .action(async (id: string, opts: { out?: string }, cmd: Command) => {
    const { store } = await resolveStore(storeOpt(cmd));
    try {
      const rec = await store.get(id);
      if (!rec) {
        errOut(red(`no record ${id}`));
        process.exitCode = 1;
        return;
      }
      const json = JSON.stringify(rec, null, 2) + '\n';
      if (opts.out) {
        await fs.writeFile(opts.out, json);
        out(`${green('✓')} exported ${id} → ${opts.out}`);
      } else {
        process.stdout.write(json);
      }
    } finally {
      await store.close();
    }
  });

// ---------------------------------------------------------------------------
program
  .command('import')
  .description('Import an incident record from a file')
  .argument('<file>')
  .action(async (file: string, _opts: unknown, cmd: Command) => {
    const { store } = await resolveStore(storeOpt(cmd));
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (e) {
        errOut(red(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`));
        process.exitCode = 1;
        return;
      }
      const v = validateRecord(parsed);
      if (!v.ok) {
        errOut(red(`not a valid recurr record: ${v.error}`));
        process.exitCode = 1;
        return;
      }
      await store.save(v.record);
      out(`${green('✓')} imported ${v.record.id}`);
    } finally {
      await store.close();
    }
  });

// ---------------------------------------------------------------------------
const regression = program.command('regression').description('Manage regression scenarios built from incidents');

regression
  .command('save')
  .description('Promote an incident to a regression scenario')
  .argument('<incidentId>')
  .requiredOption('--name <name>', 'scenario name')
  .option('--notes <text>', 'notes')
  .action(async (incidentId: string, opts: { name: string; notes?: string }, cmd: Command) => {
    const { store } = await resolveStore(storeOpt(cmd));
    try {
      const rec = await store.get(incidentId);
      if (!rec) {
        errOut(red(`no record ${incidentId}`));
        process.exitCode = 1;
        return;
      }
      const incidentRef = rec.kind === 'replay' && rec.replayOf ? rec.replayOf : rec.id;
      if (incidentRef !== rec.id) errOut(dim(`note: ${rec.id} is a replay — scenario points at ${incidentRef}`));
      const scenario: RegressionScenario = {
        id: `REG-${incidentRef.replace(/^RUN-/, '')}`,
        name: opts.name,
        incidentId: incidentRef,
        createdAt: new Date().toISOString(),
        expectedBugStatus: rec.response?.status,
        notes: opts.notes,
      };
      await store.saveRegression(scenario);
      out(`${green('✓')} saved scenario ${cyan(scenario.id)} "${opts.name}" → ${incidentId}`);
    } finally {
      await store.close();
    }
  });

regression
  .command('list')
  .description('List regression scenarios')
  .option('--json', 'emit JSON')
  .action(async (opts: { json?: boolean }, cmd: Command) => {
    const { store } = await resolveStore(storeOpt(cmd));
    try {
      const list = await store.listRegressions();
      if (opts.json) {
        out(JSON.stringify(list, null, 2));
        return;
      }
      if (!list.length) {
        out(dim('no regression scenarios'));
        return;
      }
      out(table(['ID', 'NAME', 'INCIDENT', 'BUG STATUS', 'CREATED'], list.map((s) => [s.id, s.name, s.incidentId, String(s.expectedBugStatus ?? '-'), fmtTime(s.createdAt)])));
    } finally {
      await store.close();
    }
  });

regression
  .command('run')
  .description('Replay a scenario\'s incident — verifies whether a fix resolves it')
  .argument('<idOrName>', 'scenario id (REG-…) or exact name')
  .requiredOption('-t, --target <cmd>', 'command that starts the app')
  .option('--cwd <dir>', 'target working directory')
  .option('--timeout <ms>', 'overall timeout', '60000')
  .action(async (idOrName: string, opts: { target: string; cwd?: string; timeout: string }, cmd: Command) => {
    const { store, spec } = await resolveStore(storeOpt(cmd));
    try {
      const scenarios = await store.listRegressions();
      const scenario = scenarios.find((s) => s.id === idOrName || s.name === idOrName);
      if (!scenario) {
        errOut(red(`no regression scenario ${idOrName}`));
        process.exitCode = 1;
        return;
      }
      const result = await replayIncident({
        store,
        storeSpec: spec,
        incidentId: scenario.incidentId,
        target: { command: opts.target, cwd: opts.cwd },
        timeoutMs: numOpt(opts.timeout, '--timeout'),
        onProgress: (m) => errOut(dim(m)),
      });
      printDiffReport(result.report, out);
      out('');
      if (result.report.outcomeMatch) {
        out(`${red('✗')} ${scenario.name}: bug still reproduces`);
        process.exitCode = 1;
      } else {
        out(`${green('✓')} ${scenario.name}: incident no longer reproduces — fix verified`);
      }
    } finally {
      await store.close();
    }
  });

// ---------------------------------------------------------------------------
program
  .command('doctor')
  .description('Check environment, store connectivity and capture prerequisites')
  .action(async (_opts: unknown, cmd: Command) => {
    const cfg = await loadConfig();
    const { store, spec } = await resolveStore(storeOpt(cmd));
    let ok = true;
    const check = (name: string, pass: boolean, detail = '') => {
      out(`${pass ? green('✓') : red('✗')} ${name}${detail ? dim(` — ${detail}`) : ''}`);
      if (!pass) ok = false;
    };

    check('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.version);
    check('config file', !!(await fs.stat(CONFIG_FILE).then(() => true).catch(() => false)), CONFIG_FILE);
    try {
      await store.list({ limit: 1 });
      check(`store reachable (${spec})`, true);
    } catch (e) {
      check(`store reachable (${spec})`, false, e instanceof Error ? e.message : String(e));
    }
    if (spec.startsWith('http')) {
      try {
        const res = await fetch(`${spec.replace(/\/$/, '')}/healthz`);
        check('collector /healthz', res.ok, String(res.status));
      } catch (e) {
        check('collector /healthz', false, e instanceof Error ? e.message : String(e));
      }
    }
    if (!cfg.service) out(dim(`  hint: run ${bold('recurr init --service <name>')}`));
    await store.close();
    process.exitCode = ok ? 0 : 1;
  });

// ---------------------------------------------------------------------------
program.parseAsync().catch((err) => {
  errOut(red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
