import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONSOLE_RUNTIME_SURFACE, consoleRuntimeDigest } from '../../scripts/console-runtime-identity.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const temps = [];
let install;

function temporary(prefix) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(value);
  return value;
}

// The candidate is built from the shipped surface, not a list of this fixture's own. A second
// enumeration is how the runtime came to carry plugin/scripts/whats-new.mjs without the assets it
// reads (#76); a fixture that keeps its own copy of the list just relocates that failure into CI.
function candidate(marker) {
  const root = temporary('brain-console-candidate-');
  for (const relative of CONSOLE_RUNTIME_SURFACE) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(ROOT, relative), target, { recursive: true });
  }
  fs.appendFileSync(path.join(root, 'scripts', 'onboarding-console.mjs'), `\n// ${marker}\n`);
  return root;
}

function scriptBytes(cache) {
  return fs.readFileSync(path.join(cache, '.console-runtime', 'scripts', 'onboarding-console.mjs'), 'utf8');
}

function treeSnapshot(root) {
  const snapshot = {};
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else snapshot[path.relative(root, absolute)] = fs.readFileSync(absolute).toString('hex');
    }
  };
  visit(root);
  return snapshot;
}

function stagedPayload(home, version) {
  const dir = path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', version);
  for (const relative of ['scripts', 'hooks', '.claude-plugin', 'commands']) {
    fs.mkdirSync(path.join(dir, relative), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'scripts', 'body.mjs'), `export default ${JSON.stringify(version)};\n`);
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(dir, 'commands', 'rvbc.md'), '# console\n');
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
}

beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  install = await import(`${pathToFileURL(INSTALLER).href}?transaction=${Date.now()}`);
});

afterAll(() => { delete process.env.RUVNET_BRAIN_IMPORT_ONLY; });
afterEach(() => {
  for (const value of temps.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('issue #79 — Console runtime update transaction', () => {
  it('stages and validates the provider catalog required by the Console', () => {
    const cache = temporary('brain-console-cache-');
    install.installConsoleRuntime(cache, candidate('CATALOG-PRESENT'));
    expect(JSON.parse(fs.readFileSync(path.join(cache, '.console-runtime', 'data', 'model-catalog.json'), 'utf8')).providers)
      .toBeTruthy();

    const missing = candidate('CATALOG-MISSING');
    fs.rmSync(path.join(missing, 'data', 'model-catalog.json'));
    expect(() => install.beginConsoleRuntimeTransaction(cache, missing)).toThrow(/model-catalog|incomplete/i);
  });
  it('stages without changing A, then can roll activated B back to A', () => {
    const cache = temporary('brain-console-cache-');
    install.installConsoleRuntime(cache, candidate('GENERATION-A'));
    const transaction = install.beginConsoleRuntimeTransaction(cache, candidate('GENERATION-B'));

    expect(scriptBytes(cache)).toContain('GENERATION-A');
    expect(transaction.identity.runtimeVersion).toBe(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version);
    transaction.activate();
    expect(scriptBytes(cache)).toContain('GENERATION-B');
    expect(JSON.parse(fs.readFileSync(path.join(cache, '.console-runtime', 'runtime-identity.json'), 'utf8')))
      .toMatchObject(transaction.identity);

    transaction.rollback();
    expect(scriptBytes(cache)).toContain('GENERATION-A');
    expect(fs.readdirSync(cache).filter((name) => /\.console-runtime\.(?:tmp|prior)-/.test(name))).toEqual([]);
  });

  it('commits B idempotently and leaves no transaction debris across repeated host restarts', () => {
    const cache = temporary('brain-console-cache-');
    const generation = candidate('GENERATION-B');
    const first = install.beginConsoleRuntimeTransaction(cache, generation);
    first.activate();
    first.commit();
    const identity = JSON.parse(fs.readFileSync(path.join(cache, '.console-runtime', 'runtime-identity.json'), 'utf8'));
    const before = fs.readFileSync(path.join(cache, '.console-runtime', 'scripts', 'onboarding-console.mjs'));

    install.installConsoleRuntime(cache, generation);

    expect(fs.readFileSync(path.join(cache, '.console-runtime', 'scripts', 'onboarding-console.mjs'))).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(cache, '.console-runtime', 'runtime-identity.json'), 'utf8'))).toEqual(identity);
    expect(fs.readdirSync(cache).filter((name) => /\.console-runtime\.(?:tmp|prior)-/.test(name))).toEqual([]);
  });

  it('rejects an incomplete B before activation and leaves A byte-identical', () => {
    const cache = temporary('brain-console-cache-');
    install.installConsoleRuntime(cache, candidate('GENERATION-A'));
    const before = fs.readFileSync(path.join(cache, '.console-runtime', 'scripts', 'onboarding-console.mjs'));
    const incomplete = temporary('brain-console-incomplete-');

    expect(() => install.beginConsoleRuntimeTransaction(cache, incomplete)).toThrow(/incomplete/i);
    expect(fs.readFileSync(path.join(cache, '.console-runtime', 'scripts', 'onboarding-console.mjs'))).toEqual(before);
  });

  it('removes staged debris when candidate identity validation itself fails', () => {
    const cache = temporary('brain-console-cache-');
    install.installConsoleRuntime(cache, candidate('GENERATION-A'));
    const malformed = candidate('MALFORMED-B');
    fs.writeFileSync(path.join(malformed, 'package.json'), '{not-json');

    expect(() => install.beginConsoleRuntimeTransaction(cache, malformed)).toThrow();
    expect(scriptBytes(cache)).toContain('GENERATION-A');
    expect(fs.readdirSync(cache).filter((name) => /\.console-runtime\.(?:tmp|prior)-/.test(name))).toEqual([]);
  });

  it('persists pending-console-restart when an owned live receipt names old bytes', () => {
    const runtime = candidate('GENERATION-B');
    const script = path.join(runtime, 'scripts', 'onboarding-console.mjs');
    const identity = {
      runtimeVersion: JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'))).version,
      sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex'),
    };
    const receiptDir = temporary('brain-console-receipts-');
    fs.writeFileSync(path.join(receiptDir, 'owned.json'), JSON.stringify({
      product: 'ruvnet-brain-console',
      schema: 1,
      sourceSha256: 'a'.repeat(64),
    }));

    expect(install.consoleRestartState(identity, { receiptDir })).toMatchObject({
      state: 'pending-console-restart',
      staleInstances: 1,
    });
  });

  it('the real --host-sync-only path installs runtime identity and binds it into convergence', () => {
    const home = temporary('brain-console-home-');
    const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
    const brain = path.join(home, '.cache', 'ruvnet-brain');
    fs.mkdirSync(path.join(kb, '.console-runtime', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(kb, '.console-runtime', 'scripts', 'onboarding-console.mjs'), '// GENERATION-A\n');
    stagedPayload(home, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);

    const run = spawnSync(process.execPath, [INSTALLER, '--update', '--host-sync-only'], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: path.join(home, '.codex'),
        RUVNET_BRAIN_HOME: brain,
        RUVNET_BRAIN_KB: kb,
        RUVNET_BRAIN_TEST: '1',
      },
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const identity = JSON.parse(fs.readFileSync(path.join(kb, '.console-runtime', 'runtime-identity.json'), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.join(brain, 'host-convergence.json'), 'utf8'));
    expect(identity.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.consoleRuntime).toMatchObject({
      runtimeVersion: identity.runtimeVersion,
      sourceSha256: identity.sourceSha256,
    });
  });

  it.each([
    { label: 'Claude-only', claude: true, codex: false },
    { label: 'Codex-only', claude: false, codex: true },
    { label: 'both', claude: true, codex: true },
    { label: 'neither', claude: false, codex: false },
  ])('$label host state converges only detected hosts and persists the exact restart receipt', ({ claude, codex }) => {
    const cache = temporary('brain-console-cache-');
    const brainHome = temporary('brain-console-home-');
    const receiptDir = temporary('brain-console-receipts-');
    const generationB = candidate('GENERATION-B');
    install.installConsoleRuntime(cache, candidate('GENERATION-A'));
    // The generation is the whole runtime surface (#79). A candidate source is laid out exactly as the
    // staged runtime, so digesting it here is the same fact the installer stamps into the receipt.
    const sourceSha256 = consoleRuntimeDigest(generationB);
    fs.writeFileSync(path.join(receiptDir, 'current.json'), JSON.stringify({
      product: 'ruvnet-brain-console', schema: 1, sourceSha256,
    }));
    fs.writeFileSync(path.join(receiptDir, 'stale.json'), JSON.stringify({
      product: 'ruvnet-brain-console', schema: 1, sourceSha256: 'a'.repeat(64),
    }));
    const calls = { claude: 0, codexHost: 0, codexPlugin: 0, stableSpine: 0 };

    const result = install.syncHostsAfterUpdate(cache, {
      sourceRoot: generationB,
      brainHome,
      consoleReceiptDir: receiptDir,
      wireClaude: () => {
        calls.claude += 1;
        return claude
          ? { host: true, wired: true, version: VERSION }
          : { host: false, wired: false };
      },
      wireCodexHost: () => {
        calls.codexHost += 1;
        return { host: codex, action: codex ? 'unchanged' : 'no-host' };
      },
      wireCodexPlugin: () => {
        calls.codexPlugin += 1;
        return { host: true, action: 'updated', enabled: true, version: VERSION };
      },
      runStableSpine: () => {
        calls.stableSpine += 1;
        return { status: 0 };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual({ claude: 1, codexHost: 1, codexPlugin: codex ? 1 : 0, stableSpine: 1 });
    expect(scriptBytes(cache)).toContain('GENERATION-B');
    const receipt = JSON.parse(fs.readFileSync(path.join(brainHome, 'host-convergence.json'), 'utf8'));
    expect(receipt.hosts).toEqual({
      claude: { state: claude ? 'ready' : 'absent', version: claude ? VERSION : null },
      codex: { state: codex ? 'ready' : 'absent', version: codex ? VERSION : null },
    });
    expect(receipt.consoleRuntime).toMatchObject({
      runtimeVersion: VERSION,
      sourceSha256,
      state: 'pending-console-restart',
      instanceReceipts: 2,
      staleInstances: 1,
    });
  });

  it('preserves an explicitly disabled Codex host and records it as disabled', () => {
    const cache = temporary('brain-console-cache-');
    const brainHome = temporary('brain-console-home-');
    install.installConsoleRuntime(cache, candidate('GENERATION-A'));

    const result = install.syncHostsAfterUpdate(cache, {
      sourceRoot: candidate('GENERATION-B'),
      brainHome,
      wireClaude: () => ({ host: false, wired: false }),
      wireCodexHost: () => ({ host: true, action: 'unchanged' }),
      wireCodexPlugin: () => ({ host: true, action: 'disabled', installed: true, enabled: false, version: VERSION }),
      runStableSpine: () => ({ status: 0 }),
    });

    expect(result.ok).toBe(true);
    expect(result.results.codex).toMatchObject({ action: 'disabled', enabled: false });
    expect(JSON.parse(fs.readFileSync(path.join(brainHome, 'host-convergence.json'), 'utf8')).hosts.codex)
      .toEqual({ state: 'disabled', version: VERSION });
  });

  it.each([
    {
      label: 'Claude',
      wireClaude: () => ({ host: true, wired: false, error: 'Claude verification failed' }),
      wireCodexHost: () => ({ host: false, action: 'no-host' }),
      wireCodexPlugin: () => { throw new Error('Codex must remain untouched'); },
    },
    {
      label: 'Codex',
      wireClaude: () => ({ host: false, wired: false }),
      wireCodexHost: () => ({ host: true, action: 'unchanged' }),
      wireCodexPlugin: () => ({ host: true, action: 'verification-failed', error: 'Codex verification failed' }),
    },
  ])('$label selected-host failure rolls Console runtime B back to byte-identical A', (hostFailure) => {
    const cache = temporary('brain-console-cache-');
    const brainHome = temporary('brain-console-home-');
    install.installConsoleRuntime(cache, candidate('GENERATION-A'));
    const runtime = path.join(cache, '.console-runtime');
    const before = treeSnapshot(runtime);

    const result = install.syncHostsAfterUpdate(cache, {
      sourceRoot: candidate('GENERATION-B'),
      brainHome,
      wireClaude: hostFailure.wireClaude,
      wireCodexHost: hostFailure.wireCodexHost,
      wireCodexPlugin: hostFailure.wireCodexPlugin,
      runStableSpine: () => { throw new Error('Stable Spine must not run after host failure'); },
    });

    expect(result.ok).toBe(false);
    expect(treeSnapshot(runtime)).toEqual(before);
    expect(fs.existsSync(path.join(brainHome, 'host-convergence.json'))).toBe(false);
    expect(fs.readdirSync(cache).filter((name) => /\.console-runtime\.(?:tmp|prior)-/.test(name))).toEqual([]);
  });
});
