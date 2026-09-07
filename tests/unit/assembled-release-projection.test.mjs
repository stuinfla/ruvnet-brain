import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bindAssembledReleaseProjection } from '../../scripts/release-projection.mjs';
import { validateCoverageDirectory } from '../../plugin/scripts/coverage-integrity.mjs';
import { getVersion } from '../../scripts/version.mjs';

let assetsDir;
const version = getVersion();
const sourceSnapshot = 'd'.repeat(40);
const bind = (overrides = {}) => bindAssembledReleaseProjection({ assetsDir, version, sourceSnapshot, ...overrides });
beforeEach(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembled-projection-'));
  execFileSync(process.execPath, ['scripts/ci/build-fixture-kb.mjs', '--out', assetsDir],
    { cwd: path.resolve(import.meta.dirname, '../..'), stdio: 'pipe' });
});
afterEach(() => fs.rmSync(assetsDir, { recursive: true, force: true }));

it('repairs the legacy assembly omission without changing immutable public evidence', () => {
  const publicPath = path.join(assetsDir, 'PUBLIC-RVF-GENERATIONS.json');
  const immutable = fs.readFileSync(publicPath);
  const ledger = JSON.parse(immutable);
  fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({
    schemaVersion: 1, brainVersion: version, releaseTag: `v${version}`, stores: ledger.stores,
  }));
  expect(validateCoverageDirectory(assetsDir).failures).toContain('runtime generation ledger release identity differs');
  expect(bind().valid).toBe(true);
  expect(fs.readFileSync(publicPath)).toEqual(immutable);
  expect(JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'))))
    .toEqual({ ...ledger, kind: 'ruvnet-brain-runtime-generation-ledger' });
});

it('rejects a projection for a different source before rewriting the runtime ledger', () => {
  const before = fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'));
  expect(() => bind({ sourceSnapshot: 'e'.repeat(40) })).toThrow('does not bind this release source');
  expect(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'))).toEqual(before);
});

it('rejects changed public bytes even when their release identity matches', () => {
  fs.appendFileSync(path.join(assetsDir, 'fixture.big.rvf'), 'tampered');
  expect(() => bind()).toThrow('assembled release projection rejected');
});

it('rejects modified coverage instead of treating ledger rebinding as qualification', () => {
  const file = path.join(assetsDir, 'COVERAGE.json');
  const coverage = JSON.parse(fs.readFileSync(file));
  coverage.releaseIdentity.version = '0.0.0-invalid';
  fs.writeFileSync(file, JSON.stringify(coverage));
  expect(() => bind()).toThrow('assembled release projection rejected');
});
