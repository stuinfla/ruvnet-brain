// doc-currency.test.mjs — the currency gate, proven against real git repositories rather than
// mocks. ADR-034 / DDD-0008.
//
// Every fixture here is a REAL `git init` with REAL commits, because every value this tool produces
// is git-derived and a mocked git proves nothing about a tool whose only job is to ask git. The
// suite is built on the pattern derived-status.test.mjs established for ADR-0024: a check that
// cannot demonstrate FAILURE has not demonstrated anything, so the known-bad fixtures are as
// load-bearing as the known-good ones.
//
// The four adversarial findings that shaped the implementation each get a test that FAILS if the
// naive version is ever restored:
//   · a missing governed path must NOT yield a stable digest  (would freeze verification green)
//   · a directory in governs: must be refused                 (would mass-expire on any sibling edit)
//   · editing the DOCUMENT must expire its verification       (would let prose drift silently)
//   · impl must take the WEAKEST governed path, never ANY     (would report wired on unwired code)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluateDoc, evaluate, listDocs, parseFrontmatter, normativeBody, resolveGoverned,
  computeDigest, deriveImpl, deriveDrift, weakest, planFix, applyFix, blockingFindings,
  changedDocumentScope, countReferents, main, IMPL_LADDER,
} from '../../scripts/doc-currency.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmps = [];
afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

// ── fixture builder ─────────────────────────────────────────────────────────────────────────────

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function newRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-currency-'));
  tmps.push(dir);
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'test@example.invalid']);
  sh(dir, 'git', ['config', 'user.name', 'Currency Fixture']);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  sh(dir, 'git', ['config', 'core.hooksPath', '/dev/null']);
  fs.mkdirSync(path.join(dir, 'docs/adr'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  return dir;
}

const write = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};

// Commits at a chosen date so drift arithmetic is deterministic rather than clock-dependent.
function commit(root, message, date = '2026-07-01T12:00:00') {
  sh(root, 'git', ['add', '-A']);
  const r = spawnSync('git', ['commit', '-q', '-m', message], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  if (r.status !== 0) throw new Error(`commit failed: ${r.stderr || r.stdout}`);
}

const adr = ({ id = 'ADR-001', status = 'Accepted', date = '2026-07-01', updated = '2026-07-01',
  governs = [], impl = null, verified = null, digest = null, body = 'Normative prose.', log = true }) => {
  const fm = ['---', `id: ${id}`, `status: ${status}`, `date: ${date}`, `updated: ${updated}`];
  if (impl) fm.push(`impl: ${impl}`);
  if (verified) fm.push(`verified: ${verified}`);
  if (digest) fm.push(`verified_digest: ${digest}`);
  if (governs.length) { fm.push('governs:'); for (const g of governs) fm.push(`  - ${g}`); }
  fm.push('---', '');
  const logSection = log
    ? ['', '## Currency log', '', '| Date | What changed | Why |', '|---|---|---|',
       `| ${updated} | Created | scripts/thing.mjs landed |`, ''].join('\n')
    : '';
  return `${fm.join('\n')}# ${id}\n\n${body}\n${logSection}`;
};

const codes = (doc) => doc.findings.map((f) => f.code);
const levelOf = (doc, code) => doc.findings.find((f) => f.code === code)?.level;

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('parsing', () => {
  it('reads scalars and list-valued governs from frontmatter', () => {
    const fm = parseFrontmatter(adr({ governs: ['scripts/a.mjs', 'scripts/b.mjs'] }));
    expect(fm.present).toBe(true);
    expect(fm.keys.status).toBe('Accepted');
    expect(fm.keys.governs).toEqual(['scripts/a.mjs', 'scripts/b.mjs']);
  });

  it('reports absent keys as ABSENT and never substitutes a neighbour', () => {
    // The measurement bug this prevents: with `updated:` missing, falling back to `date:` counts a
    // CREATION stamp as a drifted UPDATE stamp. That is how "4 of 20 stamps are wrong" was produced
    // when three of the four accused carry no `updated:` key at all.
    const text = ['---', 'id: ADR-015', 'status: Superseded', 'date: 2026-07-15', '---', '', '# x'].join('\n');
    const fm = parseFrontmatter(text);
    expect(fm.keys.date).toBe('2026-07-15');
    expect(fm.keys.updated).toBeUndefined();
  });

  it('a file with no frontmatter degrades to not-checkable instead of throwing', () => {
    const root = newRepo();
    write(root, 'docs/adr/0001-x.md', '# Just a heading\n\nNo frontmatter at all.\n');
    commit(root, 'add');
    const d = evaluateDoc(root, 'docs/adr/0001-x.md');
    expect(codes(d)).toContain('no-frontmatter');
    expect(d.impl).toBe('unknown');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('violations are detected', () => {
  let root, missingAll, missingUpdated;
  beforeAll(() => {
    root = newRepo();
    write(root, 'docs/adr/0001-nostamps.md', '---\nid: ADR-001\ntitle: t\nauthors: [x]\n---\n\n# body\n');
    write(root, 'docs/adr/0002-noupdated.md', '---\nid: ADR-002\nstatus: Accepted\ndate: 2026-07-01\n---\n\n# body\n');
    commit(root, 'add docs');
    missingAll = evaluateDoc(root, 'docs/adr/0001-nostamps.md');
    missingUpdated = evaluateDoc(root, 'docs/adr/0002-noupdated.md');
  });

  it('a doc carrying NONE of the convention keys is legacy: reported, never blocked', () => {
    // A gate whose first act is to block twelve pre-existing violations is a gate that gets
    // disabled on day one, which returns the repo to zero enforcement.
    expect(codes(missingAll)).toEqual(expect.arrayContaining(['legacy-unstamped', 'missing-status', 'missing-created', 'missing-updated']));
    expect(missingAll.findings.every((f) => f.level === 'warn')).toBe(true);
    expect(blockingFindings([missingAll])).toHaveLength(0);
  });

  it('...but --strict promotes the legacy backlog, so the debt is addressable on purpose', () => {
    expect(blockingFindings([missingAll], { strict: true }).length).toBeGreaterThan(0);
  });

  it('a doc that ADOPTED the convention and then skipped a stamp BLOCKS', () => {
    // 0002 carries status+date, so it is not grandfathered — a half-applied convention is a real
    // violation with a mechanical, seconds-long fix.
    expect(missingUpdated.legacy).toBe(false);
    expect(levelOf(missingUpdated, 'missing-updated')).toBe('block');
    expect(blockingFindings([missingUpdated]).map((f) => f.code)).toContain('missing-updated');
  });

  it('detects a stamp that lags the document\'s own last commit', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', adr({ updated: '2026-07-01' }));
    commit(r, 'create', '2026-07-01T10:00:00');
    write(r, 'docs/adr/0001-x.md', adr({ updated: '2026-07-01', body: 'Rewritten prose, stamp untouched.' }));
    commit(r, 'edit without touching the stamp', '2026-07-09T10:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(levelOf(d, 'stamp-lags-doc')).toBe('block');
    expect(d.findings.find((f) => f.code === 'stamp-lags-doc').message).toMatch(/2026-07-09/);
  });

  it('flags `Implemented` as a value invented on rUv\'s decision key', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', adr({ status: 'Implemented' }));
    commit(r, 'add', '2026-07-01T12:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(codes(d)).toContain('status-not-in-enum');
    expect(d.findings.find((f) => f.code === 'status-not-in-enum').message).toMatch(/belongs on `impl:`/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('valid documents pass', () => {
  it('a fully-stamped, in-sync document produces ZERO findings', () => {
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const thing = 1;\n');
    write(r, 'scripts/caller.mjs', "import { thing } from './scripts/thing.mjs';\nconsole.log(thing);\n");
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'], impl: 'wired' }));
    commit(r, 'everything together', '2026-07-01T12:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(d.findings).toEqual([]);
    expect(d.impl).toBe('wired');
    expect(d.drift.state).toBe('current');
  });

  it('a status with a parenthetical note is still its enum value', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', adr({ status: "Proposed (awaiting Stuart's approval)" }));
    commit(r, 'add', '2026-07-01T12:00:00');
    expect(codes(evaluateDoc(r, 'docs/adr/0001-x.md'))).not.toContain('status-not-in-enum');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('THE false-positive that would kill the gate: old ≠ stale', () => {
  it('does NOT fire on a document that is merely old while its governed code has not moved', () => {
    // DDD-0008: "This context's entire credibility rests on never flagging ADR-0021 for the crime of
    // being four days old." Age appears nowhere in the drift formula; only movement does.
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const thing = 1;\n');
    write(r, 'scripts/caller.mjs', "import './scripts/thing.mjs';\n");
    write(r, 'docs/adr/0001-old.md', adr({ governs: ['scripts/thing.mjs'], updated: '2026-01-01', date: '2026-01-01' }));
    commit(r, 'doc and code together, long ago', '2026-01-01T12:00:00');
    // Six months of unrelated churn elsewhere in the repo.
    for (let i = 0; i < 20; i++) {
      write(r, `scripts/unrelated-${i}.mjs`, `export const n = ${i};\n`);
      commit(r, `unrelated ${i}`, '2026-07-20T12:00:00');
    }
    const d = evaluateDoc(r, 'docs/adr/0001-old.md');
    expect(d.drift.state).toBe('current');
    expect(d.drift.commits).toBe(0);
    expect(codes(d)).not.toContain('presumed-stale');
    expect(codes(d)).not.toContain('lagging');
    expect(blockingFindings([d])).toHaveLength(0);
  });

  it('a document with no governed set can never be found stale (nor verified)', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-philosophy.md', adr({ governs: [] }));
    commit(r, 'add', '2026-07-01T12:00:00');
    for (let i = 0; i < 5; i++) { write(r, `scripts/x${i}.mjs`, `//${i}\n`); commit(r, `c${i}`, '2026-07-20T12:00:00'); }
    const d = evaluateDoc(r, 'docs/adr/0001-philosophy.md');
    expect(d.drift.state).toBe('not-applicable');
    expect(d.impl).toBe('unknown');
    expect(codes(d)).toContain('no-governs');
    expect(blockingFindings([d])).toHaveLength(0);
  });

  it('one same-session commit after the doc is `lagging`, and does not block', () => {
    // Writing code and updating the doc in the same session, doc first, is normal work. Blocking it
    // would make doc-editing a prerequisite for every commit.
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const a = 1;\n');
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'] }));
    commit(r, 'doc + code', '2026-07-01T09:00:00');
    write(r, 'scripts/thing.mjs', 'export const a = 2;\n');
    commit(r, 'tweak the code same day', '2026-07-01T17:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(d.drift.state).toBe('lagging');
    expect(levelOf(d, 'lagging')).toBe('warn');
    expect(blockingFindings([d])).toHaveLength(0);
  });

  it('an uncommitted document is not accused — stamp checks are suspended, not guessed', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', adr({ updated: '2026-07-01' }));
    commit(r, 'add', '2026-07-01T12:00:00');
    write(r, 'docs/adr/0001-x.md', adr({ updated: '2026-07-22', body: 'edited in the working tree' }));
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(d.dirty).toBe(true);
    expect(codes(d)).toContain('stamp-unverifiable-dirty');
    expect(codes(d)).not.toContain('stamp-lags-doc');
  });

  it('a stamp typed AHEAD of the commit warns but never blocks', () => {
    // Stamping today's date on a change not yet committed is CORRECT. Blocking it would fire the
    // gate on the act of doing the right thing.
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', adr({ updated: '2026-07-30' }));
    commit(r, 'add', '2026-07-01T12:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(levelOf(d, 'stamp-ahead-of-doc')).toBe('warn');
    expect(blockingFindings([d])).toHaveLength(0);
  });

  it('drift BLOCKS once the governed code has demonstrably moved on', () => {
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const a = 1;\n');
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'] }));
    commit(r, 'doc + code', '2026-07-01T12:00:00');
    for (let i = 0; i < 4; i++) { write(r, 'scripts/thing.mjs', `export const a = ${i + 2};\n`); commit(r, `rework ${i}`, '2026-07-15T12:00:00'); }
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(d.drift.state).toBe('presumed-stale');
    expect(d.drift.commits).toBe(4);
    expect(levelOf(d, 'presumed-stale')).toBe('block');
    // ...and --warn-drift downgrades it, for anyone who wants the ADR-034 §5 reading.
    expect(blockingFindings([d], { warnDrift: true }).map((f) => f.code)).not.toContain('presumed-stale');
  });

  // ADR-056, 2026-07-27. ADR-046 and ADR-047 are both Rejected and both sat in the blocking set,
  // with nothing an author could ever do to clear them short of deleting the record of a rejected
  // idea. A decision not in force cannot drift from code it never governed — and this file's own
  // header calls false positives the DESIGNED failure mode.
  it('a decision NOT IN FORCE cannot drift — Rejected/Superseded/Deprecated warn, never block', () => {
    for (const status of ['Rejected', 'Superseded', 'Deprecated']) {
      const r = newRepo();
      write(r, 'scripts/thing.mjs', 'export const a = 1;\n');
      write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'], status }));
      commit(r, 'doc + code', '2026-07-01T12:00:00');
      for (let i = 0; i < 4; i++) { write(r, 'scripts/thing.mjs', `export const a = ${i + 2};\n`); commit(r, `rework ${i}`, '2026-07-15T12:00:00'); }
      const d = evaluateDoc(r, 'docs/adr/0001-x.md');
      expect(d.drift.state).toBe('presumed-stale');           // the drift is still DERIVED and true
      expect(levelOf(d, 'presumed-stale')).toBe('warn');      // ...it just does not block
      expect(blockingFindings([d]).map((f) => f.code)).not.toContain('presumed-stale');
    }
  });

  it('...but an IN-FORCE decision with identical drift still BLOCKS (the exemption is narrow)', () => {
    for (const status of ['Accepted', 'Proposed']) {
      const r = newRepo();
      write(r, 'scripts/thing.mjs', 'export const a = 1;\n');
      write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'], status }));
      commit(r, 'doc + code', '2026-07-01T12:00:00');
      for (let i = 0; i < 4; i++) { write(r, 'scripts/thing.mjs', `export const a = ${i + 2};\n`); commit(r, `rework ${i}`, '2026-07-15T12:00:00'); }
      expect(levelOf(evaluateDoc(r, 'docs/adr/0001-x.md'), 'presumed-stale')).toBe('block');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('ADVERSARIAL: a missing governed path must never produce a stable digest', () => {
  it('refuses to compute a digest when a governed path does not resolve', () => {
    // The naive recipe ran `git rev-parse HEAD:<p>`, which prints the literal "HEAD:<p>" to stdout
    // and exits 128. Hashing that literal gave a digest that could NEVER change again — so renaming
    // a governed file (the commonest way a doc goes stale) froze its verification green forever.
    const r = newRepo();
    write(r, 'scripts/present.mjs', 'export const a = 1;\n');
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/present.mjs', 'scripts/GONE.mjs'] }));
    commit(r, 'add', '2026-07-01T12:00:00');

    const governed = resolveGoverned(r, ['scripts/present.mjs', 'scripts/GONE.mjs']);
    const text = fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8');
    const res = computeDigest(r, 'docs/adr/0001-x.md', text, governed);
    expect(res.digest).toBeNull();
    expect(res.reason).toMatch(/unresolvable/);
    expect(res.reason).toMatch(/GONE\.mjs/);
  });

  it('a RENAME expires the verification instead of freezing it', () => {
    const r = newRepo();
    write(r, 'scripts/old-name.mjs', 'export const a = 1;\n');
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/old-name.mjs'] }));
    commit(r, 'add', '2026-07-01T12:00:00');

    const before = computeDigest(r, 'docs/adr/0001-x.md',
      fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8'),
      resolveGoverned(r, ['scripts/old-name.mjs'])).digest;
    expect(before).toMatch(/^[0-9a-f]{12}$/);

    sh(r, 'git', ['mv', 'scripts/old-name.mjs', 'scripts/new-name.mjs']);
    commit(r, 'rename', '2026-07-02T12:00:00');

    const after = computeDigest(r, 'docs/adr/0001-x.md',
      fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8'),
      resolveGoverned(r, ['scripts/old-name.mjs']));
    expect(after.digest).toBeNull();      // NOT a stable literal-derived hash
    expect(after.digest).not.toBe(before);
  });

  it('a stamped verification over a renamed path reports expired/uncomputable, never verified', () => {
    const r = newRepo();
    write(r, 'scripts/old-name.mjs', 'export const a = 1;\n');
    write(r, 'scripts/caller.mjs', "import './scripts/old-name.mjs';\n");
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/old-name.mjs'], impl: 'verified', verified: '2026-07-01', digest: 'deadbeefcafe' }));
    commit(r, 'add', '2026-07-01T12:00:00');
    sh(r, 'git', ['mv', 'scripts/old-name.mjs', 'scripts/new-name.mjs']);
    commit(r, 'rename', '2026-07-02T12:00:00');

    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(d.impl).not.toBe('verified');
    expect(d.digest.computed).toBeNull();
    expect(codes(d)).toContain('verification-uncomputable');
    expect(levelOf(d, 'impl-overclaimed')).toBe('block');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('ADVERSARIAL: a directory in governs: is refused', () => {
  it('refuses a directory, because its tree changes when any sibling changes', () => {
    // `git cat-file --batch-check` on `HEAD:docs/adr` returns a TREE. Hashing it means every edit to
    // any of 34 ADRs expires every document governing that directory — a false-positive engine
    // firing on day one, which is precisely how a gate gets switched off.
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['docs/adr/'] }));
    write(r, 'docs/adr/0002-sibling.md', adr({ id: 'ADR-002' }));
    commit(r, 'add', '2026-07-01T12:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(levelOf(d, 'governs-directory')).toBe('block');
    expect(d.findings.find((f) => f.code === 'governs-directory').message).toMatch(/glob/);
    expect(d.digest.computed).toBeNull();
  });

  it('a glob is accepted and expands to files, so unrelated siblings are irrelevant', () => {
    const r = newRepo();
    write(r, 'scripts/a-one.mjs', 'export const a = 1;\n');
    write(r, 'scripts/a-two.mjs', 'export const b = 2;\n');
    write(r, 'scripts/unrelated.mjs', 'export const c = 3;\n');
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/a-*.mjs'] }));
    commit(r, 'add', '2026-07-01T12:00:00');

    const governed = resolveGoverned(r, ['scripts/a-*.mjs']);
    expect(governed.map((g) => g.path).sort()).toEqual(['scripts/a-one.mjs', 'scripts/a-two.mjs']);
    const text = fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8');
    const d1 = computeDigest(r, 'docs/adr/0001-x.md', text, governed).digest;

    write(r, 'scripts/unrelated.mjs', 'export const c = 999;\n');
    commit(r, 'churn an unrelated file', '2026-07-02T12:00:00');
    const d2 = computeDigest(r, 'docs/adr/0001-x.md', text, resolveGoverned(r, ['scripts/a-*.mjs'])).digest;
    expect(d2).toBe(d1);   // unrelated churn must NOT expire the verification
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('ADVERSARIAL: editing the DOCUMENT expires its verification', () => {
  it('the digest covers the document body, not only the governed code', () => {
    // Otherwise: verify today, rewrite the prose tomorrow to describe behaviour the code never had,
    // and the stamp stays green over text no verification ever read. The lie-shaped state, rebuilt
    // one level up.
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const a = 1;\n');
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'], body: 'The original normative claim.' }));
    commit(r, 'add', '2026-07-01T12:00:00');

    const governed = resolveGoverned(r, ['scripts/thing.mjs']);
    const before = computeDigest(r, 'docs/adr/0001-x.md', fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8'), governed).digest;
    const rewritten = adr({ governs: ['scripts/thing.mjs'], body: 'A COMPLETELY DIFFERENT normative claim.' });
    const after = computeDigest(r, 'docs/adr/0001-x.md', rewritten, governed).digest;
    expect(after).not.toBe(before);
  });

  it('appending the currency-log row that RECORDS a verification does not expire it', () => {
    // The log is history, not normative content. If it counted, every stamp would invalidate itself
    // in the same commit that created it.
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const a = 1;\n');
    const base = adr({ governs: ['scripts/thing.mjs'], body: 'Claim.' });
    write(r, 'docs/adr/0001-x.md', base);
    commit(r, 'add', '2026-07-01T12:00:00');
    const governed = resolveGoverned(r, ['scripts/thing.mjs']);
    const before = computeDigest(r, 'docs/adr/0001-x.md', base, governed).digest;
    const withRow = base.replace(/\| 2026-07-01 \| Created \|/, '| 2026-07-02 | Verified | scripts/thing.mjs read against §2 |\n| 2026-07-01 | Created |');
    expect(computeDigest(r, 'docs/adr/0001-x.md', withRow, governed).digest).toBe(before);
  });

  it('normativeBody strips frontmatter and the currency log, keeping the prose', () => {
    const body = normativeBody(adr({ body: 'KEEP THIS' }));
    expect(body).toMatch(/KEEP THIS/);
    expect(body).not.toMatch(/Currency log/);
    expect(body).not.toMatch(/^id:/m);
  });

  it('trailing-whitespace-only edits do not expire a verification', () => {
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const a = 1;\n');
    const base = adr({ governs: ['scripts/thing.mjs'], body: 'Claim.' });
    write(r, 'docs/adr/0001-x.md', base);
    commit(r, 'add', '2026-07-01T12:00:00');
    const governed = resolveGoverned(r, ['scripts/thing.mjs']);
    const a = computeDigest(r, 'docs/adr/0001-x.md', base, governed).digest;
    const b = computeDigest(r, 'docs/adr/0001-x.md', base.replace('Claim.', 'Claim.   '), governed).digest;
    expect(b).toBe(a);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('ADVERSARIAL: impl takes the WEAKEST governed path, never any', () => {
  it('weakest() orders the ladder and never lets one strong member carry a weak set', () => {
    expect(IMPL_LADDER).toEqual(['unknown', 'unbuilt', 'built', 'wired', 'verified']);
    expect(weakest(['wired', 'built'])).toBe('built');
    expect(weakest(['wired', 'unbuilt'])).toBe('unbuilt');
    expect(weakest(['wired', 'wired'])).toBe('wired');
  });

  it('an unwired governed path is NOT masked by a wired sibling', () => {
    // The exact L05 failure this rung exists to catch: a capability with zero call sites, plus one
    // wired helper, reported `wired` under ANY-semantics — green on the very case it was built for.
    const r = newRepo();
    write(r, 'scripts/orphan.mjs', 'export const orphan = 1;\n');           // nobody calls it
    write(r, 'scripts/helper.mjs', 'export const helper = 2;\n');
    write(r, 'scripts/app.mjs', "import { helper } from './scripts/helper.mjs';\nhelper;\n");
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/orphan.mjs', 'scripts/helper.mjs'] }));
    commit(r, 'add', '2026-07-01T12:00:00');

    const derived = deriveImpl(r, resolveGoverned(r, ['scripts/orphan.mjs', 'scripts/helper.mjs']));
    expect(derived.impl).toBe('built');
    expect(derived.unwired).toEqual(['scripts/orphan.mjs']);

    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(d.impl).toBe('built');
    expect(d.findings.find((f) => f.code === 'built-not-wired').message).toMatch(/orphan\.mjs/);
  });

  it('a governed path that does not exist yet drives `unbuilt` and does not block a Proposed doc', () => {
    // A design doc naming the artifact it intends to create is `unbuilt` working as designed.
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', adr({ status: 'Proposed', governs: ['scripts/not-yet.mjs'] }));
    commit(r, 'add', '2026-07-01T12:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(d.impl).toBe('unbuilt');
    expect(levelOf(d, 'governs-unresolvable')).toBe('warn');
    expect(blockingFindings([d])).toHaveLength(0);
  });

  it('a stored impl the artifact refutes BLOCKS; one that merely lags WARNS', () => {
    const r = newRepo();
    write(r, 'scripts/orphan.mjs', 'export const orphan = 1;\n');
    write(r, 'docs/adr/0001-over.md', adr({ governs: ['scripts/orphan.mjs'], impl: 'wired' }));
    write(r, 'docs/adr/0002-under.md', adr({ id: 'ADR-002', governs: ['scripts/orphan.mjs'], impl: 'unbuilt' }));
    commit(r, 'add', '2026-07-01T12:00:00');
    expect(levelOf(evaluateDoc(r, 'docs/adr/0001-over.md'), 'impl-overclaimed')).toBe('block');
    expect(levelOf(evaluateDoc(r, 'docs/adr/0002-under.md'), 'impl-understated')).toBe('warn');
  });

  it('impl is DERIVED — a stored value is never an input to the derivation', () => {
    // ADR-0024: "a status must be RE-DERIVED from the verifiable artifact, never read from a
    // self-asserted field."
    const r = newRepo();
    write(r, 'scripts/orphan.mjs', 'export const orphan = 1;\n');
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/orphan.mjs'], impl: 'verified', verified: '2026-07-01', digest: 'aaaaaaaaaaaa' }));
    commit(r, 'add', '2026-07-01T12:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(d.implStored).toBe('verified');
    expect(d.impl).toBe('built');          // the artifact's answer, not the file's
  });

  it('a `verified:` date with no digest is refused as a typeable stamp', () => {
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const a = 1;\n');
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'], verified: '2026-07-01' }));
    commit(r, 'add', '2026-07-01T12:00:00');
    expect(levelOf(evaluateDoc(r, 'docs/adr/0001-x.md'), 'verified-without-digest')).toBe('block');
  });

  it('a verification over an EMPTY governed set is refused', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', adr({ governs: [], verified: '2026-07-01', digest: 'aaaaaaaaaaaa' }));
    commit(r, 'add', '2026-07-01T12:00:00');
    expect(levelOf(evaluateDoc(r, 'docs/adr/0001-x.md'), 'verified-without-governs')).toBe('block');
  });

  it('a matching digest over wired code reaches `verified` — the tier is reachable, not decorative', () => {
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const thing = 1;\n');
    write(r, 'scripts/caller.mjs', "import { thing } from './scripts/thing.mjs';\nthing;\n");
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'] }));
    commit(r, 'add', '2026-07-01T12:00:00');

    const text = fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8');
    const real = computeDigest(r, 'docs/adr/0001-x.md', text, resolveGoverned(r, ['scripts/thing.mjs'])).digest;
    // Stamping changes only frontmatter, which the digest excludes — so the value stays valid.
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'], impl: 'verified', verified: '2026-07-01', digest: real }));
    commit(r, 'stamp', '2026-07-01T13:00:00');

    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(d.digest.match).toBe(true);
    expect(d.impl).toBe('verified');
    expect(blockingFindings([d])).toHaveLength(0);
  });

  it('...and the same stamp expires the moment the governed code moves', () => {
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const thing = 1;\n');
    write(r, 'scripts/caller.mjs', "import { thing } from './scripts/thing.mjs';\nthing;\n");
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'] }));
    commit(r, 'add', '2026-07-01T12:00:00');
    const text = fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8');
    const real = computeDigest(r, 'docs/adr/0001-x.md', text, resolveGoverned(r, ['scripts/thing.mjs'])).digest;
    write(r, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'], impl: 'verified', verified: '2026-07-01', digest: real }));
    commit(r, 'stamp', '2026-07-01T13:00:00');
    write(r, 'scripts/thing.mjs', 'export const thing = 42;  // changed after verification\n');
    commit(r, 'move the code', '2026-07-02T12:00:00');

    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(d.digest.match).toBe(false);
    expect(d.impl).toBe('verification-expired');
    expect(codes(d)).toContain('verification-expired');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('--fix never invents a date', () => {
  it('backfills created + updated ONLY from git, and labels both as derived', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', '---\nid: ADR-001\nstatus: Accepted\n---\n\n# body\n');
    commit(r, 'create', '2026-03-04T12:00:00');
    write(r, 'docs/adr/0001-x.md', '---\nid: ADR-001\nstatus: Accepted\n---\n\n# body\n\nmore\n');
    commit(r, 'edit', '2026-05-06T12:00:00');

    const before = evaluateDoc(r, 'docs/adr/0001-x.md');
    const plan = planFix(r, before);
    expect(plan.changes.find((c) => c.key === 'date').value).toBe('2026-03-04');   // adding commit
    expect(plan.changes.find((c) => c.key === 'updated').value).toBe('2026-05-06'); // last commit
    applyFix(r, before, plan);

    const text = fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8');
    expect(text).toMatch(/^date: 2026-03-04$/m);
    expect(text).toMatch(/^date_source: derived-from-git$/m);
    expect(text).toMatch(/^updated: 2026-05-06$/m);
    expect(text).toMatch(/^updated_source: derived-from-git$/m);

    // Every written date must actually appear in this file's git history — the anti-fabrication
    // property, asserted rather than assumed.
    const history = sh(r, 'git', ['log', '--format=%ad', '--date=short', '--', 'docs/adr/0001-x.md']).split('\n');
    for (const c of plan.changes) expect(history).toContain(c.value);
  });

  it('writes NOTHING for a document with no git history, and says so', () => {
    const r = newRepo();
    write(r, 'scripts/seed.mjs', '//\n');
    commit(r, 'seed so HEAD exists', '2026-07-01T12:00:00');
    write(r, 'docs/adr/0001-brand-new.md', '---\nid: ADR-001\nstatus: Accepted\n---\n\n# body\n');  // never committed
    const before = fs.readFileSync(path.join(r, 'docs/adr/0001-brand-new.md'), 'utf8');

    const d = evaluateDoc(r, 'docs/adr/0001-brand-new.md');
    const plan = planFix(r, d);
    expect(plan.changes).toHaveLength(0);
    expect(plan.blocked.map((b) => b.code)).toContain('no-git-history');
    expect(plan.blocked[0].why).toMatch(/none will be invented/);
    applyFix(r, d, plan);
    expect(fs.readFileSync(path.join(r, 'docs/adr/0001-brand-new.md'), 'utf8')).toBe(before);
    expect(codes(d)).toContain('no-git-history');
  });

  it('refuses to stamp `updated:` from a stale commit date while the file is dirty', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', '---\nid: ADR-001\nstatus: Accepted\ndate: 2026-07-01\n---\n\n# body\n');
    commit(r, 'add', '2026-07-01T12:00:00');
    write(r, 'docs/adr/0001-x.md', '---\nid: ADR-001\nstatus: Accepted\ndate: 2026-07-01\n---\n\n# body edited\n');
    const plan = planFix(r, evaluateDoc(r, 'docs/adr/0001-x.md'));
    expect(plan.changes.find((c) => c.key === 'updated')).toBeUndefined();
    expect(plan.blocked.map((b) => b.code)).toContain('missing-updated');
  });

  it('never writes `status:` or `impl:` — one is social, the other is derived on every read', () => {
    const r = newRepo();
    write(r, 'scripts/orphan.mjs', 'export const o = 1;\n');
    write(r, 'docs/adr/0001-x.md', '---\nid: ADR-001\ngoverns:\n  - scripts/orphan.mjs\n---\n\n# body\n');
    commit(r, 'add', '2026-07-01T12:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    const plan = planFix(r, d);
    expect(plan.changes.map((c) => c.key)).not.toContain('status');
    expect(plan.changes.map((c) => c.key)).not.toContain('impl');
    applyFix(r, d, plan);
    const text = fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8');
    expect(text).not.toMatch(/^status:/m);
    expect(text).not.toMatch(/^impl:/m);
  });

  it('is idempotent — a second run plans nothing', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', '---\nid: ADR-001\nstatus: Accepted\n---\n\n# body\n');
    commit(r, 'add', '2026-07-01T12:00:00');
    const d1 = evaluateDoc(r, 'docs/adr/0001-x.md');
    applyFix(r, d1, planFix(r, d1));
    const afterFirst = fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8');
    const d2 = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(planFix(r, d2).changes).toHaveLength(0);
    expect(fs.readFileSync(path.join(r, 'docs/adr/0001-x.md'), 'utf8')).toBe(afterFirst);
  });

  it('repairs a lagging stamp to the document\'s real last-commit date', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', adr({ updated: '2026-07-01' }));
    commit(r, 'create', '2026-07-01T10:00:00');
    write(r, 'docs/adr/0001-x.md', adr({ updated: '2026-07-01', body: 'rewritten' }));
    commit(r, 'edit', '2026-07-09T10:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    const plan = planFix(r, d);
    const upd = plan.changes.find((c) => c.key === 'updated');
    expect(upd.value).toBe('2026-07-09');
    expect(upd.replaces).toBe('2026-07-01');
    applyFix(r, d, plan);
    expect(codes(evaluateDoc(r, 'docs/adr/0001-x.md'))).not.toContain('stamp-lags-doc');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('the *why* referent check', () => {
  it('passes a why carrying a real path, an ADR id, or a resolving sha', () => {
    const r = newRepo();
    write(r, 'scripts/thing.mjs', '//\n');
    commit(r, 'add', '2026-07-01T12:00:00');
    const sha = sh(r, 'git', ['rev-parse', 'HEAD']).slice(0, 8);
    expect(countReferents(r, 'the wiring landed in scripts/thing.mjs').length).toBeGreaterThan(0);
    expect(countReferents(r, 'superseded by ADR-0024').length).toBeGreaterThan(0);
    expect(countReferents(r, `landed in ${sha}`).length).toBeGreaterThan(0);
    expect(countReferents(r, 'closes #412').length).toBeGreaterThan(0);
  });

  it('fails the empty why — the failure that actually happens', () => {
    const r = newRepo();
    write(r, 'scripts/seed.mjs', '//\n');
    commit(r, 'init', '2026-07-01T12:00:00');
    expect(countReferents(r, 'updated docs')).toHaveLength(0);
    expect(countReferents(r, 'various improvements')).toHaveLength(0);
  });

  it('a referent-free why WARNS by default and BLOCKS only under --strict', () => {
    // Judgement-shaped checks warn. A gate cannot judge sincerity and must never claim to.
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', adr({}).replace('scripts/thing.mjs landed', 'updated docs'));
    commit(r, 'add', '2026-07-01T12:00:00');
    const d = evaluateDoc(r, 'docs/adr/0001-x.md');
    expect(levelOf(d, 'why-without-referent')).toBe('warn');
    expect(blockingFindings([d], { strict: true }).map((f) => f.code)).toContain('why-without-referent');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('CLI contract', () => {
  // main() writes its report to stdout/stderr by design. Captured here so this file does not dump
  // hundreds of lines into the shared suite output — the exit CODE is what is under test.
  const quiet = (fn) => {
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try { return fn(); } finally { process.stdout.write = o; process.stderr.write = e; }
  };

  it('--check returns 0 on a clean repo and 1 on a real violation', () => {
    const clean = newRepo();
    write(clean, 'scripts/thing.mjs', 'export const t = 1;\n');
    write(clean, 'scripts/caller.mjs', "import { t } from './scripts/thing.mjs';\nt;\n");
    write(clean, 'docs/adr/0001-x.md', adr({ governs: ['scripts/thing.mjs'] }));
    commit(clean, 'add', '2026-07-01T12:00:00');
    expect(quiet(() => main(['--check', '--root', clean, '--json']))).toBe(0);

    const bad = newRepo();
    write(bad, 'docs/adr/0001-x.md', '---\nid: ADR-001\nstatus: Accepted\ndate: 2026-07-01\n---\n\n# body\n');
    commit(bad, 'add', '2026-07-01T12:00:00');
    expect(quiet(() => main(['--check', '--root', bad, '--json']))).toBe(1);
  });

  it('--check FAILS OPEN outside a git repository rather than blocking work', () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-currency-nogit-'));
    tmps.push(notRepo);
    expect(quiet(() => main(['--check', '--root', notRepo]))).toBe(0);
  });

  it('--changed follows governed paths while leaving unrelated pre-existing debt out of scope', () => {
    const r = newRepo();
    write(r, 'scripts/thing.mjs', 'export const t = 1;\n');
    write(r, 'docs/adr/0001-preexisting.md', adr({ governs: ['scripts/thing.mjs'] }));
    commit(r, 'baseline', '2026-07-01T12:00:00');
    const base = sh(r, 'git', ['rev-parse', 'HEAD']);

    for (let i = 2; i <= 5; i++) {
      write(r, 'scripts/thing.mjs', `export const t = ${i};\n`);
      commit(r, `governed change ${i}`, `2026-07-0${i}T12:00:00`);
    }

    const { docs } = evaluate(r);
    const governedScope = changedDocumentScope(docs, new Set(['scripts/thing.mjs']));
    expect(governedScope).toEqual(new Set(['docs/adr/0001-preexisting.md']));
    expect(quiet(() => main(['--check', '--root', r, '--changed', base, '--json']))).toBe(1);

    const unrelatedBase = sh(r, 'git', ['rev-parse', 'HEAD']);
    write(r, 'scripts/unrelated.mjs', '//\n');
    commit(r, 'unrelated change', '2026-07-06T12:00:00');

    expect(blockingFindings(evaluate(r).docs).length).toBeGreaterThan(0); // pre-existing debt is real
    expect(quiet(() => main(['--check', '--root', r, '--changed', unrelatedBase, '--json']))).toBe(0);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
  });

  it('--report renders every document and distinguishes absent stamps from inferred ones', () => {
    const r = newRepo();
    write(r, 'docs/adr/0001-x.md', '---\nid: ADR-001\nstatus: Accepted\ndate: 2026-07-01\n---\n\n# body\n');
    commit(r, 'add', '2026-07-01T12:00:00');
    const { docs } = evaluate(r);
    expect(docs).toHaveLength(1);
    expect(docs[0].date).toBe('2026-07-01');
    expect(docs[0].updated).toBeNull();       // absent, NOT filled in from date:
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('against the REAL repository', () => {
  it('finds this repo\'s own documents and reports honestly on them', () => {
    const docs = listDocs(REPO_ROOT);
    expect(docs.length).toBeGreaterThan(20);
    expect(docs).toContain('docs/adr/0024-derived-status-never-asserted.md');
  });

  // PREMISE RETIRED 2026-07-22 — and the retirement is the point.
  //
  // This asserted that legacy unstamped ADRs are reported and never blocked. That behaviour was
  // correct while 12 of 32 ADRs carried no frontmatter status or dates: blocking them on day one
  // would have got the gate uninstalled. scripts/adr-backfill.mjs then stamped all 22 affected
  // documents from values LIFTED out of their own bodies and DERIVED from git — nothing invented —
  // so the legacy set is now empty and the old assertion could only pass by finding a defect.
  //
  // Rewritten to pin the two properties that still matter, rather than deleted: the legacy PATH
  // must keep working (a new unstamped document must still warn, never block), and the corpus must
  // stay clean. Deleting it would have quietly removed the guarantee along with the condition.
  it('no ADR is legacy-unstamped any more — the backfill is complete and stays complete', () => {
    const d = evaluateDoc(REPO_ROOT, 'docs/adr/0009-mirror-discipline-self-audit-and-qa.md', { checkWiring: false });
    expect(d.legacy, 'this ADR was backfilled; if it reads legacy again, a stamp was lost').toBe(false);
    expect(codes(d)).not.toContain('legacy-unstamped');
  });

  it('an unstamped document still WARNS and never blocks — the legacy path must survive its own emptiness', () => {
    // The mechanism has to keep working for documents added later, or the gate becomes brittle the
    // first time someone writes a new ADR without frontmatter.
    const tmpDoc = path.join(REPO_ROOT, 'docs', 'adr', '9999-temp-unstamped-probe.md');
    fs.writeFileSync(tmpDoc, '# probe\n\nno frontmatter at all\n');
    try {
      const d = evaluateDoc(REPO_ROOT, 'docs/adr/9999-temp-unstamped-probe.md', { checkWiring: false });
      expect(blockingFindings([d]), 'an unstamped doc must never block — that is how gates get uninstalled').toHaveLength(0);
    } finally {
      fs.rmSync(tmpDoc, { force: true });
    }
  });

  it('ADR-0021 — old, no governed set — is NOT flagged stale', () => {
    // The named false positive from DDD-0008. If this ever goes red, the drift formula has
    // acquired an age term and the gate is on its way to being switched off.
    const d = evaluateDoc(REPO_ROOT, 'docs/adr/0021-shared-hook-input-parser.md', { checkWiring: false });
    expect(d.drift.state).toBe('not-applicable');
    expect(codes(d)).not.toContain('presumed-stale');
  });

  // WAS: `expect(codes(d)).toContain('stamp-lags-doc')` — it asserted ADR-0013 IS broken, and went
  // red on 2026-07-27 for the best possible reason: the lag was REPAIRED (ADR-056 §1 paid the debt
  // down, 32 blocking findings -> 2). A test that pins a defect in a specific real file has a
  // lifetime bounded by the fix, and inverts on the day the work succeeds. The BEHAVIOUR it meant
  // to protect — that a real stamp lag in this repo is detected — is covered by the synthetic
  // fixtures above, which cannot expire. What is worth asserting against the real repo is the
  // opposite and durable claim: the debt is paid and must stay paid.
  it('ADR-0013 no longer lags — the repaired state holds (was: asserted the lag existed)', () => {
    const d = evaluateDoc(REPO_ROOT, 'docs/adr/0013-onboarding-console.md', { checkWiring: false });
    if (d.dirty) return;   // mid-edit; the check is correctly suspended
    expect(codes(d)).not.toContain('stamp-lags-doc');
  });
});
