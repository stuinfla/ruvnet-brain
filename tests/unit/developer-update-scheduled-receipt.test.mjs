import { it as test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, runDeveloperUpdate, developerUpdatePaths } from '../../plugin/scripts/developer-update.mjs';
import { installNightlyRunner, developerRunHealth } from '../../plugin/scripts/nightly-scheduler.mjs';
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-suite-receipt-')));
  const paths = developerUpdatePaths({ home }), prefix = path.join(home, '.npm-global'), root = path.join(prefix, 'lib/node_modules'), bin = path.join(prefix, 'bin');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'npm'), 'fixture', { mode: 0o755 });
  const record = installNightlyRunner({ brainHome: paths.brainHome, source: path.resolve('bin/nightly-refresh.mjs'), nodePath: process.execPath });
  const env = { PATH: bin, RUVNET_NIGHTLY: '1', RUVNET_NIGHTLY_IDENTITY: record.identity };
  const runner = (_command, args) => { if (args[0] === 'prefix') return prefix; if (args[0] === 'root') return root; throw Error('unexpected fixture command'); };
  const health = (extra = {}) => developerRunHealth({ brainHome: paths.brainHome, registration: record, ...extra });
  const run = (options = {}) => runDeveloperUpdate({ home, env, runner, mode: 'apply', ...options });
  return { home, paths, record, env, runner, health, run };
}
const read = file => JSON.parse(fs.readFileSync(file));
test('scheduled apply survives later checks; Activity keeps the latest check', async () => {
  const f = fixture();
  try {
    const applied = await f.run(); assert.equal(f.health().state, 'ok');
    await f.run({ mode: 'check' });
    assert.equal(read(f.paths.receipt).mode, 'check');
    assert.equal(read(f.paths.scheduledReceipt).runId, applied.runId);
    assert.equal(f.health().state, 'ok');
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
test('a failed scheduled attempt remains failed after a later check', async () => {
  const f = fixture();
  try {
    await f.run();
    await assert.rejects(f.run({ runner: () => { throw Error('provider fixture failed'); } }));
    const failed = read(f.paths.scheduledReceipt); assert.equal(failed.state, 'failed');
    await f.run({ mode: 'check' }); assert.equal(f.health().state, 'failed');
    assert.equal(f.health().receipt.runId, failed.runId);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
test('manual apply and checks never create scheduled evidence', async () => {
  const f = fixture();
  try {
    await f.run({ env: { PATH: f.env.PATH } }); assert.equal(f.health().state, 'never-ran');
    await f.run({ mode: 'check' }); assert.equal(f.health().state, 'never-ran');
    await assert.rejects(f.run({ mode: 'check', runner: () => { throw Error('failed check fixture'); } }));
    assert.equal(f.health().state, 'never-ran');
    assert.equal(fs.existsSync(f.paths.scheduledReceipt), false);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
test('running scheduled receipts require the exact live lock owner; dead owners fail', async () => {
  const f = fixture(); let during;
  try {
    await f.run({ runner: (command, args) => { during = f.health(); assert.equal(during.state, 'running'); return f.runner(command, args); } });
    assert.equal(during.receipt.state, 'running');
    assert.equal(during.receipt.ownerToken.length >= 16, true);
    atomic(f.paths.scheduledReceipt, during.receipt); atomic(f.paths.receipt, during.receipt); assert.equal(f.health().state, 'failed');
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
test('stale, future, changed source, registration and unreadable/refused evidence fail closed', async () => {
  const f = fixture();
  try {
    const base = await f.run(); await f.run({ mode: 'check' });
    assert.equal(f.health({ now: Date.parse(base.finishedAt) + 31 * 3_600_000 }).state, 'stale');
    const set = change => { atomic(f.paths.scheduledReceipt, { ...base, ...change }); return f.health(); };
    assert.equal(set({ finishedAt: new Date(Date.now() + 3600000).toISOString() }).state, 'failed');
    assert.equal(set({ sourceSnapshot: {} }).state, 'failed');
    assert.equal(set({ sourceSnapshot: { ...base.sourceSnapshot, 'unregistered.mjs': '0'.repeat(64) } }).state, 'failed');
    assert.equal(set({ state: 'refused', ok: false }).state, 'failed');
    atomic(f.paths.scheduledReceipt, base);
    assert.equal(f.health({ registration: { ...f.record, identity: 'changed' } }).state, 'never-ran');
    fs.writeFileSync(f.paths.scheduledReceipt, '{'); assert.equal(f.health().state, 'failed');
    fs.rmSync(f.paths.scheduledReceipt); fs.symlinkSync(f.paths.receipt, f.paths.scheduledReceipt); assert.equal(f.health().state, 'failed');
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
test('legacy scheduled apply migrates under lock before a check overwrites Activity', async () => {
  const f = fixture();
  try {
    const base = await f.run(); fs.rmSync(f.paths.scheduledReceipt);
    delete base.scheduled; atomic(f.paths.receipt, base);
    assert.equal(f.health().state, 'ok'); await f.run({ mode: 'check' });
    assert.equal(read(f.paths.scheduledReceipt).runId, base.runId);
    assert.equal(read(f.paths.receipt).mode, 'check'); assert.equal(f.health().state, 'ok');
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
test('failed retained writes cannot expose old green evidence or erase newer failed Activity', async () => {
  const f = fixture(); let spy;
  try {
    await f.run(); await new Promise(resolve => setTimeout(resolve, 2));
    const rename = fs.renameSync;
    spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === f.paths.scheduledReceipt) { const error = Error('fixture receipt persistence denied'); error.code = 'EACCES'; throw error; }
      return rename(from, to);
    });
    await assert.rejects(f.run()); assert.equal(read(f.paths.receipt).state, 'failed'); assert.equal(f.health().state, 'failed');
    const latestRun = read(f.paths.receipt).runId;
    await assert.rejects(f.run({ mode: 'check' }));
    assert.equal(read(f.paths.receipt).runId, latestRun); assert.equal(f.health().state, 'failed');
    spy.mockRestore(); spy = null;
    await f.run({ mode: 'check' }); assert.equal(read(f.paths.receipt).mode, 'check'); assert.equal(f.health().state, 'failed');
  } finally { spy?.mockRestore(); fs.rmSync(f.home, { recursive: true, force: true }); }
});
test('invalid newer scheduled timestamp cannot be erased by a later check', async () => {
  const f = fixture();
  try {
    const base = await f.run();
    atomic(f.paths.receipt, { ...base, runId: 'invalid-newer-attempt', startedAt: 'invalid', finishedAt: 'invalid', state: 'failed', ok: false });
    assert.equal(f.health().state, 'failed');
    await f.run({ mode: 'check' });
    assert.equal(read(f.paths.scheduledReceipt).runId, 'invalid-newer-attempt');
    assert.equal(f.health().state, 'failed');
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
test('a terminal retention failure records failed latest evidence rather than a green completed attempt', async () => {
  const f = fixture(); let spy;
  try {
    await f.run(); await new Promise(resolve => setTimeout(resolve, 2));
    const rename = fs.renameSync;
    spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === f.paths.scheduledReceipt && read(from).state === 'completed') throw Error('fixture terminal persistence failure');
      return rename(from, to);
    });
    await assert.rejects(f.run());
    assert.equal(read(f.paths.receipt).state, 'failed'); assert.equal(f.health().state, 'failed');
    spy.mockRestore(); spy = null;
    await f.run({ mode: 'check' }); assert.equal(f.health().state, 'failed');
  } finally { spy?.mockRestore(); fs.rmSync(f.home, { recursive: true, force: true }); }
});
