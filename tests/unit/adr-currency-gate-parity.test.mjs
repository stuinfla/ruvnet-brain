import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as docCurrency from '../../scripts/doc-currency.mjs';
import { staleGovernorsOf } from '../../plugin/scripts/adr-currency-gate.mjs';

const roots = [];
const DOC = 'docs/adr/0099-parity.md';
const TARGET = 'scripts/thing.mjs';
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function fixture({ governs, status = 'Accepted' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-gate-parity-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'docs/adr'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'ADR Gate Test');
  git('config', 'user.email', 'adr-gate@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, DOC), `---\nid: ADR-099\nstatus: ${status}\n` +
    `date: 2026-07-01\nupdated: 2026-07-01\n${governs}\n---\n\n# Decision\nKeep source honest.\n`);
  for (let round = 0; round < 3; round++) {
    fs.writeFileSync(path.join(root, TARGET), `export const value = ${round};\n`);
    fs.writeFileSync(path.join(root, 'other.mjs'), `export const other = ${round};\n`);
    git('add', '.');
    const date = `2026-07-0${round + 1}T12:00:00Z`;
    execFileSync('git', ['commit', '-qm', `round ${round}`], { cwd: root, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  }
  return root;
}

describe('ADR edit gate matches canonical document-currency policy on real Git history', () => {
  it.each([
    ['scalar', `governs: ${TARGET}`],
    ['list', `governs:\n  - ${TARGET}`],
    ['glob', 'governs: scripts/*.mjs'],
    ['glob list', 'governs:\n  - scripts/*.mjs'],
  ])('%s declarations use the shared exact governed set and blocking explanation', async (_label, governs) => {
    const root = fixture({ governs });
    const document = docCurrency.evaluateDoc(root, DOC);
    const findings = docCurrency.blockingFindings([document]).filter((f) => f.code === 'presumed-stale');
    expect(findings).toHaveLength(1);
    expect(document.governed.some((g) => g.resolved && g.path === TARGET)).toBe(true);
    expect(await staleGovernorsOf(TARGET, { root, docCurrency })).toEqual([
      { doc: DOC, id: 'ADR-099', why: findings[0].message },
    ]);
    expect(await staleGovernorsOf('scripts/thing.mjs/child', { root, docCurrency })).toEqual([]);
    expect(await staleGovernorsOf('scripts-other/thing.mjs', { root, docCurrency })).toEqual([]);
  });

  it.each(['Superseded', 'Superseded (replaced by ADR-100)', 'Deprecated', 'Rejected'])(
    '%s retains the shared warning without blocking an edit', async (status) => {
      const root = fixture({ status, governs: `governs:\n  - ${TARGET}` });
      const document = docCurrency.evaluateDoc(root, DOC);
      expect(document.drift.state).toBe('presumed-stale');
      expect(document.findings.find((f) => f.code === 'presumed-stale').level).toBe('warn');
      expect(docCurrency.blockingFindings([document]).some((f) => f.code === 'presumed-stale')).toBe(false);
      expect(await staleGovernorsOf(TARGET, { root, docCurrency })).toEqual([]);
    });

  it('does not turn a directory into governors of its children when another governed file is stale', async () => {
    const root = fixture({ governs: 'governs:\n  - scripts/\n  - other.mjs' });
    const document = docCurrency.evaluateDoc(root, DOC);
    expect(document.findings.some((f) => f.code === 'governs-directory')).toBe(true);
    expect(document.drift.state).toBe('presumed-stale');
    expect(await staleGovernorsOf(TARGET, { root, docCurrency })).toEqual([]);
    expect(await staleGovernorsOf('other.mjs', { root, docCurrency })).toHaveLength(1);
  });
});
