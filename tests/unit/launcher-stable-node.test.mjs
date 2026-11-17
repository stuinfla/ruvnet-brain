// tests/unit/launcher-stable-node.test.mjs
//
// A GENERATED LAUNCHER MUST NOT PIN A VERSIONED HOMEBREW KEG. The terminal launchers exec'd the realpath of
// the installer's node (/opt/homebrew/Cellar/node@24/24.21.0/bin/node). `brew upgrade` removed that keg and
// `claude` could not start (owner, 2026-10-08; worked around by hand with a symlink, never fixed in the
// product). The launcher now stores Homebrew's opt link, which brew re-points on every upgrade, and a
// refresh from a config that still names a dead keg heals instead of failing.
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// RNB_LAUNCHERS_UNDER_TEST: an older copy beside the real module, to prove this test fails on the old code.
const { installTerminalLaunchers } = await import(process.env.RNB_LAUNCHERS_UNDER_TEST
  ? pathToFileURL(process.env.RNB_LAUNCHERS_UNDER_TEST).href : '../../scripts/model-terminal-launchers.mjs');

const posix = process.platform !== 'win32';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, data, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { mode }); };

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-stable-node-')));
  const native = path.join(home, '.codex/packages/standalone/releases/1.0.0/bin/codex');
  // Exact-literal executable identities are fixture bytes, never live commands.
  write(native, Buffer.from('7f454c460001', 'hex'), 0o755);
  const keg = (version) => path.join(home, 'brew/Cellar/node@24', version, 'bin/node');
  write(keg('24.0.0'), Buffer.from('7f454c460001', 'hex'), 0o755);
  fs.mkdirSync(path.join(home, 'brew/opt'), { recursive: true });
  fs.symlinkSync('../Cellar/node@24/24.0.0', path.join(home, 'brew/opt/node@24'));
  const files = { 'scripts/model-terminal-launchers.mjs': '// fixture', 'scripts/model-terminal-gateway.mjs': '// fixture' };
  const identity = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => [file, sha(bytes)]);
  const digest = sha(JSON.stringify(identity));
  const runtimeRoot = path.join(home, '.cache/ruvnet-brain/model-routing/versions', digest);
  for (const [file, bytes] of Object.entries(files)) write(path.join(runtimeRoot, file), bytes);
  const install = (nodeBinary) => installTerminalLaunchers({ home, runtimeRoot, runtimeDigest: digest, realCodex: native, nodeBinary, apply: true, manageZsh: false });
  return { home, keg, install, opt: path.join(home, 'brew/opt/node@24/bin/node') };
}

it.skipIf(!posix || !['darwin', 'linux'].includes(process.platform))('stores the Homebrew opt link, not the keg, and heals a dead pinned keg after brew upgrade', () => {
  const f = fixture();
  try {
    const first = f.install(f.keg('24.0.0'));
    expect(first.config.nodeBinary).toBe(f.opt);
    expect(fs.readFileSync(path.join(f.home, '.local/bin/codex'), 'utf8')).toContain(`exec '${f.opt}'`);

    // brew upgrade: a new keg, opt re-pointed, the old keg deleted.
    write(f.keg('24.1.0'), Buffer.from('7f454c460001', 'hex'), 0o755);
    fs.unlinkSync(path.join(f.home, 'brew/opt/node@24'));
    fs.symlinkSync('../Cellar/node@24/24.1.0', path.join(f.home, 'brew/opt/node@24'));
    fs.rmSync(path.join(f.home, 'brew/Cellar/node@24/24.0.0'), { recursive: true });

    // A refresh from a config written before this fix still names the dead keg; it must heal, not throw.
    const healed = f.install(f.keg('24.0.0'));
    expect(healed.config.nodeBinary).toBe(f.opt);
    expect(fs.realpathSync(healed.config.nodeBinary)).toBe(fs.realpathSync(f.keg('24.1.0')));
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

// The VS Code routing launchers (scripts/model-routing-launchers.mjs) carry their own inlined copy of the rule.
const { stableNode: routingStableNode } = await import('../../scripts/model-routing-launchers.mjs');
it.skipIf(!posix)('routing launchers: a keg path becomes its opt link, and a dead pinned keg still resolves to it', () => {
  const f = fixture();
  try {
    expect(routingStableNode(f.keg('24.0.0'))).toBe(f.opt);
    write(f.keg('24.1.0'), Buffer.from('7f454c460001', 'hex'), 0o755);
    fs.unlinkSync(path.join(f.home, 'brew/opt/node@24'));
    fs.symlinkSync('../Cellar/node@24/24.1.0', path.join(f.home, 'brew/opt/node@24'));
    fs.rmSync(path.join(f.home, 'brew/Cellar/node@24/24.0.0'), { recursive: true });
    expect(routingStableNode(f.keg('24.0.0'))).toBe(f.opt);
    const plain = path.join(f.home, 'bin', 'node');
    write(plain, 'x', 0o755);
    expect(routingStableNode(plain)).toBe(plain); // not a keg: unchanged
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
