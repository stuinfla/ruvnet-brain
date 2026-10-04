// Real detached hook/CLI boundary in an isolated home; tokens are generated synthetic fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveRuflo } from '../../plugin/scripts/ruflo-bin.mjs';
import { turnCapturePolicyFile } from '../../plugin/scripts/turn-outcome-capture.mjs';
export const ROOT = path.resolve(import.meta.dirname, '../..');
export const outcome = 'Verified the synthetic repair: the process wrote a unique conclusion to the canonical project store and its readback matches the exact expected content. The isolated fixture avoids any owner account or private transcript. '.repeat(2);
export function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-process-')));
  const project = path.join(root, 'repo'); const home = path.join(root, 'home');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain'); const argvLog = path.join(home, 'argv.jsonl');
  fs.mkdirSync(project); fs.mkdirSync(home);
  const realRuflo = resolveRuflo(); assert.ok(realRuflo, 'global Ruflo is required for the real-process probe');
  const stub = path.join(root, 'ruflo');
  fs.writeFileSync(stub, `#!${process.execPath}\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';
fs.appendFileSync(process.env.PROBE_ARGV_LOG,JSON.stringify(process.argv.slice(2))+'\\n');
if(process.env.PROBE_FAIL==='1'){process.stderr.write('synthetic database refused write\\nsecond diagnostic\\n');process.exit(1)}
const r=spawnSync(process.env.PROBE_REAL_RUFLO,process.argv.slice(2),{env:process.env,encoding:'utf8'});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: brainHome, RUFLO_BIN: stub,
    RUFLO_DAEMON_AUTOSTART: '0', PROBE_ARGV_LOG: argvLog, PROBE_REAL_RUFLO: realRuflo,
    CLAUDE_FLOW_ENCRYPT_AT_REST: '0', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig') };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const command = (binary, args, options = {}) => {
    const r = spawnSync(binary, args, { cwd: project, env, encoding: 'utf8', timeout: 30_000, ...options });
    assert.equal(r.status, 0, `${binary} ${args[0]} failed: ${r.stderr}\n${r.stdout}`); return r;
  };
  const initialize = () => {
    fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
    command(stub, ['memory', 'store', '--key', 'probe-seed', '--value', 'synthetic seed', '--path', path.join(project, '.swarm', 'memory.db')], { cwd: path.join(project, '.swarm') });
  };
  const policy = (projects, paths = {}) => {
    const file = turnCapturePolicyFile(brainHome); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects, paths }));
  };
  const stop = ({ cwd = project, message = outcome, session = `probe-${Date.now()}`, extra = {}, fail = false } = {}) => {
    const source = `import fs from 'node:fs';import {captureTurnOutcome} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'plugin/scripts/turn-outcome-capture.mjs')).href)};
process.stdout.write(JSON.stringify(captureTurnOutcome({projectDir:process.cwd(),event:'Stop',host:'codex',payload:JSON.parse(fs.readFileSync(0,'utf8'))})));`;
    return JSON.parse(command(process.execPath, ['--input-type=module', '-e', source], { cwd,
      input: JSON.stringify({ session_id: session, last_assistant_message: message, ...extra }), env: { ...env, PROBE_FAIL: fail ? '1' : '0' } }).stdout);
  };
  const receipts = () => { try { return fs.readFileSync(path.join(brainHome, 'turn-capture', 'receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  const wait = async (key) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const row = receipts().find((r) => r.key === key); if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('detached worker produced no receipt');
  };
  const retrieve = (key) => command(stub, ['memory', 'retrieve', '--key', key, '--namespace', 'turns', '--value-only', '--path', path.join(project, '.swarm', 'memory.db')], { cwd: path.join(project, '.swarm') }).stdout.trim();
  return { root, project, home, brainHome, argvLog, env, command, initialize, policy, stop, receipts, wait, retrieve,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
export function fileBytes(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name); return e.isDirectory() ? fileBytes(file) : e.isFile() ? [fs.readFileSync(file)] : [];
  });
}
