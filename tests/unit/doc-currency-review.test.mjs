import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { evaluateDoc, blockingFindings } from '../../scripts/doc-currency.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const rel = 'docs/adr/0001-review.md';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: {
  ...process.env, GIT_AUTHOR_DATE: '2026-09-05T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-05T12:00:00Z',
} });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-review-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'docs/adr'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'hooks'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'Review fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.hooksPath', path.join(root, 'hooks'));
  fs.writeFileSync(path.join(root, rel), '---\nid: ADR-001\nstatus: Proposed\ndate: 2026-09-05\nupdated: 2026-09-05\nimpl: wired\ngoverns: [scripts/thing.mjs]\n---\n# Decision\nA known unresolved claim remains disclosed.\n\n## Currency log\n\n| Date | What | Why |\n|---|---|---|\n');
  fs.writeFileSync(path.join(root, 'scripts/caller.mjs'), "import './thing.mjs';\n");
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(root, 'scripts/thing.mjs'), `export const value = ${i};\n`);
    git(root, 'add', '.'); git(root, 'commit', '-qm', `source ${i}`);
  }
  return root;
}
const read = (root) => evaluateDoc(root, rel);
const blocks = (root) => blockingFindings([read(root)]).map((finding) => finding.code);
function review(root, { row = true, source = 'scripts/thing.mjs' } = {}) {
  const digest = read(root).digest.computed;
  const file = path.join(root, rel);
  let text = fs.readFileSync(file, 'utf8').replace('impl: wired', `reviewed_digest: ${digest}\nimpl: wired`);
  if (row) text += `| 2026-09-05 | Reviewed source ${digest}; recorded limitations | ${source} examined; normative disagreement remains unresolved. |\n`;
  fs.writeFileSync(file, text);
  return digest;
}

describe('source-bound review is not verification or acceptance', () => {
  it('clears only stale-review inference before commit, retaining drift and unresolved claims', () => {
    const root = fixture();
    expect(blocks(root)).toContain('presumed-stale');
    const digest = review(root);
    const doc = read(root);
    expect(doc.dirty).toBe(true);
    expect(doc.drift.state).toBe('presumed-stale');
    expect(doc.drift.commits).toBe(2);
    expect(blocks(root)).not.toContain('presumed-stale');
    expect(doc.review).toMatchObject({ stored: digest, match: true, recorded: true });
    expect(doc.impl).toBe('wired');
    expect(doc.status).toBe('Proposed');
    expect(doc.verifiedDigestStored).toBeNull();
    expect(fs.readFileSync(path.join(root, rel), 'utf8')).toContain('known unresolved claim');
  });
  it.each(['unstaged', 'staged', 'document'])('expires review after %s changes', (kind) => {
    const root = fixture(); review(root);
    if (kind === 'document') fs.appendFileSync(path.join(root, rel), '\n## New normative claim\nChanged behavior.\n');
    else {
      fs.appendFileSync(path.join(root, 'scripts/thing.mjs'), '// changed bytes\n');
      if (kind === 'staged') git(root, 'add', 'scripts/thing.mjs');
    }
    expect(blocks(root)).toContain('presumed-stale');
    expect(read(root).review.match).toBe(false);
  });
  it.each(['absent', 'unrelated'])('does not accept a digest with %s review evidence', (kind) => {
    const root = fixture();
    review(root, { row: kind !== 'absent', source: 'scripts/caller.mjs' });
    expect(blocks(root)).toContain('presumed-stale');
  });
  it('does not hide an implementation overclaim', () => {
    const root = fixture(); review(root);
    const file = path.join(root, rel);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('impl: wired', 'impl: verified'));
    expect(blocks(root)).toContain('impl-overclaimed');
  });
  it('does not treat a dirty date or prose edit as a source-bound review', () => {
    const root = fixture();
    fs.appendFileSync(path.join(root, rel), '| 2026-09-05 | Reviewed source | scripts/thing.mjs examined, but no byte binding recorded. |\n');
    expect(read(root).dirty).toBe(true);
    expect(blocks(root)).toContain('presumed-stale');
  });
  it('does not retain review when governed bytes become unavailable', () => {
    const root = fixture(); review(root);
    fs.unlinkSync(path.join(root, 'scripts/thing.mjs'));
    expect(read(root).review).toMatchObject({ computed: null, current: false });
    expect(blocks(root)).toContain('impl-overclaimed');
  });
  it('rejects malformed bindings and a generic non-review currency row', () => {
    const root = fixture(); review(root);
    const file = path.join(root, rel);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('Reviewed source', 'Updated source'));
    expect(blocks(root)).toContain('presumed-stale');
    fs.writeFileSync(file, original.replace(/reviewed_digest: .+/, 'reviewed_digest: guessed'));
    expect(blocks(root)).toContain('presumed-stale');
  });
  it('preserves existing verified_digest identities when review metadata is added', () => {
    const root = fixture();
    const before = read(root).digest.computed;
    const file = path.join(root, rel);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('impl: wired', `verified_digest: ${before}\nimpl: wired`));
    review(root);
    expect(read(root).digest).toMatchObject({ computed: before, stored: before, match: true });
  });
});
