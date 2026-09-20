/**
 * Wrapper-vs-KB version drift (issue: two independently-versioned artifacts, verified live
 * 2026-07-20).
 *
 * The brain ships as TWO independently-versioned artifacts:
 *   1. The KB content bundle — self-updates nightly via forge-update.mjs + GitHub Releases.
 *   2. The Claude Code plugin wrapper (hooks, skills, slash commands) — updates ONLY when Claude
 *      Code pulls the marketplace git clone at ~/.claude/plugins/marketplaces/ruvnet-brain, which
 *      does not happen at all when "autoUpdate": false is set in ~/.claude/settings.json.
 *
 * They can drift silently, and the version a user is SHOWN always comes from the frozen wrapper,
 * never the brain — so a fully current KB next to a stale wrapper looks fine and isn't. Confirmed
 * live on this machine the same day: KB SOURCE.json built today, wrapper plugin.json nine commits
 * behind origin/main, autoUpdate:false in settings.json.
 *
 * checkVersionDrift()/reportVersionDrift() in bin/install.mjs read both real artifacts (KB
 * SOURCE.json's releaseTag; wrapper plugin.json's version, located via the existing
 * pluginCommandsDir() helper) and only ever speak up when BOTH resolve to a real value AND they
 * differ. This file proves that contract against real files on disk, exactly like
 * uninstall-footprint.test.mjs: spawn the real installer with HOME pointed at a temp dir, never
 * mock the comparison.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'version-drift-test-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const kbDir = () => path.join(home, '.cache', 'ruvnet-brain', 'kb');
// The exact layout pluginCommandsDir()'s first candidate checks: a marketplace-installed plugin.
const pluginDir = () => path.join(home, '.claude', 'plugins', 'marketplaces', 'ruvnet-brain', 'plugin');

function run(args) {
  const res = spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, RUVNET_BRAIN_TEST: '1' },
  });
  return `${res.stdout || ''}${res.stderr || ''}`;
}

/**
 * The minimal KB fixture that gets --doctor past its "brain not found here" early return.
 * @param {{releaseTag?: string|null}} opts — omit entirely for "no SOURCE.json at all"; pass
 *   releaseTag: null for "SOURCE.json exists but has no releaseTag" (a locally-built bundle);
 *   pass a real string to stamp a real tag.
 */
function seedKb(opts) {
  fs.mkdirSync(kbDir(), { recursive: true });
  fs.writeFileSync(path.join(kbDir(), 'forge-mcp-all.mjs'), '// stub for version-drift test — never executed\n');
  if (opts !== undefined) {
    const doc = opts.releaseTag == null ? {} : { releaseTag: opts.releaseTag };
    fs.writeFileSync(path.join(kbDir(), 'SOURCE.json'), JSON.stringify(doc));
  }
}

/** The minimal plugin fixture — rvbc.md is exactly what pluginCommandsDir() probes for. */
function seedPlugin(version) {
  const dir = pluginDir();
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'commands', 'rvbc.md'), '# stub\n');
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
}

const FIX_COMMAND = 'claude plugin marketplace update ruvnet-brain';
// Fixture tags only — deliberately NOT real product-version-shaped strings (no trailing "-dev"),
// so they never trip the repo's own sync-version --check "stray hardcoded version literal" guard,
// which flags any quoted vX.Y.Z(-dev)? literal that is or looks like the real product version.
// PRODUCTION SHAPE, deliberately asymmetric. The two sides are written by different writers in
// different formats: build-bundle stamps SOURCE.json.releaseTag as a git TAG (v-prefixed), while
// sync-version writes plugin.json.version as a bare SEMVER. The first version of this file gave the
// wrapper a v-prefixed version — an input sync-version can NEVER produce — so the "matching" case
// compared two identical strings and passed, while the real code did a raw !== and reported drift on
// every healthy install in the world. An impossible fixture green-lit a false user-facing claim.
// These constants now mirror what the two writers actually emit, so the matching case only passes
// if the comparison genuinely normalizes the tag prefix.
const KB_TAG = 'v9.9.9-test';           // as build-bundle stamps it
const WRAPPER_MATCHING = '9.9.9-test';  // as sync-version writes it — SAME version, no prefix
const WRAPPER_DIFFERENT = '8.8.8-test'; // genuinely different, also unprefixed

describe('wrapper-vs-KB version drift — --doctor', () => {
  it('says nothing when both versions match', () => {
    seedKb({ releaseTag: KB_TAG });
    seedPlugin(WRAPPER_MATCHING);

    const out = run(['--doctor']);

    expect(out).not.toContain('have drifted apart');
    expect(out).not.toContain(FIX_COMMAND);
  });

  it('reports the drift, both real versions, and the exact fix command when they differ', () => {
    seedKb({ releaseTag: KB_TAG });
    seedPlugin(WRAPPER_DIFFERENT);

    const out = run(['--doctor']);

    expect(out).toContain('have drifted apart');
    expect(out).toContain(KB_TAG);
    expect(out).toContain(WRAPPER_DIFFERENT);
    expect(out).toContain(FIX_COMMAND);
    // A version difference cannot establish health in either direction.
    expect(out).toMatch(/does not prove either is healthy/);
  });

  it('never reports drift when the plugin wrapper is not installed', () => {
    seedKb({ releaseTag: KB_TAG });
    // No seedPlugin() call — pluginCommandsDir() finds nothing, wrapperVersion() must return null.

    const out = run(['--doctor']);

    expect(out).not.toContain('have drifted apart');
    expect(out).not.toContain(FIX_COMMAND);
  });

  it('never reports drift when SOURCE.json is missing entirely (fresh/partial install)', () => {
    seedKb(); // no SOURCE.json written at all
    seedPlugin(WRAPPER_DIFFERENT);

    const out = run(['--doctor']);

    expect(out).not.toContain('have drifted apart');
    expect(out).not.toContain(FIX_COMMAND);
  });

  it('never reports drift when SOURCE.json has no releaseTag (locally-built bundle — not a bug)', () => {
    seedKb({ releaseTag: null }); // SOURCE.json exists but carries no releaseTag field
    seedPlugin(WRAPPER_DIFFERENT);

    const out = run(['--doctor']);

    expect(out).not.toContain('have drifted apart');
    expect(out).not.toContain(FIX_COMMAND);
  });

  it('never fabricates a version — an unparsable plugin.json is treated as unknown, not a guess', () => {
    seedKb({ releaseTag: KB_TAG });
    const dir = pluginDir();
    fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'commands', 'rvbc.md'), '# stub\n');
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{ not valid json');

    const out = run(['--doctor']);

    expect(out).not.toContain('have drifted apart');
    expect(out).not.toContain(FIX_COMMAND);
  });
});

describe('wrapper-vs-KB version drift — --what-changed', () => {
  it('reports the same drift + fix command in the machine-footprint output', () => {
    seedKb({ releaseTag: KB_TAG });
    seedPlugin(WRAPPER_DIFFERENT);

    const out = run(['--what-changed']);

    expect(out).toContain('have drifted apart');
    expect(out).toContain(FIX_COMMAND);
  });

  it('stays silent in --what-changed when versions match', () => {
    seedKb({ releaseTag: KB_TAG });
    seedPlugin(WRAPPER_MATCHING);

    const out = run(['--what-changed']);

    expect(out).not.toContain('have drifted apart');
    expect(out).not.toContain(FIX_COMMAND);
  });
});
