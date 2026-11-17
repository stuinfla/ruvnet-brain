#!/usr/bin/env node
// ruvnet-brain install | update | doctor | status | uninstall | clean | config
// The 4.7 spellings (--update, --doctor, --uninstall, --clean, --status) are accepted as the same
// verbs. Run with no source and no terminal (as 4.7 sessions do unattended), update asks nothing.
import path from 'node:path';
import { MIN_NODE } from '../contract/constants.mjs';
import { brainHome, paths, readConfig, readJson, readPointer, writeJsonAtomic } from '../contract/home.mjs';
import { currentLine, renderLine } from '../health/line.mjs';
import { doctor } from '../health/doctor.mjs';
import { afterInstall, hostPlan, HOSTS_FLAG, SHIM_PLAN, unregisterRecorded } from './hosts.mjs';
import { clean, install, printPlan, Refused } from './install.mjs';
import { isUrl } from './source.mjs';
import { redactUrl } from './redact.mjs';
import { uninstall } from './uninstall.mjs';

const USAGE = `usage:
  ruvnet-brain install --from <release folder or https address> [--plan] [--repair] [--register-hosts]
  ruvnet-brain update [--from <release folder or https address>] [--plan] [--register-hosts]
  ruvnet-brain doctor
  ruvnet-brain status
  ruvnet-brain clean
  ruvnet-brain uninstall [--purge-private]
  ruvnet-brain config auto-update on|off
  ruvnet-brain config update-url <https address>|none
  ruvnet-brain config show`;

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) {
  console.error(`RuvNet Brain 5 needs Node ${MIN_NODE.join('.')} or later; this is Node ${process.versions.node}.`);
  process.exit(1);
}

const OLD = { '--update': 'update', '--doctor': 'doctor', '--uninstall': 'uninstall', '--clean': 'clean', '--status': 'status', '--install': 'install' };
const argv = process.argv.slice(2);
const at = argv.findIndex((a) => !a.startsWith('--') || OLD[a]);
const cmd = at < 0 ? undefined : OLD[argv[at]] ?? argv[at];
const args = at < 0 ? argv : argv.filter((_, i) => i !== at);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
};
const home = brainHome();
const p = paths(home);

async function installOrUpdate() {
  let from = flag('--from');
  if (from && !isUrl(from)) from = path.resolve(from);
  // With no --from, install (and install --repair, the fix the health line prints) and update use
  // the configured update address.
  if (!from) from = readConfig(home).updateUrl;
  if (!from) {
    if (cmd === 'update') {
      console.log('update: no update source is configured (ruvnet-brain config update-url <address>); nothing was changed');
      return;
    }
    console.error(`${cmd}: no release to install from: give --from <release folder or https address>, or set one with: ruvnet-brain config update-url <address>`);
    process.exitCode = 2;
    return;
  }
  try {
    const register = args.includes(HOSTS_FLAG);
    if (args.includes('--plan')) {
      const { plan, src } = await install({ home, from, planOnly: true });
      plan.write.push(...SHIM_PLAN.write, ...(register ? ['state/hosts.json'] : []));
      plan.temporary.push(...SHIM_PLAN.temporary);
      printPlan(plan, src, console.log, await hostPlan(register));
      return;
    }
    const r = await install({ home, from, log: (m) => console.log(m) });
    console.log(`installed: app ${r.current.app}, pack ${r.current.pack}`);
    // After the commit: the shim, then (only when asked) the hosts. A refused registration leaves the
    // installed version in place and says so.
    try {
      await afterInstall({ home, register, log: (m) => console.log(m) });
    } catch (e) {
      console.error(`installed, but the shim or host registration was refused: ${e.message}`);
      process.exitCode = 1;
    }
    console.log(renderLine(r.verdict));
  } catch (e) {
    console.error(`${cmd} refused: ${e instanceof Refused ? e.message : e.stack}`);
    process.exitCode = 1;
  }
}

function config() {
  const cur = readJson(p.config, {});
  const set = (k, v) => writeJsonAtomic(p.config, { ...cur, [k]: v });
  if (args[0] === 'auto-update' && (args[1] === 'on' || args[1] === 'off')) {
    set('autoUpdate', args[1] === 'on');
    console.log(`auto-update ${args[1]}`);
  } else if (args[0] === 'update-url' && args[1]) {
    if (args[1] !== 'none' && !isUrl(args[1])) {
      console.error('config refused: the update source must be an http(s) address');
      process.exitCode = 2;
      return;
    }
    set('updateUrl', args[1] === 'none' ? null : args[1]);
    console.log(`update source ${args[1] === 'none' ? 'none' : redactUrl(args[1])}`);
  } else if (args[0] === 'show') {
    const shown = readConfig(home);
    if (shown.updateUrl) shown.updateUrl = redactUrl(shown.updateUrl);
    console.log(JSON.stringify(shown, null, 2));
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}

switch (cmd) {
  case 'install':
  case 'update':
    await installOrUpdate();
    break;
  case 'doctor':
    process.exitCode = doctor(home);
    break;
  case 'status': {
    const cur = readPointer(home);
    console.log(currentLine(home).line);
    console.log(cur ? `app ${cur.app} · pack ${cur.pack} · release ${cur.releaseNumber}` : 'not installed');
    break;
  }
  case 'clean':
    try {
      const r = clean(home);
      console.log(r.did ?? 'no interrupted install or update');
      console.log(r.removed?.length ? `removed:\n${r.removed.map((x) => `  ${x}`).join('\n')}` : 'nothing else to remove');
    } catch (e) {
      console.error(`clean refused: ${e.message}`);
      process.exitCode = 1;
    }
    break;
  case 'uninstall': {
    const log = (m) => console.log(m);
    const r = await uninstall(home, { purgePrivate: args.includes('--purge-private'), out: log, unregister: () => unregisterRecorded(home, log) });
    if (r.left.length) process.exitCode = 1;
    break;
  }
  case 'config':
    config();
    break;
  case 'migrate': case 'rollback-to-4': process.exitCode = await (await import('../migrate/migrate.mjs')).main(cmd, args); break; // wp9
  case 'guard': process.exitCode = await (await import('../guard/command.mjs')).main(home, args); break; // wp10
  default:
    console.error(USAGE);
    process.exitCode = 2;
}
