import { describe, expect, it } from 'vitest';
import { captureGistSources } from '../../scripts/gist-receipts.mjs';

const live = process.env.RUN_PUBLIC_GIST_GIT_TEST === '1';

describe('public no-key gist Git capture', () => {
  it.skipIf(!live)('captures a live multi-file gist whose observed raw revisions are per-file blobs', async () => {
    const id = '1afab76a2b67161b7bd1fbdd8930b408';
    const response = await fetch(`https://api.github.com/gists/${id}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ruvnet-brain-public-gist-capture-test' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`public fixture lookup failed: HTTP ${response.status}`);
    const gist = await response.json();
    expect(gist.owner.login).toBe('ruvnet');
    expect(Object.keys(gist.files)).toContain('1-research.md');
    expect(Object.keys(gist.files)).toContain('notebook.ipynb');
    const captured = await captureGistSources({ observation: { owner: gist.owner.login,
      observedAt: new Date().toISOString(), observationSha256: 'e'.repeat(64), gists: { rows: [gist] } },
    signal: AbortSignal.timeout(180_000) });
    const capturedGist = captured.gists[id];
    expect(capturedGist.versionSha).toMatch(/^[a-f0-9]{40}$/);
    expect(capturedGist.files.map(({ filename }) => filename)).toEqual(['1-research.md', 'notebook.ipynb']);
    expect(capturedGist.files.every((file) => file.sourceGit.observed
      && file.sourceGit.blobSha === file.sourceGit.observedRawBlobSha)).toBe(true);
    expect(capturedGist.files[0].included).toBe(true);
    expect(capturedGist.files[1].included).toBe(false);
    expect(capturedGist.history).toBeUndefined();
  }, 240_000);
});
