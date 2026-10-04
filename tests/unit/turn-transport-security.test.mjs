import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { captureTurnOutcome, replayTurnQueue, runSteps, resolveTurnDb } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { digest, pendingTurnFiles, readJournal } from '../../plugin/scripts/turn-transport-journal.mjs';
const roots = [];
const TRUSTED_ENV = { RUFLO_BIN: process.execPath };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-security-'))); roots.push(root);
  const projectDir = path.join(root, 'project'); const brainHome = path.join(root, 'brain');
  fs.mkdirSync(path.join(projectDir, '.swarm'), { recursive: true }); const db = path.join(projectDir, '.swarm', 'memory.db'); fs.writeFileSync(db, '');
  let step;
  captureTurnOutcome({ projectDir, brainHome, event: 'Stop', host: 'codex', env: TRUSTED_ENV, ruflo: '/fake',
    payload: { session_id: 'synthetic-security', last_assistant_message: 'Synthetic meaningful assistant conclusion about verified work, with no private user data. '.repeat(3) },
    launch: (steps) => { [step] = steps; return { launched: true }; } });
  const [file] = pendingTurnFiles(db); const record = readJournal(file, db);
  const legacy = { schemaVersion: 1, key: record.key, contentDigest: record.contentDigest, consentScope: record.consentScope, step };
  return { projectDir, brainHome, db, file, record, legacy };
}
function denied(f, record) {
  fs.writeFileSync(f.file, JSON.stringify(record)); const calls = [];
  const result = replayTurnQueue({ ...f, env: TRUSTED_ENV, synchronous: true, runner: (...args) => { calls.push(args); return { status: 0 }; } });
  expect(result.failed).toBe(1); expect(calls).toHaveLength(0); expect(fs.existsSync(f.file)).toBe(true);
}
describe('queued turn data never grants CLI or consent authority', () => {
  it.each(['delete', 'clear', 'distill'])('rejects legacy %s operation without invoking any runner', (operation) => {
    const f = fixture(); f.legacy.step.args[1] = operation; denied(f, f.legacy);
  });
  it('rejects foreign namespace rather than forwarding it', () => {
    const f = fixture(); f.legacy.step.args[f.legacy.step.args.indexOf('-n') + 1] = 'ruvnet-brain'; denied(f, f.legacy);
  });
  it.each(['--path', '--value', '--namespace', '--upsert', '-u', '--unknown'])('rejects incompatible or duplicated %s', (flag) => {
    const f = fixture(); f.legacy.step.args.push(flag, flag === '--path' ? f.db : 'malicious'); denied(f, f.legacy);
  });
  it('rejects a job-selected nested consent home even when its policy permits capture', () => {
    const f = fixture(); f.legacy.step.brainHome = path.join(f.brainHome, 'malicious');
    fs.mkdirSync(path.join(f.legacy.step.brainHome, 'turn-capture'), { recursive: true });
    fs.writeFileSync(path.join(f.legacy.step.brainHome, 'turn-capture', 'policy.json'), JSON.stringify({ schemaVersion: 1, projects: { [f.projectDir]: 'on' } }));
    denied(f, f.legacy);
  });
  it('rejects consent fields, root spoofing and executable recipes in the new data schema', () => {
    for (const mutate of [(r) => { r.binding.brainHome = '/tmp/foreign'; }, (r) => { r.binding.rootIdentity = '0:0'; }, (r) => { r.step = { args: ['memory', 'delete'] }; }]) {
      const f = fixture(); mutate(f.record); denied(f, f.record);
    }
  });
  it('reconstructs only a trusted store with turns namespace and strict insert from valid legacy data', () => {
    const f = fixture(); fs.writeFileSync(f.file, JSON.stringify(f.legacy)); const calls = []; let value;
    const rows = runSteps({ steps: [{ kind: 'journal', journalFile: f.file, db: f.db }] }, { projectDir: f.projectDir, brainHome: f.brainHome, env: TRUSTED_ENV,
      run: (_bin, args) => { calls.push(args); if (args[1] === 'store') value = args[args.indexOf('--value') + 1]; return { status: args[1] === 'retrieve' && !value ? 1 : 0, stdout: value }; } });
    expect(rows[0].verified).toBe(true); const store = calls.find((args) => args[1] === 'store');
    expect(store.slice(0, 2)).toEqual(['memory', 'store']); expect(store).toContain('--no-upsert');
    expect(store[store.indexOf('-n') + 1]).toBe('turns'); expect(store[store.indexOf('--path') + 1]).toBe(f.db);
  });
  it('unknown legacy origin is denied under a descendant path opt-out', () => {
    const f = fixture(); const sub = path.join(f.projectDir, 'private'); fs.mkdirSync(sub);
    fs.mkdirSync(path.join(f.brainHome, 'turn-capture'), { recursive: true });
    fs.writeFileSync(path.join(f.brainHome, 'turn-capture', 'policy.json'), JSON.stringify({ schemaVersion: 1, projects: {}, paths: { [sub]: 'off' } }));
    expect(resolveTurnDb({ ...f, unknownOriginalPath: true }).skipped).toContain('origin cannot be verified');
  });
});
