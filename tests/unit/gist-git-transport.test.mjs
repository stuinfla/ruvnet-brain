import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildGistAggregate, captureGistSources } from '../../scripts/gist-receipts.mjs';
import { buildSafeGitEnv, inspectGistGitSnapshot } from '../../scripts/gist-git-transport.mjs';
import { validateGistAggregateReceipt } from '../../scripts/coverage-integrity.mjs';
import { sealGistReceipt, sealGistReceiptSet } from '../../scripts/gist-receipts.mjs';

const id = 'a'.repeat(32);
let root;
let fixture;
let smallFixture;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-git-test-'));
  fixture = makeBareGist(301);
  smallFixture = makeBareGist(2, path.join(root, 'small'));
}, 120_000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

function makeBareGist(count, base = root) {
  const work = path.join(base, 'work');
  const bare = path.join(base, 'gist.git');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q');
  git(work, 'config', 'user.name', 'Ruv Test');
  git(work, 'config', 'user.email', 'ruv-test@example.invalid');
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(work, `file-${String(index).padStart(3, '0')}.md`), `body-${index}\n`);
  }
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'fixture snapshot');
  git(path.dirname(bare), 'clone', '-q', '--bare', work, bare);
  const headSha = git(bare, 'rev-parse', 'HEAD');
  const rawCommitSha = git(bare, 'rev-parse', 'HEAD');
  const stubFiles = {};
  for (let index = 0; index < Math.min(count, 300); index += 1) {
    const filename = `file-${String(index).padStart(3, '0')}.md`;
    const blob = git(bare, 'rev-parse', `HEAD:${filename}`);
    const body = fs.readFileSync(path.join(work, filename));
    stubFiles[filename] = { filename, size: body.length,
      raw_url: `https://gist.githubusercontent.com/ruvnet/${id}/raw/${blob}/${filename}` };
  }
  return { bare, stubFiles, headSha, rawCommitSha };
}

describe('no-token Gist Git snapshot transport', () => {
  it('strips inherited Git config and repository overrides before invoking Git', () => {
    const safe = buildSafeGitEnv({ PATH: '/usr/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.file:///tmp/.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://gist.github.com/', GIT_DIR: '/tmp/attacker.git', GIT_OBJECT_DIRECTORY: '/tmp/objects' });
    expect(safe.PATH).toBe('/usr/bin');
    expect(Object.keys(safe).some((key) => ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DIR'].includes(key)
      || key === 'GIT_OBJECT_DIRECTORY')).toBe(false);
    expect(safe.GIT_TERMINAL_PROMPT).toBe('0');
    expect(safe.GIT_CONFIG_GLOBAL).toBe(os.devNull);
  });

  it('rejects a 300-file API prefix even when Git can see the 301st file until observation enrichment is bound', () => {
    expect(() => inspectGistGitSnapshot({ owner: 'ruvnet', repository: fixture.bare,
      stub: { id, updated_at: '2026-09-19T00:00:00Z', truncated: true, files: fixture.stubFiles } }))
      .toThrow(/truncated; Git-tree enrichment is not yet bound/);
  });

  it('rejects an unflagged inventory that exceeds GitHub\'s 300-file list limit', () => {
    const moreThanLimit = { ...fixture.stubFiles, 'file-300.md': { filename: 'file-300.md', size: 9,
      raw_url: `https://gist.githubusercontent.com/ruvnet/${id}/raw/${'b'.repeat(40)}/file-300.md` } };
    expect(() => inspectGistGitSnapshot({ owner: 'ruvnet', repository: fixture.bare,
      stub: { id, updated_at: '2026-09-19T00:00:00Z', truncated: false, files: moreThanLimit } }))
      .toThrow(/more than 300 files without the truncation flag/);
  });

  it('accepts a complete non-truncated inventory only when names, sizes, raw blob IDs, and Git tree agree', () => {
    const withCommitRawRevision = { ...smallFixture.stubFiles,
      'file-000.md': { ...smallFixture.stubFiles['file-000.md'],
        raw_url: `https://gist.githubusercontent.com/ruvnet/${id}/raw/${smallFixture.rawCommitSha}/file-000.md` },
    };
    const snapshot = inspectGistGitSnapshot({ owner: 'ruvnet', repository: smallFixture.bare,
      stub: { id, updated_at: '2026-09-19T00:00:00Z', truncated: false, files: withCommitRawRevision } });
    expect(snapshot).toMatchObject({ headSha: smallFixture.headSha, treeFileCount: 2, observedFileCount: 2, observedTruncated: false });
    expect(snapshot.files[0].sourceGit).toMatchObject({ headSha: smallFixture.headSha, treeSha: snapshot.treeSha,
      treeFileCount: 2, observedFileCount: 2, observedTruncated: false, observed: true });
    expect(snapshot.files.find((file) => file.filename === 'file-000.md').sourceGit)
      .toMatchObject({ observedRawRevisionKind: 'commit', observedRawBlobSha: snapshot.files.find((file) => file.filename === 'file-000.md').blobSha });
  });

  it('fails closed when the complete inventory, size, raw blob, or raw URL does not bind to Git HEAD', () => {
    const { bare, stubFiles } = smallFixture;
    const base = { id, updated_at: '2026-09-19T00:00:00Z', truncated: false };
    expect(() => inspectGistGitSnapshot({ owner: 'ruvnet', repository: bare,
      stub: { ...base, files: { ...stubFiles, extra: { filename: 'extra', size: 1,
        raw_url: `https://gist.githubusercontent.com/ruvnet/${id}/raw/${'b'.repeat(40)}/extra` } } } }))
      .toThrow(/inventory differs/);
    const badSize = { ...stubFiles, 'file-000.md': { ...stubFiles['file-000.md'], size: 999 } };
    expect(() => inspectGistGitSnapshot({ owner: 'ruvnet', repository: bare, stub: { ...base, files: badSize } }))
      .toThrow(/size or filename differs/);
    const badUrl = { ...stubFiles, 'file-000.md': { ...stubFiles['file-000.md'], raw_url: 'https://example.invalid/file-000.md' } };
    expect(() => inspectGistGitSnapshot({ owner: 'ruvnet', repository: bare, stub: { ...base, files: badUrl } }))
      .toThrow(/raw URL is unsafe/);
  });

  it('selects Git capture without invoking REST detail or trusting a body cache', async () => {
    const stub = { id, updated_at: '2026-09-19T00:00:00Z', truncated: false, files: {
      'readme.md': { filename: 'readme.md', size: 4,
        raw_url: `https://gist.githubusercontent.com/ruvnet/${id}/raw/${'e'.repeat(40)}/readme.md` },
    } };
    const snapshot = { headSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), treeFileCount: 1,
      observedFileCount: 1, observedTruncated: false,
      files: [{ filename: 'readme.md', size: 4, body: Buffer.from('safe'), sourceGit: {
        captureMethod: 'public-bare-git-v1', revisionKind: 'git-commit', observedAt: '2026-09-19T00:00:00Z',
      sourceObservationSha256: 'f'.repeat(64),
        observedRowsSha256: (await import('../../scripts/coverage-integrity.mjs')).digest({ owner: 'ruvnet',
          observedAt: '2026-09-19T00:00:00Z', rows: [stub] }),
        headSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), treeFileCount: 1, observedFileCount: 1,
        observedTruncated: false, blobSha: 'e'.repeat(40), observed: true, observedRawBlobSha: 'e'.repeat(40),
        observedRawRevisionSha: 'e'.repeat(40), observedRawRevisionKind: 'blob',
      } }] };
    const observation = { owner: 'ruvnet', observedAt: '2026-09-19T00:00:00Z',
      observationSha256: 'f'.repeat(64), gists: { rows: [stub] } };
    const fetchGitSnapshot = vi.fn(async () => {
      if (fetchGitSnapshot.mock.calls.length > 1) throw new Error('changed observation requires live Git revalidation');
      return snapshot;
    });
    const captured = await captureGistSources({ observation, cache: { gists: { [id]: { updatedAt: stub.updated_at } } },
      fetchGitSnapshot, now: () => '2026-09-19T00:01:00Z' });
    expect(captured.reuseEvidence).toEqual({ reused: [], fetched: [id] });
    expect(captured.gists[id]).toMatchObject({ versionSha: 'c'.repeat(40), complete: true,
      files: [{ filename: 'readme.md', body: 'safe', sourceGit: { treeSha: 'd'.repeat(40) } }] });
    const output = path.join(root, 'aggregate');
    const built = await buildGistAggregate({ observation, cache: captured, outDir: output, buildVector: null,
      fetchGitSnapshot, now: () => '2026-09-19T00:02:00Z' });
    expect(fetchGitSnapshot).toHaveBeenCalledTimes(1);
    const badRow = structuredClone(built.sourceReceipt.gists[id]);
    badRow.files[0].sourceGit.observed = false;
    const malformed = sealGistReceiptSet({ ...built.sourceReceipt,
      gists: { [id]: sealGistReceipt(badRow) } });
    expect(() => validateGistAggregateReceipt({ receipt: malformed,
      passagesFile: path.join(output, 'ruv-gists.passages.jsonl') })).toThrow(/Git tree proof/);
    // A previously captured object cannot be reused if the caller mutates the raw observation rows
    // without changing its claimed top-level observation digest.
    const changedObservation = structuredClone(observation);
    changedObservation.gists.rows[0].files['readme.md'].raw_url =
      `https://gist.githubusercontent.com/ruvnet/${id}/raw/${'b'.repeat(40)}/readme.md`;
    await expect(buildGistAggregate({ observation: changedObservation, cache: captured,
      outDir: path.join(root, 'aggregate-mutated'), buildVector: null, transport: { fetchGitSnapshot },
      now: () => '2026-09-19T00:03:00Z' })).rejects.toThrow(/requires live Git revalidation/);
    expect(fetchGitSnapshot).toHaveBeenCalledTimes(2);
  });
});
