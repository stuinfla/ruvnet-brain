import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractZip } from '../../kb/zip-extract.mjs';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const archive = process.env.RUVNET_RECOVERY_FIXTURE_ZIP;
const archiveSignature = archive ? `${archive}.sig` : null;
let fixtureRoot;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function buildFixture() {
  if (!archive) throw new Error('RUVNET_RECOVERY_FIXTURE_ZIP must name the authenticated historical archive');
  if (!fs.existsSync(archive) || !fs.existsSync(archiveSignature)) throw new Error(`authenticated recovery archive/signature missing: ${archive}`);
  fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-installer-recovery-')));
  const kb = path.join(fixtureRoot, 'kb');
  const home = path.join(fixtureRoot, 'home');
  const brainRoot = path.join(home, 'brain');
  const harness = path.join(fixtureRoot, 'harness');
  fs.mkdirSync(kb, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(repoRoot, harness, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'node_modules'
      && !source.includes(`${path.sep}node_modules${path.sep}`)
      && !source.includes(`${path.sep}.git${path.sep}`) && source !== path.join(repoRoot, '.git'),
  });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(harness, 'node_modules'), 'junction');
  const harnessPackage = readJson(path.join(harness, 'package.json'));
  harnessPackage.version = '4.3.21';
  writeJson(path.join(harness, 'package.json'), harnessPackage);
  const pluginManifest = readJson(path.join(harness, 'plugin', '.claude-plugin', 'plugin.json'));
  pluginManifest.version = '4.3.21';
  writeJson(path.join(harness, 'plugin', '.claude-plugin', 'plugin.json'), pluginManifest);
  const stagedPlugin = path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', '4.3.21');
  fs.mkdirSync(path.dirname(stagedPlugin), { recursive: true });
  fs.cpSync(path.join(harness, 'plugin'), stagedPlugin, { recursive: true });
  await extractZip(archive, kb);

  const source = readJson(path.join(kb, 'SOURCE.json'));
  const generationsFile = path.join(kb, 'RVF-GENERATIONS.json');
  const generations = readJson(generationsFile);
  const privateBytes = Buffer.from('private-bytes');
  fs.writeFileSync(path.join(kb, 'private.rvf'), privateBytes);
  source.stores.private = { kbName: 'private', sourceRepo: 'private', sourceCommit: null, sourceDescribe: 'private',
    builtUtc: '2026-09-10T00:00:00.000Z', builder: 'private', canonicalManifestUrl: null,
    canonicalBundleUrl: null, selfUpdate: null, updateManaged: false };
  generations.stores.private = { file: 'private.rvf', sha256: sha256(privateBytes), bytes: privateBytes.length,
    model: 'private', dimensions: 0, sourceCommit: null, builtUtc: '2026-09-10T00:00:00.000Z', updateManaged: false };
  writeJson(path.join(kb, 'SOURCE.json'), source);
  writeJson(generationsFile, generations);
  const fence = readJson(path.join(kb, 'PRIVATE-STORES.json'));
  fence.privateStores = [...new Set([...(fence.privateStores || []), 'private'])];
  writeJson(path.join(kb, 'PRIVATE-STORES.json'), fence);
  writeJson(path.join(kb, 'RUNTIME-IDENTITY.json'), { schemaVersion: 1, kind: 'ruvnet-brain-installed-runtime',
    brainVersion: '4.3.21', stampedUtc: '2026-09-10T00:00:00.000Z', executables: {} });
  fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '#!/usr/bin/env node\nprocess.stderr.write("historical updater unavailable\\n");\nprocess.exit(2);\n');
  return { root: fixtureRoot, kb, home, brainRoot, harness, privateDigest: sha256(privateBytes), privateMetadata: {
    source: source.stores.private, generation: generations.stores.private } };
}

describe('real installer staged recovery', () => {
  afterAll(() => { if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true }); });
  it.skipIf(!archive)('applies then no-ops while preserving private bytes and metadata', async () => {
    const fixture = await buildFixture();
    const installer = path.join(fixture.harness, 'bin', 'install.mjs');
    const env = { ...process.env, PATH: '/usr/bin:/bin', HOME: fixture.home, RUVNET_BRAIN_KB: fixture.kb,
      RUVNET_BRAIN_HOME: fixture.brainRoot, RUVNET_BRAIN_TEST: '1', RUVNET_BRAIN_TEST_LATEST_TAG: 'v4.3.21',
      RUVNET_BRAIN_TEST_BUNDLE: archive, RUVNET_NO_UPDATE_FALLBACK: '0', RUVNET_NO_TELEMETRY: '1' };
    const run = () => spawnSync(process.execPath, [installer, '--update', '--no-nightly-prompt'], {
      env, cwd: fixture.root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const first = run();
    expect(first.status, `${first.stdout.slice(-12000)}\n${first.stderr}`).toBe(0);
    expect(first.stdout).toContain('"terminalVerdict":"applied"');
    const privateAfterFirst = fs.readFileSync(path.join(fixture.kb, 'private.rvf'));
    const sourceAfterFirst = readJson(path.join(fixture.kb, 'SOURCE.json')).stores.private;
    const generationAfterFirst = readJson(path.join(fixture.kb, 'RVF-GENERATIONS.json')).stores.private;
    expect(sha256(privateAfterFirst)).toBe(fixture.privateDigest);
    expect(sourceAfterFirst).toEqual(fixture.privateMetadata.source);
    expect(generationAfterFirst).toEqual(fixture.privateMetadata.generation);
    const repeat = run();
    expect(repeat.status, `${repeat.stdout}\n${repeat.stderr}`).toBe(0);
    // The authenticated historical updater predates --result-file, so its byte-exact no-op is
    // reported in its real human-readable contract rather than a structured terminal verdict.
    expect(repeat.stdout).toContain('UP TO DATE');
    expect(sha256(fs.readFileSync(path.join(fixture.kb, 'private.rvf')))).toBe(fixture.privateDigest);
    expect(readJson(path.join(fixture.kb, 'SOURCE.json')).stores.private).toEqual(sourceAfterFirst);
    expect(readJson(path.join(fixture.kb, 'RVF-GENERATIONS.json')).stores.private).toEqual(generationAfterFirst);
    const receipts = fs.readdirSync(path.join(fixture.brainRoot, 'refresh-runs')).filter((name) => name.endsWith('.json'));
    const terminal = receipts.map((name) => readJson(path.join(fixture.brainRoot, 'refresh-runs', name))).filter((receipt) => receipt.status === 'SUCCEEDED');
    expect(terminal.length).toBeGreaterThanOrEqual(2);
    expect(readJson(path.join(fixture.brainRoot, 'host-convergence.json')).desiredVersion).toBe('4.3.21');
    expect(readJson(path.join(fixture.kb, '.console-runtime', 'package.json')).version).toBe('4.3.21');
    expect(readJson(path.join(fixture.brainRoot, 'versions', '4.3.21', '.claude-plugin', 'plugin.json')).version).toBe('4.3.21');
  }, 120_000);
});
