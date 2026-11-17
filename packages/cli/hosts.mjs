// The shim and the host registrations around an install (work package 7, wired at wave 2).
// After every committed install or update the shim is refreshed in <home>/shim. Hosts are registered
// only when the install is run with --register-hosts (off by default until cutover, so running the
// installer by hand during development never touches a real host); the host files registered are
// recorded in state/hosts.json, and uninstall removes exactly those entries again.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, writeJsonAtomic } from '../contract/home.mjs';

const shimApi = () => import('../plugin/install.mjs');
export const HOSTS_FLAG = '--register-hosts';
const record = (home) => path.join(paths(home).state, 'hosts.json');

/** Every host file a registration would read or write, for the plan. */
export async function hostPlan(register, env = process.env) {
  if (!register) return [];
  const hosts = (await shimApi()).hostFiles(env);
  return [hosts.claude?.settings, hosts.claude?.state, hosts.claude && path.join(hosts.claude.skills, 'ruvnet-brain', 'SKILL.md'), hosts.claude && path.join(hosts.claude.commands, 'brain.md'), hosts.codex?.config, hosts.codex?.hooks].filter(Boolean);
}

/** The plan lines for the shim (inside the brain home): what it writes and the temporary names. */
export const SHIM_PLAN = { write: ['shim/**'], temporary: ['shim.partial/**', 'shim.old/**'] };

/** Refreshes the shim, then registers hosts when asked. Returns the registration (or null). */
export async function afterInstall({ home, register, env = process.env, log = () => {} }) {
  const w = await shimApi();
  w.installShim({ home });
  if (!register) return null;
  const hosts = w.hostFiles(env);
  const r = w.registerHosts({ home, hosts });
  writeJsonAtomic(record(home), { hosts });
  for (const f of r.written) log(`host file updated: ${f}`);
  for (const c of r.conflicts) log(`host file not changed: ${c.file} (${c.what})`);
  if (!Object.keys(hosts).length) log('no host settings folder was found, so no host was registered');
  return r;
}

/** Removes the host entries an earlier --register-hosts made. Returns the files changed. */
export async function unregisterRecorded(home, log = () => {}) {
  const rec = readJson(record(home), null);
  if (!rec?.hosts) {
    log('host registrations: none were made (install --register-hosts was not used), so none are removed');
    return [];
  }
  const r = (await shimApi()).unregisterHosts({ home, hosts: rec.hosts });
  for (const f of r.written) log(`host file restored: ${f}`);
  fs.rmSync(record(home), { force: true });
  return r.written;
}
