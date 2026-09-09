import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
      expect(rows.get(name), name).toMatchObject({ state: 'exempt' });
      expect(rows.get(name).why, name).toMatch(/explicit maintainer/i);
    }

    expect(rows.get('rebuild-gists-from-receipts')).toMatchObject({ state: 'wired' });
    expect(rows.get('rebuild-gists-from-receipts').callers).toContain('scripts/corpus-aggregates.mjs');

    for (const name of ['card-from-source', 'release-abort-stale']) {
      expect(rows.get(name), name).toMatchObject({ state: 'manual' });
      expect(rows.get(name).callers, name).toEqual(['package.json']);
      expect(rows.get(name).why, name).toMatch(/reachable only by a human typing/i);
    }
  });

  it('classifies the active Codex hook chain as wired', () => {
    const rows = new Map(hookWiringAudit({ repo: ROOT }).rows.map((row) => [row.file, row]));
    expect(rows.get('codex-hook-wrapper.mjs')).toMatchObject({ state: 'wired' });
    expect(rows.get('codex-hook-adapter.mjs')).toMatchObject({ state: 'wired' });
  });

  it('labels a clean-checkout census as partial instead of claiming full agreement', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/sync-census.mjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/repository and chunk\/store surfaces agree with their sources|manifest-derived repository-count surfaces agree|DRIFT/i);
    if (/chunk\/store census UNKNOWN|DRIFT/i.test(output)) {
      expect(output).not.toMatch(/all surfaces agree/i);
    } else {
      expect(output).toMatch(/builtStores=\d+/i);
    }
  });
});
