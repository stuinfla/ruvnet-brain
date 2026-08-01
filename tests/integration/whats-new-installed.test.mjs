import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const temps = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-whats-new-'));
  temps.push(dir);
  return dir;
}

function packedInstalledPlugin() {
  const root = tempDir();
  const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', root], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
  });
  expect(packed.status, packed.stderr || packed.stdout).toBe(0);
  const tarball = path.join(root, packed.stdout.trim().split(/\r?\n/).at(-1));
  const unpacked = path.join(root, 'unpacked');
  fs.mkdirSync(unpacked);
  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', unpacked], { encoding: 'utf8' });
  expect(extracted.status, extracted.stderr).toBe(0);

  const installed = path.join(root, 'installed-plugin');
  fs.cpSync(path.join(unpacked, 'package', 'plugin'), installed, { recursive: true });
  fs.rmSync(tarball);
  fs.rmSync(unpacked, { recursive: true });
  return installed;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('issue #76 — installed whats-new authority', () => {
  it('ships the exact curated release-note bytes inside the immutable plugin payload', () => {
    expect(fs.readFileSync(path.join(REPO, 'plugin', 'docs', 'RELEASE-NOTES-4.0.md')))
      .toEqual(fs.readFileSync(path.join(REPO, 'docs', 'RELEASE-NOTES-4.0.md')));
  });

  it('runs from the packed installed plugin after every package/source artifact is removed', () => {
    const installed = packedInstalledPlugin();
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, '.codex-plugin', 'plugin.json'), 'utf8'));
    const run = spawnSync(process.execPath, [path.join(installed, 'scripts', 'whats-new.mjs')], {
      cwd: tempDir(),
      encoding: 'utf8',
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`RuvNet Brain ${manifest.version}`);
    expect(run.stdout).toContain("# RuvNet-Brain 4.0 line — what's new");
    expect(run.stderr).toBe('');
  }, 120_000);

  it('fails honestly and nonzero when the exact installed asset is missing', () => {
    const installed = packedInstalledPlugin();
    fs.rmSync(path.join(installed, 'docs', 'RELEASE-NOTES-4.0.md'));
    const run = spawnSync(process.execPath, [path.join(installed, 'scripts', 'whats-new.mjs')], {
      cwd: tempDir(),
      encoding: 'utf8',
    });

    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/installed release notes are missing/i);
    expect(run.stderr).toContain(path.join(installed, 'docs', 'RELEASE-NOTES-4.0.md'));
    expect(run.stderr).not.toMatch(/~\/Code|checkout|download|latest/i);
  }, 120_000);

  it('moves executable, manifest and notes together across a Stable Spine A→B flip', () => {
    const root = tempDir();
    const brainHome = path.join(root, 'brain-home');
    const makeCandidate = (version, marker) => {
      const candidate = path.join(root, version);
      fs.cpSync(path.join(REPO, 'plugin'), candidate, { recursive: true });
      for (const rel of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
        const file = path.join(candidate, rel);
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.version = version;
        fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      fs.appendFileSync(path.join(candidate, 'docs', 'RELEASE-NOTES-4.0.md'), `\n${marker}\n`);
      return candidate;
    };
    const apply = (candidate) => spawnSync(process.execPath, [
      path.join(REPO, 'plugin', 'scripts', 'update-apply.mjs'), '--from-dir', candidate,
    ], { env: { ...process.env, RUVNET_BRAIN_HOME: brainHome }, encoding: 'utf8' });
    const activeRoot = () => {
      const active = JSON.parse(fs.readFileSync(path.join(brainHome, 'active.json'), 'utf8'));
      return path.resolve(brainHome, active.codeRoot);
    };

    const a = makeCandidate('4.0.76-a', 'ISSUE76-A');
    const first = apply(a);
    expect(first.status, first.stderr || first.stdout).toBe(0);
    expect(spawnSync(process.execPath, [path.join(activeRoot(), 'scripts', 'whats-new.mjs')], { encoding: 'utf8' }).stdout)
      .toMatch(/RuvNet Brain 4\.0\.76-a[\s\S]*ISSUE76-A/);

    const b = makeCandidate('4.0.76-b', 'ISSUE76-B');
    const second = apply(b);
    expect(second.status, second.stderr || second.stdout).toBe(0);
    const activeOutput = spawnSync(process.execPath, [path.join(activeRoot(), 'scripts', 'whats-new.mjs')], { encoding: 'utf8' });
    expect(activeOutput.status, activeOutput.stderr).toBe(0);
    expect(activeOutput.stdout).toMatch(/RuvNet Brain 4\.0\.76-b[\s\S]*ISSUE76-B/);
    expect(activeOutput.stdout).not.toContain('ISSUE76-A');
  }, 120_000);

  it('keeps the Claude command and Codex skill on the same installed executable', () => {
    const command = fs.readFileSync(path.join(REPO, 'plugin', 'commands', 'whats-new.md'), 'utf8');
    const skill = fs.readFileSync(path.join(REPO, 'plugin', 'skills', 'whats-new', 'SKILL.md'), 'utf8');
    expect(command).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/whats-new.mjs');
    expect(skill).toContain('scripts/whats-new.mjs');
    expect(skill).not.toMatch(/~\/Code|current repository/i);
  });
});
