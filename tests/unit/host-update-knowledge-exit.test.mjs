import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveUpdateSource } from '../../plugin/scripts/automatic-update.mjs';

// POSIX-only (the stub installer is resolved through the global npm layout); listed for linux and macos in
// scripts/release-qualification-contract.mjs.
const roots = [];
function scratch() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-automatic-')); roots.push(root); return root; }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

// Fable review #3 (4.7.21): the knowledge self-heal recorded installer exit 12 (knowledge applied, redundant rollback
// cleanup pending) as FAILED, while the coordinator accepts 0/12, so the next session spoke a false failure.
describe('host-update --knowledge outcome for installer exits', () => {
  const HOST_UPDATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugin/scripts/host-update.mjs');
  const knowledgeRun = (exitCode) => {
    const home = scratch();
    const root = path.join(home, '.npm-global', 'lib', 'node_modules', 'ruvnet-brain');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ruvnet-brain', version: '9.0.0', bin: { 'ruvnet-brain': 'bin/install.mjs' } }));
    fs.writeFileSync(path.join(root, 'bin', 'install.mjs'), `console.log('stub installer'); process.exit(${exitCode});\n`);
    saveUpdateSource('installed', { home }); // offline-independent: the installed source needs no registry probe
    const attempt = path.join(home, 'auto-update.json'); const lock = path.join(home, 'auto-update.lock');
    fs.writeFileSync(lock, '{}');
    const r = spawnSync(process.execPath, [HOST_UPDATE, '--knowledge', attempt, lock], { encoding: 'utf8', timeout: 60_000,
      env: { HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: path.join(home, '.cache/ruvnet-brain'), PATH: path.dirname(process.execPath) } });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
    return JSON.parse(fs.readFileSync(attempt, 'utf8'));
  };
  it.each([[0, 'succeeded'], [12, 'succeeded'], [1, 'failed'], [2, 'failed']])('installer exit %i is recorded %s', (code, outcome) => {
    const record = knowledgeRun(code);
    expect(record).toMatchObject({ outcome, code }); // exit 12 before: 'failed'
    if (outcome === 'succeeded') expect(record.reason).toBe('');
    else expect(record.reason).toBe('stub installer');
  });
});
