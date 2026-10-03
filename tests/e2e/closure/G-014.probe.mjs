import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fixture, ROOT } from '../../helpers/turn-capture-process.mjs';
import { completeBrain } from '../../helpers/doctor-brain-fixture.mjs';
const f = fixture(); const brain = completeBrain({ modelsReady: true });
try {
  f.initialize();
  const report = f.stop({ fail: true, session: 'same-failed-turn' });
  const receipt = await f.wait(report.key);
  assert.equal(receipt.status, 1);
  assert.equal(receipt.verified, false);
  assert.equal(receipt.error, 'synthetic database refused write');
  const module = pathToFileURL(path.join(ROOT, 'plugin/scripts/session-start-core.mjs')).href;
  const start = f.command(process.execPath, ['--input-type=module', '-e', `import {runSessionStart} from ${JSON.stringify(module)}; await runSessionStart({runHeartbeat:false,restoreContinuity:async()=>({context:''})});`]);
  assert.match(start.stdout, /turn recording failing 1\/1.*synthetic database refused write/);
  const doctor = brain.doctor(['--json'], { cwd: f.project, extraEnv: { RUVNET_BRAIN_HOME: f.brainHome } });
  assert.match(doctor.text, /turn recording failing 1\/1/);
  assert.ok(doctor.text.includes('synthetic database refused write'));
  const retry = f.stop({ session: 'same-failed-turn' });
  assert.notEqual(retry.key, report.key);
  assert.equal((await f.wait(retry.key)).verified, true);
  console.log(JSON.stringify({ retriedIdenticalFailedTurn: true, gap: 'G-014', evidenceClass: 'EXECUTED', failureReceipt: receipt.error, sessionStartReported: true, doctorReported: true }));
} finally { f.cleanup(); brain.cleanup(); }
