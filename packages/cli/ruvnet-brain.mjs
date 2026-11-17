#!/usr/bin/env node
// ruvnet-brain install | update | doctor | status | uninstall | config  (skeleton slice)
import fs from 'node:fs';
import path from 'node:path';
import { MIN_NODE } from '../contract/constants.mjs';
import { brainHome, paths, readJson, readPointer, writeJsonAtomic } from '../contract/home.mjs';
import { verdict } from '../contract/verdict.mjs';
import { readEvidence } from '../health/status.mjs';
import { renderLine } from '../health/line.mjs';
import { install, Refused } from './install.mjs';

const USAGE = `usage:
  ruvnet-brain install --from <release folder>
  ruvnet-brain update --from <release folder>
  ruvnet-brain doctor
  ruvnet-brain status
  ruvnet-brain uninstall [--purge-private]
  ruvnet-brain config auto-update on|off`;

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) {
  console.error(`RuvNet Brain 5 needs Node ${MIN_NODE.join('.')} or later; this is Node ${process.versions.node}.`);
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
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
  process.exitCode = v.state === 'ok' ? 0 : 1;
}

function uninstall(purge) {
  const plan = [p.current, p.app, p.packs, p.state, ...(purge ? [p.private] : [])].filter((x) => fs.existsSync(x));
  console.log(plan.length ? `will remove:\n${plan.map((x) => `  ${x}`).join('\n')}` : 'nothing to remove');
  for (const x of plan) fs.rmSync(x, { recursive: true, force: true });
  const left = fs.existsSync(home) ? fs.readdirSync(home).filter((n) => n !== 'private') : [];
  if (fs.existsSync(home) && !fs.readdirSync(home).length) fs.rmdirSync(home);
  if (left.length) {
    console.log(`still present after removal:\n${left.map((n) => `  ${path.join(home, n)}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`checked again: nothing listed remains.${fs.existsSync(p.private) ? ` Kept ${p.private} (use --purge-private to remove it).` : ''}`);
  }
}

switch (cmd) {
  case 'install':
  case 'update': {
    const from = flag('--from');
    if (!from) {
      console.error(USAGE);
      process.exit(2);
    }
    try {
      const r = await install({ home, from: path.resolve(from) });
      console.log(`installed: app ${r.current.app}, pack ${r.current.pack}`);
      console.log(renderLine(r.verdict));
    } catch (e) {
      console.error(`${cmd} refused: ${e instanceof Refused ? e.message : e.stack}`);
      process.exitCode = 1;
    }
    break;
  }
  case 'doctor':
    await doctor();
    break;
  case 'status': {
    const cur = readPointer(home);
    console.log(renderLine(verdict(readEvidence(home))));
    console.log(cur ? `app ${cur.app} · pack ${cur.pack} · release ${cur.releaseNumber}` : 'not installed');
    break;
  }
  case 'uninstall':
    uninstall(args.includes('--purge-private'));
    break;
  case 'config':
    if (args[0] === 'auto-update' && (args[1] === 'on' || args[1] === 'off')) {
      writeJsonAtomic(p.config, { ...readJson(p.config, {}), autoUpdate: args[1] === 'on' });
      console.log(`auto-update ${args[1]}`);
      break;
    }
  // falls through
  default:
    console.error(USAGE);
    process.exitCode = 2;
}
