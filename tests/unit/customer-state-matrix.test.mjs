// tests/unit/customer-state-matrix.test.mjs — the matrix is DERIVED, one factor at a time, from data.
//
// scripts/customer-state-matrix.mjs runs real published releases through the real customer door; that
// part is evidence, not a unit test (it needs ~1.5 GB per base). What a unit test can and must pin is the
// part that decides WHICH states get exercised: a scenario list nobody can silently shrink, runtimes
// resolved from the live release list rather than typed, and the one rewrite the harness makes.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_AXES, deriveScenarios, pointAtMirror, resolveRuntime } from '../../scripts/customer-state-matrix.mjs';

describe('customer state matrix derivation', () => {
  it('derives the baseline plus exactly one scenario per non-baseline axis value', () => {
    const scenarios = deriveScenarios();
    const expected = 1 + STATE_AXES.reduce((n, { values }) => n + values.length - 1, 0);
    expect(scenarios).toHaveLength(expected);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(expected);
    const baseline = scenarios[0].state;
    for (const { id, state } of scenarios.slice(1)) {
      const changed = Object.keys(state).filter((axis) => state[axis] !== baseline[axis]);
      expect(changed, id).toHaveLength(1);
      expect(id).toBe(`${changed[0]}=${state[changed[0]]}`);
    }
  });

  it('covers the states the 2026-09-30 defects lived in, so dropping one fails here', () => {
    const ids = deriveScenarios().map((s) => s.id);
    for (const id of ['overlay=private-store', 'runtime=N-5', 'transaction=killed-during-candidate-build', 'location=symlinked-cache']) {
      expect(ids).toContain(id);
    }
  });

  it('resolves N-k against published semver releases only (drafts and corpus tags excluded)', () => {
    const releases = [
      { tag_name: 'v4.3.39' }, { tag_name: 'corpus-sha256-' + 'a'.repeat(64) }, { tag_name: 'v4.3.38' },
      { tag_name: 'v4.3.13', draft: true }, { tag_name: 'v4.3.37' }, { tag_name: 'v4.3.9' }, { tag_name: 'v4.3.10' },
    ];
    // Expected versions are read from the fixture: published semver tags below the candidate, newest first
    // (v4.3.38, v4.3.37, v4.3.10, v4.3.9 — the draft and the corpus tag are skipped).
    const fixtureVersion = (tag) => releases.find((r) => r.tag_name === tag).tag_name.slice(1);
    expect(resolveRuntime('N-1', { candidateTag: 'v4.3.39', releases })).toBe(fixtureVersion('v4.3.38'));
    expect(resolveRuntime('N-3', { candidateTag: 'v4.3.39', releases })).toBe(fixtureVersion('v4.3.10'));
    expect(resolveRuntime('N-4', { candidateTag: 'v4.3.39', releases })).toBe(fixtureVersion('v4.3.9'));
    expect(() => resolveRuntime('N-9', { candidateTag: 'v4.3.39', releases })).toThrow(/no published release/);
    expect(() => resolveRuntime('latest', { candidateTag: 'v4.3.39', releases })).toThrow(/N-<k>/);
  });

  it('changes only the origin of the customer channel, and refuses any other channel', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-'));
    try {
      const source = { releaseTag: 'v4.3.38', canonicalManifestUrl: 'https://api.github.com/repos/stuinfla/ruvnet-brain/releases/latest', stores: {} };
      fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify(source));
      pointAtMirror(kb, 'http://127.0.0.1:9');
      const after = JSON.parse(fs.readFileSync(path.join(kb, 'SOURCE.json'), 'utf8'));
      expect(after).toEqual({ ...source, canonicalManifestUrl: 'http://127.0.0.1:9/repos/stuinfla/ruvnet-brain/releases/latest' });
      expect(() => pointAtMirror(kb, 'http://127.0.0.1:9')).toThrow(/not https:\/\/api\.github\.com/);
    } finally { fs.rmSync(kb, { recursive: true, force: true }); }
  });
});
