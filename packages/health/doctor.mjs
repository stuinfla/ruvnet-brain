// `ruvnet-brain doctor`: line 1 is the prompt hook's line, from the same assess() call on the same
// evidence; then the evidence behind it. Exit code 0 only for ok. It runs no search of its own and
// starts no server (a second definition of healthy is defect C9).
// The CLI wires it as: case 'doctor': process.exitCode = (await import('../health/doctor.mjs')).doctor(home);
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson } from '../contract/home.mjs';
import { readEvidence } from './status.mjs';
import { currentLine } from './line.mjs';

const DAY = 86_400_000;
const when = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/** How old the installed knowledge is and why, from evidence this machine can see. Never a failure. */
export function knowledgeAge(home, ev) {
  const pack = ev.pointer && readJson(path.join(paths(home).packs, ev.pointer.pack, 'PACK.json'), null);
  const date = pack?.knowledgeDate;
  if (!date) return null;
  const days = Math.max(0, Math.floor((ev.now - Date.parse(`${date}T00:00:00Z`)) / DAY));
  const installed = ev.pointer.releaseNumber;
  const c = ev.updateCheck;
  const failed = ev.update && ev.update.result !== 'installed' ? ev.update : null;
  let cause;
  if (!ev.updateUrl) cause = 'no update source is configured, so this machine does not look for newer knowledge (set one: ruvnet-brain config update-url <address>)';
  else if (c?.available && failed) cause = `release ${c.offered} was offered and ${failed.result === 'refused' ? 'failed its checks before the switch' : 'was rolled back after the switch'} (${failed.reason}); the installed knowledge keeps answering`;
  else if (c?.available && ev.autoUpdate === false) cause = `release ${c.offered} is available and automatic updates are off (run: ruvnet-brain update)`;
  else if (c?.available) cause = `release ${c.offered} is available; the running session applies it`;
  else if (ev.autoUpdate === false) cause = 'automatic updates are off, so this machine does not look for newer knowledge (run: ruvnet-brain update)';
  else if (!c?.checked) cause = 'no update check has run yet; a running session checks every few hours';
  else cause = `the newest published release (${c.offered}) is installed: no newer knowledge has been published (checked ${when(c.at)})`;
  return { date, days, installed, cause, text: `knowledge: ${date}, ${days} day${days === 1 ? '' : 's'} old · ${cause}` };
}

function lastUpdate(u) {
  if (!u) return null;
  const to = u.to ? `app ${u.to.app}, pack ${u.to.pack}` : 'a release';
  if (u.result === 'installed') return `last update: installed ${to} (${when(u.at)})`;
  if (u.result === 'refused') return `last update: refused ${to} before the switch (${when(u.at)}): ${u.reason}; nothing was changed`;
  return `last update: ${to} was rolled back after the switch (${when(u.at)}): ${u.reason}; the previous version is answering`;
}

export function doctor(home, { out = console.log, now = Date.now() } = {}) {
  const { verdict: v, line } = currentLine(home, { now });
  out(line);
  let ev;
  try {
    ev = readEvidence(home, { now });
  } catch {
    return 1;
  }
  const age = knowledgeAge(home, ev);
  if (age) out(age.text);
  const lu = lastUpdate(ev.update);
  if (lu) out(lu);
  for (const s of ev.servers.filter((x) => x.alive)) {
    const hb = s.heartbeatAt ? `${Math.round((ev.now - s.heartbeatAt) / 1000)} s ago` : 'never';
    const pr = s.probe ? `self-test ${s.probe.ok ? 'passed' : 'FAILED'} ${when(s.probe.at)}` : 'self-test not finished';
    const ls = s.lastSearch ? `, last search ${s.lastSearch.ok ? 'normal' : `safe mode (${s.lastSearch.reason})`}` : '';
    out(`server ${s.pid}: app ${s.app}, pack ${s.pack}, heartbeat ${hb}, ${pr}${ls}`);
    if (s.probe && !s.probe.ok && s.probe.error) out(`  self-test: ${s.probe.error}`);
    for (const l of (s.lanes || []).filter((x) => !x.available)) out(`  lane ${l.name} unavailable${l.reason ? `: ${l.reason}` : ''}`);
    for (const r of s.probe?.results ?? []) out(`  probe ${r.pass ? 'pass' : 'FAIL'}  "${r.question}" -> expected ${r.expect}, got ${r.top ?? 'nothing'}`);
  }
  if (fs.existsSync(path.join(paths(home).state, 'journal.json'))) out('an install or update was interrupted; the next install, update or clean puts it right');
  return v.state === 'ok' ? 0 : 1;
}
