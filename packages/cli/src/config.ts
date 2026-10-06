import { promises as fs } from 'node:fs';
import path from 'node:path';
import { openStore, type IncidentStore } from '@recurr-dev/store';

export interface CliConfig {
  store?: string;
  service?: string;
  collector?: string;
}

export const CONFIG_DIR = '.recurr';
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export async function loadConfig(cwd = process.cwd()): Promise<CliConfig> {
  try {
    const raw = await fs.readFile(path.join(cwd, CONFIG_FILE), 'utf8');
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

export interface ResolvedStore {
  store: IncidentStore;
  spec: string;
}

/** --store flag > RECURR_STORE env > .recurr/config.json > fs:.recurr/store */
export async function resolveStore(flag?: string, cwd = process.cwd()): Promise<ResolvedStore> {
  const cfg = await loadConfig(cwd);
  let spec = flag ?? process.env.RECURR_STORE ?? cfg.store ?? `fs:${path.join(CONFIG_DIR, 'store')}`;
  // fs specs must be absolute: replay children run with --cwd and would
  // otherwise resolve the same relative path against a different directory.
  if (spec.startsWith('fs:')) spec = `fs:${path.resolve(cwd, spec.slice(3))}`;
  else if (!/^(pg:|postgres(ql)?:|https?:)/.test(spec)) spec = `fs:${path.resolve(cwd, spec)}`;
  return { store: openStore(spec), spec };
}
