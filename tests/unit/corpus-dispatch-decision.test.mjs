import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MIN_PIPELINE_VERSION, compareVersions, decide, resolutionFrom,
} from '../../scripts/corpus-dispatch-decision.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'scripts/corpus-dispatch-decision.mjs');
const A = 'a'.repeat(40);
const resolved = (version, sourceSha = A) => ({ status: 'resolved', release: { tag: `v${version}`, version, sourceSha } });
// Versions are derived from the floor, never spelled: the floor is a fixed fact, the rest is arithmetic.
const [MAJ, MIN, PAT] = MIN_PIPELINE_VERSION.split('.').map(Number);
const FLOOR = MIN_PIPELINE_VERSION;
const BELOW = `${MAJ}.${MIN}.${PAT - 1}`;
const NEXT = `${MAJ}.${MIN}.${PAT + 1}`;
const WIDE_MINOR = `${MAJ}.${MIN + 7}.0`; // e.g. 4.10.0: lexically smaller than the floor, numerically larger
const OLD_MAJOR = `${MAJ - 1}.99.99`;
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('corpus dispatch decision (pure)', () => {
  it('the pipeline floor is 4.3.38 and versions compare numerically, not lexically', () => {
    expect(MIN_PIPELINE_VERSION).toBe('4.3.38'); // sync-version-ignore: the design's fixed floor
    expect(WIDE_MINOR < FLOOR).toBe(true); // the lexical trap this comparison must not fall into
    expect(compareVersions(WIDE_MINOR, FLOOR)).toBe(1);
    expect(compareVersions(FLOOR, FLOOR)).toBe(0);
    expect(compareVersions(BELOW, FLOOR)).toBe(-1);
    expect(() => compareVersions(`${MAJ}.${MIN}`, FLOOR)).toThrow(/cannot compare/);
  });

  it('ARMS at the approved release sourceSha; main HEAD is not an input at all', () => {
    const decision = decide({ nightlyVar: '', resolution: resolved(FLOOR) });
    expect(decision).toEqual({ verdict: 'arm', reason: expect.stringContaining(A), tag: `v${FLOOR}`, version: FLOOR, sourceSha: A });
    expect(decide({ nightlyVar: 'on', resolution: resolved(WIDE_MINOR) }).verdict).toBe('arm');
  });

  it.each(['off', 'OFF', ' Off '])('the kill switch %j stands down, before any evidence is looked at', (value) => {
    expect(decide({ nightlyVar: value, resolution: resolved(FLOOR) })).toMatchObject({ verdict: 'stand-down', reason: expect.stringMatching(/kill switch/) });
    expect(decide({ nightlyVar: value, resolution: { status: 'invalid', reason: 'x' } }).verdict).toBe('stand-down');
  });

  it('stands down (not fails) while the approved runtime predates the pipeline floor', () => {
    expect(decide({ nightlyVar: '', resolution: resolved(BELOW) })).toMatchObject({ verdict: 'stand-down', reason: `approved runtime v${BELOW} predates ${FLOOR}, the first release whose pipeline this workflow can drive` });
    expect(decide({ nightlyVar: '', resolution: resolved(OLD_MAJOR) }).verdict).toBe('stand-down');
  });

  it('stands down on "not yet verified" and FAILS on evidence that does not hold', () => {
    expect(decide({ nightlyVar: '', resolution: { status: 'not-yet-verified' } }).verdict).toBe('stand-down');
    expect(decide({ nightlyVar: '', resolution: { status: 'invalid', reason: 'bad signature' } }))
      .toMatchObject({ verdict: 'fail', reason: expect.stringContaining('bad signature') });
    expect(decide({ nightlyVar: '', resolution: null }).verdict).toBe('fail');
    for (const release of [{ tag: `v${FLOOR}`, version: FLOOR, sourceSha: 'short' },
      { tag: `v${NEXT}`, version: FLOOR, sourceSha: A }, { tag: `v${MAJ}.${MIN}`, version: `${MAJ}.${MIN}`, sourceSha: A }]) {
      expect(decide({ nightlyVar: '', resolution: { status: 'resolved', release } }).verdict).toBe('fail');
    }
  });

  // VERSION SKEW (2026-09-29, reproduced live): from a 4.3.36 checkout the resolver cannot verify the
  // v4.3.35 aggregate ("retired fixture denominator set is invalid") -- the verifier is a newer
  // generation. That must stand down, not page red, while a release at/above the floor still fails loud.
  it('a refused newest release BELOW the floor stands down; at or above the floor it still fails loud', () => {
    const refused = (version) => resolutionFrom({ status: 1, stdout: '',
      stderr: `[approved-runtime] code release v${version} (the newest) carries install-verification evidence that does not hold `
        + '(refusing it, and refusing to fall back to an older release): retired fixture denominator set is invalid\n' });
    expect(refused(BELOW)).toEqual({ status: 'invalid', tag: `v${BELOW}`,
      reason: 'approved-runtime.mjs --resolve exited 1 (retired fixture denominator set is invalid)' });
    expect(decide({ nightlyVar: '', resolution: refused(BELOW) }))
      .toMatchObject({ verdict: 'stand-down', reason: expect.stringMatching(new RegExp(`newest code release v${BELOW.replaceAll('.', '\\.')} predates`)) });
    expect(decide({ nightlyVar: '', resolution: refused(FLOOR) }).verdict).toBe('fail');
    expect(decide({ nightlyVar: '', resolution: refused(NEXT) }).verdict).toBe('fail');
    // A failure that names no release (network, malformed output) is never assumed to be skew.
    expect(decide({ nightlyVar: '', resolution: resolutionFrom({ status: 1, stdout: '', stderr: 'gh api failed' }) }).verdict).toBe('fail');
  });

  it('maps approved-runtime --resolve exit codes: 3 = not yet verified, other non-zero = invalid', () => {
    expect(resolutionFrom({ status: 3, stdout: '' })).toEqual({ status: 'not-yet-verified' });
    expect(resolutionFrom({ status: 1, stdout: '' })).toEqual({ status: 'invalid', tag: null, reason: 'approved-runtime.mjs --resolve exited 1' });
    expect(resolutionFrom({ status: 0, stdout: 'not json' }).status).toBe('invalid');
    expect(resolutionFrom({ status: 0, stdout: JSON.stringify(resolved(FLOOR).release) })).toEqual(resolved(FLOOR));
  });
});

describe('corpus dispatch decision (CLI, across the process boundary)', () => {
  const cli = ({ nightly = '', status = '0', release = resolved(FLOOR).release } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-decision-'));
    dirs.push(dir);
    const releaseFile = path.join(dir, 'approved-release.json');
    fs.writeFileSync(releaseFile, JSON.stringify(release));
    const output = path.join(dir, 'github-output');
    fs.writeFileSync(output, '');
    const result = spawnSync(process.execPath, [CLI, '--nightly', nightly, '--resolve-status', status,
      '--release', releaseFile, '--github-output', output], { encoding: 'utf8' });
    return { ...result, output: fs.readFileSync(output, 'utf8') };
  };

  it('arm writes the approved identity to GITHUB_OUTPUT and exits 0', () => {
    const result = cli();
    expect(result.status).toBe(0);
    expect(result.output).toBe(`armed=true\napproved_sha=${A}\napproved_version=${FLOOR}\napproved_tag=v${FLOOR}\nverdict=arm\n`);
    expect(result.stdout).toMatch(/^::notice::corpus-nightly-dispatch arm:/);
  });

  it('stand-down exits 0 with armed=false and no identity', () => {
    for (const run of [cli({ nightly: 'off', status: 'skipped' }), cli({ status: '3' }), cli({ release: resolved(BELOW).release })]) {
      expect(run.status).toBe(0);
      expect(run.output).toBe('armed=false\nverdict=stand-down\n');
    }
  });

  it('--is-off answers the kill switch alone, with the same rule decide() uses', () => {
    for (const [value, expected] of [['off', 'true'], ['OFF', 'true'], ['on', 'false'], ['', 'false']]) {
      const result = spawnSync(process.execPath, [CLI, '--is-off', value], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${expected}\n`);
    }
  });

  it('fail exits 1 with an ::error:: annotation and armed=false', () => {
    const result = cli({ status: '1' });
    expect(result.status).toBe(1);
    expect(result.output).toBe('armed=false\nverdict=fail\n');
    expect(result.stdout).toMatch(/^::error::corpus-nightly-dispatch fail:/);
  });
});
