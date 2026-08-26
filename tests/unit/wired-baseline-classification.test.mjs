import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { audit, hookWiringAudit } from '../../scripts/wired-check.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('the seven formerly-unclassified first-party entrypoints', () => {
  it('derives every classification from an executable manifest or gate', () => {
    const rows = new Map(audit({ repo: ROOT }).rows.map((row) => [row.base, row]));

    for (const name of ['brain-score', 'restore-local-ingests']) {
      expect(rows.get(name), name).toMatchObject({ state: 'wired' });
      expect(rows.get(name).callers, name).toContain('dream.config.json');
    }

    for (const name of ['sync-census', 'sync-commands']) {
      expect(rows.get(name), name).toMatchObject({ state: 'wired' });
      expect(rows.get(name).callers, name).toContain('scripts/git-hooks/pre-push');
    }

    expect(rows.get('rebuild-gists-from-receipts')).toMatchObject({ state: 'wired' });
    expect(rows.get('rebuild-gists-from-receipts').callers).toContain('scripts/corpus-aggregates.mjs');

    for (const name of ['card-from-source', 'release-abort-stale']) {
      expect(rows.get(name), name).toMatchObject({ state: 'manual' });
      expect(rows.get(name).callers, name).toEqual(['package.json']);
      expect(rows.get(name).why, name).toMatch(/reachable only by a human typing/i);
    }
  });

  it('derives the Codex hook chain from the shipped manifest and installer copy', () => {
    const rows = new Map(hookWiringAudit({ repo: ROOT }).rows.map((row) => [row.file, row]));
    expect(rows.get('codex-hook-wrapper.mjs')).toMatchObject({ state: 'wired' });
    expect(rows.get('codex-hook-wrapper.mjs').sources.join(' '))
      .toMatch(/plugin\/hooks\/codex-hooks\.json.*bin\/install\.mjs Stable Spine copy/i);
    expect(rows.get('codex-hook-adapter.mjs')).toMatchObject({
      state: 'wired',
      sources: ['spawned by plugin/scripts/codex-hook-wrapper.mjs'],
    });
  });

  it('labels a clean-checkout census as partial instead of claiming full agreement', () => {
    const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts/sync-census.mjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(output).toMatch(/repository and chunk\/store surfaces agree with their sources|manifest-derived repository-count surfaces agree/i);
    if (/chunk\/store census UNKNOWN/i.test(output)) {
      expect(output).not.toMatch(/all surfaces agree/i);
    } else {
      expect(output).toMatch(/builtStores=\d+/i);
    }
  });
});
