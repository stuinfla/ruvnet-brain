import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');
const temps = [];
let install;

function temporary(prefix) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(value);
  return value;
}

function candidate(marker) {
  const root = temporary('brain-console-candidate-');
  for (const relative of ['console', 'scripts', 'plugin/scripts']) {
    fs.cpSync(path.join(ROOT, relative), path.join(root, relative), { recursive: true });
  }
  for (const relative of ['kb/brain-profile.mjs', 'bin/install.mjs', 'package.json']) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), target);
  }
  fs.appendFileSync(path.join(root, 'scripts', 'onboarding-console.mjs'), `\n// ${marker}\n`);
  return root;
}

function scriptBytes(cache) {
  return fs.readFileSync(path.join(cache, '.console-runtime', 'scripts', 'onboarding-console.mjs'), 'utf8');
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
});
