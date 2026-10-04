import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, outcome } from '../../helpers/turn-capture-process.mjs';
const f = fixture();
try {
  const absent = f.stop();
  assert.match(absent.skipped, /opt-in required/);
  assert.equal(fs.existsSync(path.join(f.project, '.swarm')), false);
  f.policy({ [f.project]: 'on' });
  const adopted = f.stop({ message: `${outcome} Explicitly opted in.` });
  assert.equal((await f.wait(adopted.key)).verified, true);
  f.command('git', ['init']);
  f.command('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '--allow-empty', '-m', 'synthetic']);
  const wt = path.join(f.root, 'linked');
  f.command('git', ['worktree', 'add', '-b', 'probe-linked', wt]);
  const child = path.join(wt, 'child'); fs.mkdirSync(child);
  const report = f.stop({ cwd: child, message: `${outcome} Worktree child result.` });
  assert.equal(report.db, path.join(f.project, '.swarm', 'memory.db'));
  assert.equal((await f.wait(report.key)).verified, true);
  assert.ok(f.retrieve(report.key).includes('project=repo'));
  assert.equal(fs.existsSync(path.join(wt, '.swarm')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.claude', 'global-memory')), false);
  console.log(JSON.stringify({ gap: 'G-002', evidenceClass: 'EXECUTED', canonicalWorktreeChild: true, absentStoreRequiresConsent: true, globalStoreCreated: false }));
} finally { f.cleanup(); }
