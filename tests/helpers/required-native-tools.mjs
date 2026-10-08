// Qualification uses current installed native tools, never a developer's private absolute path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { nativeWorkflowBinaries } from '../../scripts/model-routing-execution-adapters.mjs';
import { resolveRuflo } from '../../plugin/scripts/ruflo-bin.mjs';

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

if (process.argv.includes('--emit-ci-env')) {
  const home = process.env.HOME || os.homedir();
  const prefix = path.join(home, '.npm-global');
  const ruflo = resolveRuflo({ env: { RUFLO_BIN: path.join(prefix, process.platform === 'win32' ? 'ruflo.cmd' : 'bin/ruflo') }, home });
  if (!fs.statSync(ruflo).isFile()) throw new Error('Required real global Ruflo is unavailable');
  const codex = requiredCodexBinary({ env: {}, home });
  fs.appendFileSync(process.env.GITHUB_ENV, `RUFLO_BIN=${ruflo}\nRUVNET_QA_CODEX_BINARY=${codex}\nRUFLO_DAEMON_AUTOSTART=0\n`);
  fs.appendFileSync(process.env.GITHUB_PATH, `${prefix}\n${path.join(prefix, 'bin')}\n`);
  process.stdout.write('Required global Ruflo and real native Codex paths verified.\n');
}
