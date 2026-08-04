// Issue #76 — the installed What's New skill lost its release-note asset after a supported install.
//
// The notes are packed (npm ships plugin/docs/RELEASE-NOTES-4.0.md) and they are read correctly
// (plugin/scripts/whats-new.mjs resolves them from its own plugin root). They were lost in between:
// the persistent Console runtime — the surface issue #76 names as the fix location — copied
// plugin/scripts and none of the sibling assets that executable reads, so the installed What's New
// executable travelled to every clean install without its version manifest or its notes.
//
// These tests execute the real boundary from a staged runtime with no checkout in reach.

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installConsoleRuntime } from '../../bin/install.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const NOTES = path.join('plugin', 'docs', 'RELEASE-NOTES-4.0.md');
const MANIFEST = path.join('plugin', '.claude-plugin', 'plugin.json');
const temps = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Run the installed What's New executable from `runtime`, with the cwd nowhere near a checkout. */
function runWhatsNew(runtime) {
  const elsewhere = tempDir('brain-whats-new-elsewhere-');
  return spawnSync(process.execPath, [path.join(runtime, 'plugin', 'scripts', 'whats-new.mjs')], {
    cwd: elsewhere,
    env: { ...process.env, HOME: elsewhere, USERPROFILE: elsewhere },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

/**
 * A staged runtime is itself a valid candidate source: every surface path is laid out identically on
 * both sides. Building candidates this way keeps the fixture on the shipped file manifest instead of
 * a second, drifting list of its own.
 */
function candidateSource(mutate = () => {}) {
  const source = path.join(tempDir('brain-whats-new-candidate-'), 'source');
  fs.cpSync(installedRuntime(), source, { recursive: true });
  mutate(source);
  return source;
}

let pristine = null;
function installedRuntime() {
  if (!pristine) {
    const cache = tempDir('brain-whats-new-runtime-');
    installConsoleRuntime(cache, REPO);
    pristine = path.join(cache, '.console-runtime');
  }
  return pristine;
}

afterEach(() => {
  pristine = null;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('issue #76 installed What\'s New assets', () => {
  it('reports the installed version and curated notes from the persistent runtime alone', () => {
    const runtime = installedRuntime();

    expect(fs.existsSync(path.join(runtime, NOTES))).toBe(true);
    expect(fs.readFileSync(path.join(runtime, NOTES)))
      .toEqual(fs.readFileSync(path.join(REPO, NOTES)));
    expect(JSON.parse(fs.readFileSync(path.join(runtime, MANIFEST), 'utf8')).version)
      .toBe(PACKAGE_VERSION);

    const run = runWhatsNew(runtime);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`RuvNet Brain ${PACKAGE_VERSION}`);
    expect(run.stdout).toContain('# RuvNet-Brain 4.0 line');
  });

  it('refuses to activate a candidate whose curated notes are missing, keeping the prior runtime', () => {
    const runtime = installedRuntime();
    const cache = path.resolve(runtime, '..');
    const broken = candidateSource((source) => fs.rmSync(path.join(source, NOTES), { force: true }));

    expect(() => installConsoleRuntime(cache, broken)).toThrow(/RELEASE-NOTES|plugin\/docs|release notes/i);

    expect(fs.readFileSync(path.join(runtime, NOTES)))
      .toEqual(fs.readFileSync(path.join(REPO, NOTES)));
    expect(runWhatsNew(runtime).status).toBe(0);
  });

  it('refuses a candidate whose version metadata cannot be read by the executable itself', () => {
    const runtime = installedRuntime();
    const cache = path.resolve(runtime, '..');
    const broken = candidateSource((source) => {
      const file = path.join(source, MANIFEST);
      const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      delete manifest.version;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    });

    expect(() => installConsoleRuntime(cache, broken)).toThrow(/version metadata is missing|release notes/i);
    expect(runWhatsNew(runtime).status).toBe(0);
  });
});
