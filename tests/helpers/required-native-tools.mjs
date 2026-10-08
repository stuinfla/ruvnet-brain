// Qualification uses current installed native tools, never a developer's private absolute path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { nativeWorkflowBinaries } from '../../scripts/model-routing-execution-adapters.mjs';
import { resolveRuflo, rufloInvocation } from '../../plugin/scripts/ruflo-bin.mjs';
import { spawnSync } from 'node:child_process';
import { adoptedProject } from './continuity-fixture.mjs';
import { rufloRunDir } from '../../plugin/scripts/project-progression-store.mjs';
import { withProgressionReader } from '../../plugin/scripts/project-progression-reader.mjs';
import { CONTINUITY_NAMESPACE } from '../../plugin/scripts/continuity-events.mjs';

export function requiredCodexBinary({ env = process.env, home = os.homedir() } = {}) {
  let candidate = env.RUVNET_QA_CODEX_BINARY;
  if (!candidate) {
    try { candidate = nativeWorkflowBinaries(home).codex; } catch { /* CI uses the installed package below. */ }
  }
  if (!candidate) {
    const target = {
      linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
      darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
      win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
    }[process.platform]?.[process.arch];
    if (!target) throw new Error('Required native Codex qualification platform is unsupported');
    const packageRoot = path.join(home, '.npm-global', process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@openai/codex');
    const require = createRequire(path.join(packageRoot, 'package.json'));
    let vendor = path.join(packageRoot, 'vendor');
    try { vendor = path.join(path.dirname(require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)), 'vendor'); }
    catch { /* Older installed package generations carry vendor directly. */ }
    candidate = path.join(vendor, target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  }
  if (!path.isAbsolute(candidate) || !fs.statSync(candidate).isFile()) throw new Error('Required real native Codex checker is unavailable');
  return fs.realpathSync(candidate);
}

export function qualifyRufloWriter(ruflo) {
  const p = adoptedProject(), db = path.join(p.dir, '.swarm/memory.db');
  const key = `qualification-canonical-${Date.now()}`, value = JSON.stringify({ kind: 'synthetic qualification prerequisite', authoritative: false });
  const run = args => {
    const cwd = rufloRunDir(db);
    try { const invocation = rufloInvocation(ruflo, args);
      return spawnSync(invocation.executable, invocation.args, { cwd, encoding: 'utf8', timeout: 30_000,
        maxBuffer: 65_536, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' }, shell: false });
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  };
  try {
    const stored = run(['memory', 'store', '--key', key, '--value', value, '--namespace', CONTINUITY_NAMESPACE,
      '--no-upsert', '--provenance', 'system_observation', '--path', db]);
    if (stored.status !== 0) throw new Error(`Real canonical Ruflo store failed (${stored.status}): ${(stored.stderr + stored.stdout + (stored.error?.message || '')).slice(-8000)}`);
    const retrieved = run(['memory', 'retrieve', '--key', key, '--namespace', CONTINUITY_NAMESPACE, '--value-only', '--path', db]);
    if (retrieved.status !== 0 || retrieved.stdout.trim() !== value)
      throw new Error(`Real canonical Ruflo exact retrieve failed (${retrieved.status}): ${(retrieved.stderr + retrieved.stdout).slice(-8000)}`);
    const row = withProgressionReader(db, reader => reader.readContent(CONTINUITY_NAMESPACE, key));
    if (!row.ok || row.value !== value) throw new Error(`Real canonical independent SQLite row differs: ${JSON.stringify(row).slice(-2000)}`);
    process.stdout.write('Real private canonical Ruflo store/retrieve/SQLite prerequisite PASS.\n');
  } finally { fs.rmSync(p.dir, { recursive: true, force: true }); fs.rmSync(p.home, { recursive: true, force: true }); }
}

if (process.argv.includes('--emit-ci-env')) {
  const home = process.env.HOME || os.homedir();
  const prefix = path.join(home, '.npm-global');
  const ruflo = resolveRuflo({ env: { RUFLO_BIN: path.join(prefix, process.platform === 'win32' ? 'ruflo.cmd' : 'bin/ruflo') }, home });
  if (!fs.statSync(ruflo).isFile()) throw new Error('Required real global Ruflo is unavailable');
  const codex = requiredCodexBinary({ env: {}, home });
  qualifyRufloWriter(ruflo);
  fs.appendFileSync(process.env.GITHUB_ENV, `RUFLO_BIN=${ruflo}\nRUVNET_QA_CODEX_BINARY=${codex}\nRUFLO_DAEMON_AUTOSTART=0\n`);
  fs.appendFileSync(process.env.GITHUB_PATH, `${prefix}\n${path.join(prefix, 'bin')}\n`);
  process.stdout.write('Required global Ruflo and real native Codex paths verified.\n');
}
