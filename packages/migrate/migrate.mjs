// ruvnet-brain migrate: makes a version 5 installation BESIDE a 4.7 one, for the side-by-side soak
// (ROADMAP B1, work package 9 as scoped by the programme owner). It never writes, moves or deletes
// anything of 4.7: not its home, its knowledge, its private stores, its scheduled job or its host
// entries. Private stores are reported and left where they are (a version 5 private pack is a later,
// separate step). The plan is printed first; nothing happens without --apply.
//
// Steps (each recorded in <v5 home>/state/migration.json, so an interrupted run is finished by
// running the same command again; 4.7 is untouched at every step, so it keeps serving throughout):
//   begin -> home -> settings -> install -> hosts -> done
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainHome, paths, readJson, writeJsonAtomic } from '../contract/home.mjs';
import { HOME_ENV } from '../contract/constants.mjs';
import { afterInstall } from '../cli/hosts.mjs';
import { install, Refused } from '../cli/install.mjs';
import { isUrl } from '../cli/source.mjs';
import { currentLine } from '../health/line.mjs';
import { HostRefused } from '../plugin/install.mjs';
import { brakeFile, brakeOff, brakeOn, carryBrake, WRITES } from './brake.mjs';
import { detect47, L } from './detect.mjs';

export const USAGE = `usage:
  ruvnet-brain migrate [--plan] --from <release folder or https address>       print what would happen; changes nothing
  ruvnet-brain migrate --apply --from <release folder or https address> [--register-hosts]
  ruvnet-brain rollback-to-4            the brake: switch version 5 off and hand back to 4.7 (checks 4.7 can serve)
  ruvnet-brain rollback-to-4 --undo     release the brake: version 5 back on`;

const STEPS = ['begin', 'home', 'settings', 'install', 'hosts', 'done'];
const record = (home) => path.join(home, ...WRITES.migration.split('/'));

function step(home, rec, name) {
  rec.step = name;
  writeJsonAtomic(record(home), rec);
}

/** The version 5 home. Beside a 4.7 home that is a link to another disk, it goes on that disk too. */
export function home5(env, d) {
  const home = brainHome(env);
  if (env[HOME_ENV] || !d?.linked || fs.existsSync(home)) return { home, real: null };
  return { home, real: path.join(path.dirname(d.real), L.v5HomeName) };
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

export function planLines(d, h5, { from, register }) {
  const out = ['RuvNet Brain: migration plan from 4.7 to version 5 (side by side; 4.7 is not changed)'];
  out.push(`4.7 installation: ${d.home}${d.linked ? ` (a link to ${d.real})` : ''}, version ${d.version}`);
  out.push(`  knowledge: ${d.publicStores} public store(s) in ${d.kb}; left in place (version 5 downloads its own pack)`);
  out.push(d.autoUpdate === 'no' ? '  automatic updates: you answered "no" in 4.7 -> version 5 gets auto-update off' : `  automatic updates: ${d.autoUpdate === 'yes' ? 'you answered "yes"' : 'never answered'} in 4.7 -> version 5 keeps its default`);
  out.push(d.brainOff ? `  switched off: yes (${d.brainOff}) -> version 5 is installed with the brake on (switched off)` : '  switched off: no');
  if (!d.privateStores.length) out.push('  private stores: none');
  for (const s of d.privateStores) out.push(`  private store ${s.name} (${s.why}; ${s.files.length} file(s), ${mb(s.bytes)}): left in place, NOT carried into version 5`);
  if (d.privateStores.length) out.push('    (a version 5 private pack is a later, separate step; nothing private is copied by this command)');
  if (!d.nightly.length) out.push('  scheduled job: none found');
  for (const j of d.nightly) out.push(`  scheduled job (${j.kind}) ${j.path}: left in place for the side-by-side run; retired at cutover, not by this command`);
  for (const e of d.hosts) out.push(`  host entry (${e.host}) ${e.what} in ${e.file}: left in place`);
  out.push(`  everything else in ${d.home} (${d.otherEntries} entries besides ${L.knowledgeDir}/: logs, models, captures, console files): left in place, not used by version 5`);
  for (const o of d.otherOwned) out.push(`  ${o.what} ${o.path}: left in place, not used by version 5`);
  out.push(`version 5 home: ${h5.home}${h5.real ? ` (created at ${h5.real}, next to the 4.7 folder on the same disk, behind a link)` : ''}`);
  out.push(`  install from: ${from ?? '(none given: add --from <release folder or https address>)'}`);
  out.push(`  writes: ${h5.home}/**${register ? ' and one entry per host (--register-hosts), beside the 4.7 entries' : '; no host file (add --register-hosts to register version 5 beside 4.7)'}`);
  out.push('4.7 files changed: none. The way back at any time: ruvnet-brain rollback-to-4');
  return out;
}

/**
 * The test guard of --apply (wave 3). Under the test marker (RUVNET_BRAIN5_TEST=1) the 4.7 home is
 * read only from a path given explicitly (RUVNET_BRAIN_HOME), and never the real user's default 4.7
 * home (the account database's home folder, not $HOME). Throws before anything is read or written.
 */
export function refuseRealHome47(env) {
  if (env.RUVNET_BRAIN5_TEST !== '1') return;
  if (!env[L.homeEnv]) throw new Refused(`test run (RUVNET_BRAIN5_TEST=1): migrate --apply reads a 4.7 home only from a path given explicitly in ${L.homeEnv}; nothing was read or written`);
  const real = path.join(os.userInfo().homedir, ...L.homeDefault);
  const asked = path.resolve(env[L.homeEnv]);
  const same = (a, b) => a === b || (fs.existsSync(a) && fs.existsSync(b) && fs.realpathSync(a) === fs.realpathSync(b));
  if (same(asked, real)) throw new Refused(`test run (RUVNET_BRAIN5_TEST=1): migrate --apply refuses the real 4.7 home ${real}; nothing was read or written`);
}

async function apply({ env, from, register, log }) {
  refuseRealHome47(env);
  const d = detect47(env);
  if (!d.found) throw new Refused(`${d.why}; nothing to migrate (install version 5 with: ruvnet-brain install)`);
  if (!from) throw new Refused('give the version 5 release to install: --from <release folder or https address>');
  const h5 = home5(env, d);
  const home = h5.home;
  if (readJson(brakeFile(home), null)?.on && !readJson(brakeFile(home), null)?.carried) {
    throw new Refused('the brake is on (ruvnet-brain rollback-to-4 was run); release it first with: ruvnet-brain rollback-to-4 --undo');
  }
  const prev = readJson(record(home), null);
  if (prev?.step === 'done') {
    log(`already migrated (${prev.finishedAt}); 4.7 is still in place at ${d.home}`);
    log(currentLine(home).line);
    return prev;
  }
  const rec = prev ?? { schema: 'ruvnet-brain/migration', version: 1, from47: { home: d.home, real: d.real, version: d.version }, startedAt: new Date().toISOString() };
  rec.privateLeft = d.privateStores.map((s) => s.name);
  rec.nightlyLeft = d.nightly.map((j) => j.path);
  if (h5.real && !fs.existsSync(home)) {
    fs.mkdirSync(h5.real, { recursive: true });
    fs.mkdirSync(path.dirname(home), { recursive: true });
    fs.symlinkSync(h5.real, home, process.platform === 'win32' ? 'junction' : 'dir');
  }
  step(home, rec, 'begin');

  step(home, rec, 'home');
  fs.mkdirSync(paths(home).state, { recursive: true });

  step(home, rec, 'settings');
  if (d.autoUpdate === 'no') writeJsonAtomic(paths(home).config, { ...readJson(paths(home).config, {}), autoUpdate: false });
  if (d.brainOff) carryBrake(home, d.brainOff);

  step(home, rec, 'install');
  const r = await install({ home, from: isUrl(from) ? from : path.resolve(from), log });
  log(`installed: app ${r.current.app}, pack ${r.current.pack}`);

  step(home, rec, 'hosts');
  const braked = readJson(brakeFile(home), null)?.on;
  const reg = await afterInstall({ home, register: register && !braked, env, log });
  if (register && braked) log('host registration skipped: 4.7 was switched off, so version 5 starts with the brake on (release it with: ruvnet-brain rollback-to-4 --undo)');
  // Version 5's server is named ruvnet-brain-5 for the side-by-side period, so it sits beside 4.7's
  // ruvnet-brain in every host; a host it still cannot serve was reported by afterInstall and gets no hook.
  if (reg && !reg.unserved?.length) log('every registered host is served by version 5 (server ruvnet-brain-5), beside 4.7');

  rec.finishedAt = new Date().toISOString();
  step(home, rec, 'done');
  log(`migrated: version 5 is installed beside 4.7 (4.7 home ${d.home} unchanged)`);
  if (d.privateStores.length) log(`private stores left in 4.7, not carried: ${d.privateStores.map((s) => s.name).join(', ')}`);
  log(currentLine(home).line);
  return rec;
}

/** The command-table entry for `migrate` and `rollback-to-4`. Returns the exit code. */
export async function main(cmd, args, { env = process.env, log = console.log, err = console.error } = {}) {
  const flag = (n) => {
    const i = args.indexOf(n);
    return i < 0 ? null : args[i + 1] ?? null;
  };
  if (args.includes('--help')) {
    log(USAGE);
    return 0;
  }
  try {
    if (cmd === 'rollback-to-4') {
      const d = detect47(env);
      const home = home5(env, d.found ? d : null).home;
      if (args.includes('--undo')) await brakeOff({ home, log });
      else await brakeOn({ home, env, log });
      return 0;
    }
    if (args.includes('--apply')) {
      await apply({ env, from: flag('--from'), register: args.includes('--register-hosts'), log });
      return 0;
    }
    const d = detect47(env);
    if (!d.found) {
      log(`${d.why}; nothing to migrate`);
      return 0;
    }
    for (const l of planLines(d, home5(env, d), { from: flag('--from'), register: args.includes('--register-hosts') })) log(l);
    log('nothing was changed; run again with --apply');
    return 0;
  } catch (e) {
    err(`${cmd} refused: ${e instanceof Refused || e instanceof HostRefused ? e.message : e.stack}`);
    return 1;
  }
}

export { STEPS };
