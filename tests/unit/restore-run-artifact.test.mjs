// 4.7.26 protected-release run 41159273131: download-artifact@v4 ended the seal job's restore as a success
// with the payload incomplete, and the next step died on ENOENT for the .tgz. The restore is now proven
// complete (every manifest member present at its size) and fetched again by ID if not, before anything
// signs or publishes; the digest checks after it are unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RESTORE_ATTEMPTS, missingMembers, restoreRunArtifact } from '../../scripts/restore-run-artifact.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const MEMBERS = { 'ruvnet-brain-9.9.9.tgz': 'package bytes', 'ruvnet-brain.zip': 'bundle bytes', 'corpus-seed.json': '{}' };

function payload({ omit = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-run-artifact-')); dirs.push(dir);
  const members = Object.entries(MEMBERS).map(([name, body]) => ({ name, role: 'x', size: Buffer.byteLength(body), sha256: 'a'.repeat(64) }));
  fs.writeFileSync(path.join(dir, 'payload-manifest.json'), JSON.stringify({ schemaVersion: 1, members }));
  for (const [name, body] of Object.entries(MEMBERS)) if (!omit.includes(name)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

describe('restore-run-artifact', () => {
  it('passes a complete restore without fetching anything', async () => {
    const dir = payload();
    let fetched = 0;
    expect(await restoreRunArtifact({ name: 'verified-candidate-1', dir, fetchArtifact: async () => { fetched += 1; }, log: () => {} }))
      .toEqual({ verdict: 'PASS', refetched: 0 });
    expect(fetched).toBe(0);
  });

  it('names a missing or short member, and a missing manifest', () => {
    const dir = payload({ omit: ['ruvnet-brain-9.9.9.tgz'] });
    fs.writeFileSync(path.join(dir, 'ruvnet-brain.zip'), 'short');
    expect(missingMembers(dir)).toEqual(['ruvnet-brain-9.9.9.tgz', 'ruvnet-brain.zip']);
    fs.rmSync(path.join(dir, 'payload-manifest.json'));
    expect(missingMembers(dir)).toEqual(['payload-manifest.json']);
  });

  it('fetches the same artifact again when the restore came back without the .tgz (the 4.7.26 failure)', async () => {
    const dir = payload({ omit: ['ruvnet-brain-9.9.9.tgz'] });
    const asked = [];
    const result = await restoreRunArtifact({ name: 'verified-candidate-41159273131', dir, repo: 'o/r', runId: '41159273131', log: () => {},
      fetchArtifact: async (request) => { asked.push(request); fs.writeFileSync(path.join(dir, 'ruvnet-brain-9.9.9.tgz'), MEMBERS['ruvnet-brain-9.9.9.tgz']); } });
    expect(result).toEqual({ verdict: 'PASS', refetched: 1 });
    expect(asked).toEqual([{ repo: 'o/r', runId: '41159273131', name: 'verified-candidate-41159273131', dir }]);
  });

  it('fails after the bounded attempts, naming what is still missing, when the fetch never repairs it', async () => {
    const dir = payload({ omit: ['ruvnet-brain-9.9.9.tgz'] });
    let fetched = 0;
    await expect(restoreRunArtifact({ name: 'publisher-payload-7', dir, log: () => {},
      fetchArtifact: async () => { fetched += 1; throw new Error('HTTP 502'); } }))
      .rejects.toThrow(`publisher-payload-7 is still incomplete after ${RESTORE_ATTEMPTS} re-download(s): ruvnet-brain-9.9.9.tgz`);
    expect(fetched).toBe(RESTORE_ATTEMPTS);
  });

  it('the seal and publisher jobs prove the restore before signing or publishing; the candidate name survives a re-run', () => {
    const source = fs.readFileSync(path.join(ROOT, '.github/workflows/protected-release.yml'), 'utf8');
    const job = (name) => source.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0] || '';
    const seal = job('seal-payload');
    expect(seal.indexOf('node scripts/restore-run-artifact.mjs --name "verified-candidate-${GITHUB_RUN_ID}"')).toBeGreaterThan(seal.indexOf('Restore the verified build-once candidate payload'));
    expect(seal.indexOf('node scripts/restore-run-artifact.mjs')).toBeLessThan(seal.indexOf('node scripts/sign-bundle.mjs'));
    const publish = job('publish');
    expect(publish.indexOf('node scripts/restore-run-artifact.mjs --name "publisher-payload-${GITHUB_RUN_ID}"')).toBeGreaterThan(publish.indexOf('name: publisher-payload-${{ github.run_id }}'));
    expect(publish.indexOf('node scripts/restore-run-artifact.mjs')).toBeLessThan(publish.indexOf('node scripts/release.mjs --publish'));
    expect(source).not.toMatch(/verified-candidate-[^\n]*run_attempt/);
    expect(source.match(/name: verified-candidate-\$\{\{ github\.run_id \}\}\n/g)).toHaveLength(2);
  });
});
