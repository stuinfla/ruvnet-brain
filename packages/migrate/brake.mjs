// The brake: one command back to 4.7 (`ruvnet-brain rollback-to-4`) and one command forward again
// (`--undo`). Because migration never changes 4.7, going back means only switching version 5 off:
// its host entries are removed (exactly those recorded in state/hosts.json), its automatic update is
// stopped, and the brake is recorded. Before anything is changed it checks that 4.7 can serve (its
// knowledge is there and a host still runs it); after, it checks that no host file still names the
// version 5 launcher. Either check failing is a non-zero exit with one sentence.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, writeJsonAtomic } from '../contract/home.mjs';
import { recordHosts, unregisterRecorded } from '../cli/hosts.mjs';
import { Refused } from '../cli/install.mjs';
import { registerHosts, shimPaths } from '../plugin/install.mjs';
import { currentLine } from '../health/line.mjs';
import { usable47 } from './detect.mjs';

/** The files migration and the brake write, inside the version 5 home (the generated reference lists them). */
export const WRITES = { migration: 'state/migration.json', brake: 'state/brake.json', config: 'state/config.json' };
export const brakeFile = (home) => path.join(home, ...WRITES.brake.split('/'));
const hostsRecord = (home) => path.join(paths(home).state, 'hosts.json');

/** The host files that still name this version 5 home's launcher. */
function stillNamed(home, hosts) {
  const launcher = shimPaths(home).launcher;
  const files = [hosts?.claude?.settings, hosts?.claude?.state, hosts?.codex?.config, hosts?.codex?.hooks].filter(Boolean);
  return files.filter((f) => {
    try {
      return fs.readFileSync(f, 'utf8').includes(launcher);
    } catch {
      return false;
    }
  });
}

/** 4.7 was switched off by its own switch: version 5 arrives with the brake on. */
export function carryBrake(home, why) {
  if (readJson(brakeFile(home), null)?.on) return;
  const cfg = readJson(paths(home).config, {});
  writeJsonAtomic(brakeFile(home), { on: true, carried: true, why: `4.7 was switched off (${why})`, at: Date.now(), saved: { autoUpdate: cfg.autoUpdate ?? null, hosts: null } });
  writeJsonAtomic(paths(home).config, { ...cfg, autoUpdate: false });
}

export async function brakeOn({ home, env = process.env, log = console.log }) {
  const u = usable47(env);
  if (!u.ok) throw new Refused(`4.7 cannot serve (${u.why}), so version 5 was left on`);
  const b = readJson(brakeFile(home), null);
  const cfg = readJson(paths(home).config, {});
  const rec = readJson(hostsRecord(home), null);
  // Recorded first, with what to put back, so an interrupted run is finished by running it again.
  if (!b?.on) writeJsonAtomic(brakeFile(home), { on: true, at: Date.now(), saved: { autoUpdate: cfg.autoUpdate ?? null, hosts: rec?.hosts ?? null } });
  const saved = readJson(brakeFile(home), null).saved;
  if (fs.existsSync(paths(home).state)) writeJsonAtomic(paths(home).config, { ...cfg, autoUpdate: false });
  await unregisterRecorded(home, log);
  const left = stillNamed(home, saved.hosts ?? rec?.hosts);
  if (left.length) throw new Refused(`the brake is recorded but these host files still start version 5: ${left.join(', ')}`);
  log(`brake on: version 5 is switched off (no host starts it; automatic update off). 4.7 (version ${u.d.version}, home ${u.d.home}) is serving through: ${u.d.hosts.map((e) => `${e.host} ${e.what}`).join('; ')}`);
  log('sessions already open keep their running version 5 server until they are restarted. Undo: ruvnet-brain rollback-to-4 --undo');
}

export async function brakeOff({ home, log = console.log }) {
  const b = readJson(brakeFile(home), null);
  if (!b?.on) {
    log('the brake is off already; version 5 is on');
    return;
  }
  const cfg = readJson(paths(home).config, {});
  const { autoUpdate, hosts } = b.saved ?? {};
  const next = { ...cfg };
  if (autoUpdate === null || autoUpdate === undefined) delete next.autoUpdate;
  else next.autoUpdate = autoUpdate;
  writeJsonAtomic(paths(home).config, next);
  if (hosts) {
    const r = registerHosts({ home, hosts });
    recordHosts(home, hosts, r);
    for (const f of r.written) log(`host file updated: ${f}`);
    if (stillNamed(home, hosts).length === 0) throw new Refused('the host entries could not be put back');
  }
  fs.rmSync(brakeFile(home), { force: true });
  log(`brake off: version 5 is on again${hosts ? ' and registered with its hosts' : ''}`);
  log(currentLine(home).line);
}
