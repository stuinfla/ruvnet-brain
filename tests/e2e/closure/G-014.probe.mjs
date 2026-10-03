#!/usr/bin/env node
// G-014 (FALSE-GREEN, #370) — capture failures are truthful. Real hook-shim Stop in an isolated HOME with a
// ruflo whose `memory import` FAILS (every other call goes to the real ruflo):
//   • the worker's receipt carries ruflo's first stderr line and ok:false;
//   • the real `install.mjs --doctor --json` run from that project shows "turn recording failing N/M";
//   • the real SessionStart hook (hook-shim session-start) shows "turn recording failing N/M".
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OUTCOME, ROOT, adoptedRepo, fireStop, plant, realRuflo, report, sandbox } from './turn-capture-probe-lib.mjs';

const FIRST = '[ERROR] simulated failure: database disk image is malformed';

await report('G-014', async (check) => {
  const ruflo = realRuflo();
  if (!ruflo) return { unknown: 'ruflo is not installed: the real write path cannot be exercised' };
  const box = sandbox('g014-');
  try {
    const repo = adoptedRepo(box, ruflo, 'failing-repo');
    const stub = path.join(box.root, 'ruflo-failing-import');
    fs.writeFileSync(stub, `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === 'memory' && a[1] === 'import') { console.error(${JSON.stringify(FIRST)}); console.error('a second line'); process.exit(1); }
const r = require('node:child_process').spawnSync(${JSON.stringify(ruflo)}, a, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
    const run = await fireStop(box, { cwd: repo, ruflo: stub, text: `${OUTCOME} ${plant().phrase}` });
    const store = run.receipts.find((r) => r.kind === 'store');
    check('the receipt is a failure carrying the first stderr line', store?.ok === false && store?.status === 1 && store?.error === FIRST, store);
    const ok = await fireStop(box, { cwd: repo, ruflo, text: `${OUTCOME} ${plant().phrase}` });
    check('a following good write is verified', ok.receipts.find((r) => r.kind === 'store')?.ok === true, ok.receipts);

    // doctor, run from the project the way a user runs it (hermetic: no brain installed beyond a stub KB).
    const kb = path.join(box.brainHome, 'kb');
    fs.mkdirSync(kb, { recursive: true });
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '// probe fixture: never executed\n');
    fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ builtUtc: new Date().toISOString(), releaseTag: `v${version}` }));
    fs.writeFileSync(path.join(kb, 'COVERAGE.json'), '{"rows":[]}');
    const doctor = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), '--doctor', '--json'], { cwd: repo, encoding: 'utf8', timeout: 180_000,
      env: { ...box.gitEnv, RUVNET_BRAIN_TEST: '1', RUVNET_BRAIN_TEST_NPM_LATEST: version, npm_config_cache: path.join(box.home, '.npm'), RUVNET_NO_TELEMETRY: '1', RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_CONFIG_DIR: path.join(box.home, '.claude'), CODEX_HOME: path.join(box.home, '.codex') } });
    let verdict = null;
    try { verdict = JSON.parse(doctor.stdout); } catch { /* reported below */ }
    const line = verdict?.lines?.find((l) => l.id === 'turn-recording');
    check('doctor --json shows "turn recording failing 1/2" as an advisory line', line?.state === 'warn' && /^turn recording failing 1\/2 /.test(line?.detail || ''),
      line || { status: doctor.status, stdout: String(doctor.stdout).slice(0, 300), stderr: String(doctor.stderr).slice(-300) });

    const start = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'hook-shim.mjs'), 'session-start'], { cwd: repo, encoding: 'utf8', timeout: 60_000,
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'g014-start', cwd: repo, source: 'startup' }),
      env: { ...box.gitEnv, CLAUDE_PROJECT_DIR: repo, RUFLO_BIN: ruflo, RUFLO_DAEMON_AUTOSTART: '0', RUVNET_HOOK_HOST: 'claude' } });
    check('SessionStart shows "turn recording failing 1/2"', /turn recording failing 1\/2 /.test(String(start.stdout)),
      { status: start.status, tail: String(start.stdout).slice(-400) });
    return null;
  } finally { box.cleanup(); }
});
