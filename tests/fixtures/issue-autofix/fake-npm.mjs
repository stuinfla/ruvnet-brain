#!/usr/bin/env node
// Fixture stand-in for `npm`: version lookups read the fake-gh state file; `run version:set` rewrites the fixture's
// three version fields; `pack --dry-run --json` lists the cwd's tracked files with their sizes (for a
// `<name>@<version>` spec, the cwd is the base worktree at origin/main); `audit --json` reports what FAKE_GH_STATE's
// `audit` says (default clean). ci, convergence:write and release:prepush are no-ops. Never touches a network.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const a = process.argv.slice(2);
const st = () => JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
if (a[0] === 'view') { process.stdout.write(`${st().npmLatest}\n`); process.exit(0); }
if (a[0] === 'run' && a[1] === 'version:set') {
  const v = a[a.length - 1];
  for (const f of ['package.json', 'plugin/.claude-plugin/plugin.json', 'package-lock.json']) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.version = v; if (j.packages?.['']) j.packages[''].version = v;
    fs.writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`);
  }
  process.exit(0);
}
if (a[0] === 'pack' && a.includes('--dry-run')) {
  const files = spawnSync('git', ['ls-files'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    .map((p) => ({ path: p, size: fs.statSync(p).size, mode: 420 }));
  process.stdout.write(JSON.stringify([{ name: 'autofix-fixture', files }]));
  process.exit(0);
}
if (a[0] === 'audit') {
  // auditCandidateOnly: the advisory exists only in the release candidate, not in the origin/main base worktree.
  const base = process.cwd().endsWith('-gatebase');
  const audit = (st().auditCandidateOnly && base ? null : st().audit) || { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };
  process.stdout.write(JSON.stringify(audit));
  process.exit(0);
}
if (a[0] === 'ci' || (a[0] === 'run' && ['convergence:write', 'release:prepush'].includes(a[1]))) process.exit(0);
process.stderr.write(`fake-npm: unsupported: npm ${a.join(' ')}\n`);
process.exit(99);
