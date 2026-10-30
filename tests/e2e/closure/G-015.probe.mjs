// G-015 / G-053 (issue #391, ADR-0070, ADR-0051) — real processes, no mocks of the thing under test:
//  1. the INSTALLED hook shim is run with an unknown hook id and the INSTALLED MCP server answers a real stdio
//     initialize + tools/list (scripts/codex-boot-surface-proof.mjs, in its own node process);
//  2. one changed byte in the installed server keeps the boot surface unproven, with the file named;
//  3. a real SessionStart over a host-sync-only FAILED receipt reads knowledge CURRENT and names --host-sync-only.
// Not covered, said plainly: a live Codex relaunch, and windows that are already open (both reported unproven).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../../helpers/turn-capture-process.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g015-'));
try {
  const copy = (name) => {
    const dest = path.join(tmp, name);
    fs.cpSync(path.join(ROOT, 'plugin'), dest, { recursive: true, filter: (src) => !src.startsWith(path.join(ROOT, 'plugin', 'test')) });
    return dest;
  };
  const installed = copy('installed'); const released = copy('released');
  const moduleUrl = pathToFileURL(path.join(ROOT, 'scripts/codex-boot-surface-proof.mjs')).href;
  const proveInChild = () => {
    const script = `import {proveCodexBootSurface} from ${JSON.stringify(moduleUrl)};
      const r = await proveCodexBootSurface({changedPaths:['scripts/hook-shim.mjs','skills/','mcp/server.mjs'],
        installedPluginRoot:${JSON.stringify(installed)},releasedPluginRoot:${JSON.stringify(released)},
        declarations:{ok:true,state:'fresh-declarations-ready'},timeoutMs:20000});
      process.stdout.write(JSON.stringify(r));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 90_000 });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  const ready = proveInChild();
  assert.equal(ready.state, 'boot-surface-ready', JSON.stringify(ready.unproven));
  assert.equal(ready.existingWindows, 'unproven');
  assert.equal(ready.hostRelaunch, 'not-observed');
  assert.equal(ready.shim.ok, true);
  assert.equal(ready.mcp.ok, true);
  assert.equal(ready.mcp.leaseLeftBehind, false);

  fs.appendFileSync(path.join(installed, 'mcp', 'server.mjs'), '\n// one changed byte\n');
  const drift = proveInChild();
  assert.equal(drift.state, 'boot-surface-unproven');
  assert.deepEqual(drift.unproven.map((u) => u.path), ['mcp/server.mjs']);
  assert.match(drift.reason, /mcp\/server\.mjs.*not byte-identical/);

  // SessionStart over a receipt whose ONLY failed phase is host-convergence (the recovered-host case).
  const home = path.join(tmp, 'home'); const brain = path.join(home, '.cache', 'ruvnet-brain'); const kb = path.join(brain, 'kb');
  fs.mkdirSync(path.join(kb, 'node_modules', '@xenova', 'transformers'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'), '{}');
  fs.writeFileSync(path.join(kb, 'store.rvf'), 'x');
  fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ builtUtc: new Date(Date.now() - 3 * 3_600_000).toISOString() }));
  for (const f of ['.console-offered', '.auto-update-pref', '.router-profile-nudged']) fs.writeFileSync(path.join(brain, f), 'no\n');
  const corpus = ['source-enumeration', 'ingestion', 'local-overlay-restoration', 'generation-ledger-reconciliation', 'coverage-generation', 'bundle-assembly', 'update'];
  const at = new Date(Date.now() - 3_600_000).toISOString();
  fs.mkdirSync(path.join(brain, 'refresh-runs'), { recursive: true });
  fs.writeFileSync(path.join(brain, 'refresh-runs', '1.json'), JSON.stringify({ schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', action: 'update', runId: 'r1',
    status: 'FAILED', terminalVerdict: 'failed', startedAt: at, finishedAt: at, requiredPhaseOrder: [...corpus, 'host-convergence', 'cleanup'],
    phases: [...corpus.map((phase) => ({ phase, status: 'PASS', evidence: {} })),
      { phase: 'host-convergence', status: 'FAIL', evidence: { state: 'host-restart-required', error: 'host convergence is host-restart-required: boot-level declarations changed: scripts/hook-shim.mjs, skills/' } }] }));
  const core = pathToFileURL(path.join(ROOT, 'plugin/scripts/session-start-core.mjs')).href;
  const start = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {runSessionStart} from ${JSON.stringify(core)}; await runSessionStart({runHeartbeat:false,restoreContinuity:async()=>({context:''})});`],
  { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home, RUVNET_BRAIN_METER: '0', RUVNET_BRAIN_HOME: brain } });
  assert.match(start.stdout, /CURRENT, HOST RESTART PENDING/);
  assert.match(start.stdout, /npx ruvnet-brain@latest --update --host-sync-only/);
  assert.doesNotMatch(start.stdout, /UPDATE FAILING/);
  assert.doesNotMatch(start.stdout, /--update(?! --host-sync-only)/);
  console.log(JSON.stringify({ gap: 'G-015', also: 'G-053', evidenceClass: 'EXECUTED', bootSurfaceReady: true, shimRolesListed: ready.shim.rolesListed,
    mcpToolsListed: ready.mcp.tools, initializeStartsWarmWorker: ready.mcp.initializeStartsWarmWorker, leaseLeftBehind: ready.mcp.leaseLeftBehind,
    oneByteDriftRefused: drift.unproven[0].reason, sessionStartFix: 'npx ruvnet-brain@latest --update --host-sync-only', existingWindows: 'unproven', hostRelaunch: 'not-observed' }));
} finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
