import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sessionStartProofRecorder } from '../../plugin/scripts/session-start-proof.mjs';
import { runSessionStart } from '../../plugin/scripts/session-start-core.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-stage-proof-')));
  roots.push(root); fs.chmodSync(root, 0o700);
  const file = path.join(root, 'proof.json'); const nonce = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, state: 'pending', nonce }), { mode: 0o600 });
  const sourcePath = path.join(root, 'source.mjs'); fs.writeFileSync(sourcePath, '// actual body');
  const env = { RUVNET_BRAIN_HOST_PROOF_PATH: file, RUVNET_BRAIN_HOST_PROOF_NONCE: nonce };
  return { root, file, nonce, sourcePath, env, cwd: root, version: '4.5.7' };
}
const milestones = { stages: [{ name: 'banner', ms: 2, skipped: false }], restore: { name: 'restore', ms: 1, failed: false }, bodyFailed: false, bannerFallback: false };
describe('optional SessionStart stage evidence', () => {
  it('is inactive by default and does not create a file', () => {
    const f = fixture(); fs.unlinkSync(f.file);
    expect(sessionStartProofRecorder({ ...f, env: {} })(milestones)).toBe(false);
    expect(fs.existsSync(f.file)).toBe(false);
  });
  it('records execution milestones without turning them into a health verdict', () => {
    const f = fixture(); const accepted = sessionStartProofRecorder(f)(milestones);
    expect(accepted).toBe(process.platform !== 'win32');
    if (!accepted) { expect(JSON.parse(fs.readFileSync(f.file)).state).toBe('pending'); return; }
    const receipt = JSON.parse(fs.readFileSync(f.file));
    expect(receipt).toMatchObject({ state: 'body-executed', nonce: f.nonce, pid: process.pid,
      sourcePath: f.sourcePath, cwd: f.cwd, version: '4.5.7', health: 'unknown', ...milestones });
    expect(receipt.sourceSha256).toBe(crypto.createHash('sha256').update('// actual body').digest('hex'));
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
  });
  it.each(['wrong nonce', 'arbitrary JSON', 'missing file', 'public directory', 'public file', 'changed source', 'replaced file'])('refuses %s without overwriting the target', (kind) => {
    const f = fixture();
    if (kind === 'wrong nonce') f.env.RUVNET_BRAIN_HOST_PROOF_NONCE = 'a'.repeat(64);
    if (kind === 'arbitrary JSON') fs.writeFileSync(f.file, '{"private":"keep"}');
    if (kind === 'missing file') fs.unlinkSync(f.file);
    if (kind === 'public directory') fs.chmodSync(f.root, 0o755);
    if (kind === 'public file') fs.chmodSync(f.file, 0o644);
    const record = sessionStartProofRecorder(f);
    if (kind === 'changed source') fs.writeFileSync(f.sourcePath, '// changed');
    if (kind === 'replaced file') { fs.unlinkSync(f.file); fs.writeFileSync(f.file, '{"private":"keep"}', { mode: 0o600 }); }
    const before = fs.existsSync(f.file) ? fs.readFileSync(f.file) : undefined;
    expect(record(milestones)).toBe(false);
    if (before) expect(fs.readFileSync(f.file)).toEqual(before);
    else expect(fs.existsSync(f.file)).toBe(false);
  });
  it('refuses a symlink to another private file', () => {
    const f = fixture(); const target = path.join(f.root, 'other');
    fs.renameSync(f.file, target); fs.symlinkSync(target, f.file);
    const before = fs.readFileSync(target);
    expect(sessionStartProofRecorder(f)(milestones)).toBe(false);
    expect(fs.readFileSync(target)).toEqual(before);
  });
  it('records restore failure through the real startup body, retaining fail-open output', async () => {
    const f = fixture(); let output = '';
    const result = await runSessionStart({ env: { HOME: f.root, RUVNET_BRAIN_HOME: path.join(f.root, 'brain'),
      RUVNET_BRAIN_OFF: '1', RUVNET_BRAIN_METER: '0', ...f.env }, cwd: f.root,
      stdout: { write: (value) => { output += value; } }, stderr: { write() {} }, runHeartbeat: false,
      restoreContinuity: async () => { throw new Error('private failure message'); } });
    expect(result.ok).toBe(true); expect(output).toContain('PROJECT CONTINUITY UNKNOWN');
    const receipt = JSON.parse(fs.readFileSync(f.file));
    if (process.platform === 'win32') { expect(receipt.state).toBe('pending'); return; }
    expect(receipt.restore.failed).toBe(true); expect(receipt.stages.some((stage) => stage.name === 'banner')).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain('private failure message');
  });
});
