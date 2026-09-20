import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectInstalledBrain, classifySmokeEvidence, DOCTOR_SMOKE_QUERY, doctorSmokeArgs } from '../../scripts/installed-brain-health.mjs';
import { writeInstalledRuntimeIdentity } from '../../kb/corpus-release-identity.mjs';
import { createHash } from 'node:crypto';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(searchVersion = '9.9.8', validatorVersion = searchVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-health-')); dirs.push(dir);
  for (const file of ['coverage-integrity.mjs', 'forge-mcp-all.mjs', 'forge-ask-all.mjs', 'forge-rerank.mjs', 'card-lane.mjs']) {
    fs.writeFileSync(path.join(dir, file), `// fixture ${file}\n`);
  }
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify({ brainVersion: searchVersion, releaseTag: `v${searchVersion}` }));
  writeInstalledRuntimeIdentity(dir, { brainVersion: validatorVersion });
  fs.writeFileSync(path.join(dir, 'ARCHIVE-MANIFEST.json'), JSON.stringify({
    kind: 'ruvnet-brain-archive-manifest', version: searchVersion,
    files: ['forge-mcp-all.mjs', 'forge-ask-all.mjs', 'forge-rerank.mjs', 'card-lane.mjs'].map(file => {
      const bytes = fs.readFileSync(path.join(dir, file));
      return { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }),
  }));
  return dir;
}
describe('installed search engine health', () => {
  it('keeps the live grounding smoke on a named repo and a bounded candidate path', () => {
    expect(DOCTOR_SMOKE_QUERY).toMatch(/RuvNet Brain KB package manifest/);
    expect(doctorSmokeArgs('/cache/kb')).toEqual([
      'forge-ask-all.mjs', '--dir', '/cache/kb', '--q', DOCTOR_SMOKE_QUERY,
      '--repos', 'ruvnet-brain', '--k', '3', '--pool', '8', '--bounded',
    ]);
  });

  it('rejects a current validator receipt around an old search engine', () => {
    const state = inspectInstalledBrain(fixture('9.9.7', '9.9.8'), '9.9.8');
    expect(state.healthy).toBe(false);
    expect(state.issues).toContain('validator runtime 9.9.8 and search engine 9.9.7 differ');
  });
  it('reports coherent source, validator and actual executable hashes', () => {
    const state = inspectInstalledBrain(fixture(), '9.9.8');
    expect(state.healthy).toBe(true);
    expect(state.searchFiles['forge-mcp-all.mjs'].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects search code drift even when all version labels remain unchanged', () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, 'forge-ask-all.mjs'), '// stale replacement');
    const state = inspectInstalledBrain(dir, '9.9.8');
    expect(state.healthy).toBe(false);
    expect(state.issues).toContain('search executable forge-ask-all.mjs differs from the installed archive manifest');
  });
  it('rejects ambiguous or missing archive identities', () => {
    const dir = fixture(); const file = path.join(dir, 'ARCHIVE-MANIFEST.json');
    const manifest = JSON.parse(fs.readFileSync(file));
    manifest.files.push(manifest.files[0]);
    fs.writeFileSync(file, JSON.stringify(manifest));
    expect(inspectInstalledBrain(dir, '9.9.8').healthy).toBe(false);
    fs.unlinkSync(file);
    expect(inspectInstalledBrain(dir, '9.9.8').healthy).toBe(false);
  });
  it('checks transitive runtime files listed by the archive, not only entrypoints', () => {
    const dir = fixture(); const file = path.join(dir, 'ARCHIVE-MANIFEST.json');
    const manifest = JSON.parse(fs.readFileSync(file));
    const body = '// approved helper';
    fs.writeFileSync(path.join(dir, 'capability-families.mjs'), body);
    manifest.files.push({ path: 'capability-families.mjs', bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
    fs.writeFileSync(file, JSON.stringify(manifest));
    expect(inspectInstalledBrain(dir, '9.9.8').healthy).toBe(true);
    fs.appendFileSync(path.join(dir, 'capability-families.mjs'), '// changed');
    expect(inspectInstalledBrain(dir, '9.9.8').issues).toContain('search executable capability-families.mjs differs from the installed archive manifest');
  });
  it('keeps corpus content addresses separate from runtime versions', () => {
    const dir = fixture(); const file = path.join(dir, 'SOURCE.json');
    const source = JSON.parse(fs.readFileSync(file)); source.corpusReleaseTag = `corpus-sha256-${'a'.repeat(64)}`;
    fs.writeFileSync(file, JSON.stringify(source));
    expect(inspectInstalledBrain(dir, '9.9.8')).toMatchObject({ healthy: true, corpusTag: source.corpusReleaseTag });
  });
  it('allows a coherent ahead-of-package development installation', () => {
    expect(inspectInstalledBrain(fixture('9.9.9'), '9.9.8').healthy).toBe(true);
  });
  it('rejects tampered validator bytes, missing search executables and missing source identity', () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, 'coverage-integrity.mjs'), '// modified');
    fs.unlinkSync(path.join(dir, 'forge-rerank.mjs'));
    fs.unlinkSync(path.join(dir, 'SOURCE.json'));
    const state = inspectInstalledBrain(dir, '9.9.8');
    expect(state.healthy).toBe(false);
    expect(state.issues.join(' ')).toMatch(/does not match its approved bytes/);
    expect(state.issues).toContain('search executable forge-rerank.mjs is missing');
    expect(state.searchVersion).toBeNull();
  });
});
describe('doctor must not treat a real citation as sufficient retrieval evidence', () => {
  it.each(['INSUFFICIENT_EVIDENCE', 'THIN'])('rejects %s even with a resolving citation', status => {
    expect(classifySmokeEvidence({ grounded: true }, `EVIDENCE: ${status} (relevance -2.66)`)).toEqual({ usable: false, reason: 'retrieval-evidence-insufficient' });
  });
  it('rejects required implementation proof that was not found', () => {
    expect(classifySmokeEvidence({ grounded: true }, 'BUILT/SHIPPED CLAIM: NOT PROVEN.').usable).toBe(false);
  });
  it('requires a verified citation independently of reassuring prose', () => {
    expect(classifySmokeEvidence({ grounded: false }, 'Everything works!').usable).toBe(false);
    expect(classifySmokeEvidence({ grounded: true }, 'path: ruvector/src/storage.rs').usable).toBe(true);
  });
});
