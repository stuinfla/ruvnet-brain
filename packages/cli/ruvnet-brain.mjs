#!/usr/bin/env node
// ruvnet-brain install | update | doctor | status | uninstall | clean | config
// The 4.7 spellings (--update, --doctor, --uninstall, --clean, --status) are accepted as the same
// verbs. Run with no source and no terminal (as 4.7 sessions do unattended), update asks nothing.
import fs from 'node:fs';
import path from 'node:path';
import { MIN_NODE } from '../contract/constants.mjs';
import { brainHome, paths, readConfig, readJson, readPointer, writeJsonAtomic } from '../contract/home.mjs';
import { verdict } from '../contract/verdict.mjs';
import { readEvidence } from '../health/status.mjs';
import { renderLine } from '../health/line.mjs';
import { clean, install, printPlan, Refused } from './install.mjs';
import { isUrl } from './source.mjs';
import { uninstall } from './uninstall.mjs';

const USAGE = `usage:
  ruvnet-brain install --from <release folder or https address> [--plan] [--repair]
  ruvnet-brain update [--from <release folder or https address>] [--plan]
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

async function doctor() {
  const ev = readEvidence(home);
  const v = verdict(ev);
  console.log(renderLine(v));
  for (const s of ev.servers.filter((x) => x.alive)) {
    console.log(`server ${s.pid}: app ${s.app}, pack ${s.pack}, heartbeat ${Math.round((ev.now - s.heartbeatAt) / 1000)} s ago`);
    if (s.probe && !s.probe.ok && s.probe.error) console.log(`  self-test: ${s.probe.error}`);
    for (const r of s.probe?.results ?? []) console.log(`  probe ${r.pass ? 'pass' : 'FAIL'}  "${r.question}" -> expected ${r.expect}, got ${r.top ?? 'nothing'}`);
  }
  if (fs.existsSync(path.join(p.state, 'journal.json'))) console.log('an install or update was interrupted; the next install, update or clean puts it right');
  process.exitCode = v.state === 'ok' ? 0 : 1;
}

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
    if (args.includes('--plan')) {
      const { plan, src } = await install({ home, from, planOnly: true });
      printPlan(plan, src);
      return;
    }
    const r = await install({ home, from, log: (m) => console.log(m) });
    console.log(`installed: app ${r.current.app}, pack ${r.current.pack}`);
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
    console.log(`update source ${args[1]}`);
  } else if (args[0] === 'show') {
    console.log(JSON.stringify(readConfig(home), null, 2));
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
    await doctor();
    break;
  case 'status': {
    const cur = readPointer(home);
    console.log(renderLine(verdict(readEvidence(home))));
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
    const r = uninstall(home, { purgePrivate: args.includes('--purge-private') });
    if (r.left.length) process.exitCode = 1;
    break;
  }
  case 'config':
    config();
    break;
  default:
    console.error(USAGE);
    process.exitCode = 2;
}
