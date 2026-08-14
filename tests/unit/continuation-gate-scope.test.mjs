// continuation-gate-scope.test.mjs — the derived sources may only speak about THIS repository.
//
// THE DEFECT, found by two independent audits and hit LIVE mid-audit by one of them, which refused
// the forced continuation as "unauthorized scope expansion presented as a prior commitment".
//
// The work ledger has been partitioned per project since it was written, with a comment saying
// exactly why: a commitment made in one repo must never fire in another. Every artifact-derived
// source added afterwards — breached issues, red CI, open PRs, security alerts — read a
// MACHINE-GLOBAL file under ~/.cache/ruvnet-brain with no such partition. The explicit half was
// scoped; the derived half, which is the half that is always populated, was not.
//
// MEASURED before the fix, in a fresh git repo whose remote is someone-else/totally-unrelated, with
// an EMPTY ledger:
//   {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"You have unfinished work you
//    committed to. … ☐ PR #137 on stuinfla/ruvnet-brain is RED …"}}
// `additionalContext` at Stop CONTINUES THE TURN, so a stranger's every turn-end was forced with
// orders to go fix another repository's pull requests — and told they had agreed to it.
//
// The forensic trail was already on the developer's disk: work-ledgers/AppealArmor.json holds ZERO
// items, yet AppealArmor.json.cooldown exists, and that lock is written ONLY on the path that
// forces. Same for Ruv-Explainer, T, verify-prod and notgit.
//
// EVERY CASE BELOW RUNS THE REAL GATE IN A REAL GIT REPO, because the bug lives in the relationship
// between the working tree and a machine-global file — a mocked cwd could not have caught it, which
// is precisely why the existing suite (all of it running inside this repo) did not.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = path.join(ROOT, 'plugin', 'scripts', 'continuation-gate.mjs');
const OURS = 'stuinfla/ruvnet-brain';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scope-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A real git repo with a real remote — `git remote add`, not a hand-written config, so the parser
 *  is tested against what git actually writes rather than against this file's idea of it. */
function repoWithRemote(name, url) {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: d, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git('init', '-q');
  if (url) git('remote', 'add', 'origin', url);
  return d;
}

/** The artifact the issue-watch pipeline writes: breached issue + mergeable PR + critical alert. */
function openIssues({ repo = OURS, atMs = Date.now() } = {}) {
  const file = path.join(dir, `open-issues-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    at: new Date(atMs).toISOString(), repo, open: 1, breaches: 1,
    issues: [{ number: 139, title: 'a real breach', ageHours: 17, breach: true }],
    prs: [{ number: 137, title: 'bump the root-npm group', checksState: 'passing', failing: 0 }],
    securityAlerts: [{ kind: 'dependabot', severity: 'critical', title: 'lodash: prototype pollution' }],
  }));
  return file;
}

/** The artifact signal-watch writes. Deliberately MIXED-REPO, exactly as the real one is on the
 *  developer's machine: a stuinfla/ruvnet-brain row and a stuinfla/AppealArmor row side by side. */
function ciStatus(rows) {
  const file = path.join(dir, `ci-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(rows.map((r, i) => [String(i), {
    state: 'resolved', conclusion: 'failure', workflowName: 'ci',
    ref: 'abc1234', checkedAt: new Date().toISOString(), ...r,
  }]))));
  return file;
}

/** Fire the gate the way Claude Code does, FROM a given working directory. */
function fire(cwd, { issues, ci, ledger } = {}) {
  const ledgerPath = ledger ?? path.join(dir, `ledger-${Math.random().toString(16).slice(2)}.json`);
  const r = spawnSync(process.execPath, [GATE], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'scope-test' }),
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      RUVNET_WORK_LEDGER: ledgerPath,
      RUVNET_OPEN_ISSUES_FILE: issues ?? path.join(dir, 'no-issues.json'),
      RUVNET_CI_STATUS_FILE: ci ?? path.join(dir, 'no-ci.json'),
      RUVNET_CONTINUATION_COOLDOWN_MS: '0',
    },
  });
  let context = '';
  try { context = JSON.parse(r.stdout || '{}')?.hookSpecificOutput?.additionalContext || ''; } catch { /* no envelope */ }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', context, ledgerPath };
}

describe('continuation gate — derived work never leaves the repository it belongs to', () => {
  it('THE REGRESSION: a populated backlog + a Stop from a DIFFERENT repo → empty stdout, exit 0', () => {
    // The acceptance case, in the exact shape that was observed forcing turns in other projects.
    const stranger = repoWithRemote('stranger', 'https://github.com/someone-else/totally-unrelated.git');
    const r = fire(stranger, {
      issues: openIssues(),
      ci: ciStatus([{ repo: OURS, workflowName: 'ci' }]),
    });
    expect(r.stdout, 'this repo\'s GitHub debt must not reach a project that never heard of it').toBe('');
    expect(r.status, 'the gate must always fail open').toBe(0);
    expect(r.stderr).toBe('');
    // The cooldown lock is written ONLY on the forcing path — its absence is independent proof that
    // no force happened, not merely that nothing was printed.
    expect(fs.existsSync(`${r.ledgerPath}.cooldown`), 'a lock file means it forced').toBe(false);
  });

  it('NOT VACUOUS: the identical artifacts DO force when fired from the repo they describe', () => {
    // Without this, the case above would pass just as well against a gate that had been broken into
    // permanent silence — which is the other failure this file has to be able to see.
    const ours = repoWithRemote('ours', `https://github.com/${OURS}.git`);
    const r = fire(ours, { issues: openIssues(), ci: ciStatus([{ repo: OURS }]) });
    expect(r.status).toBe(0);
    expect(r.context).toContain('issue #139');
    expect(r.context).toContain('PR #137');
    expect(r.context).toContain('CI is RED');
    expect(r.context).toContain('dependabot alert');
    expect(r.context).toContain('Do NOT end the turn');
  });

  it('a mixed-repo CI artifact yields ONLY the rows for this repository', () => {
    // The real ci-status.json on the developer's machine holds rows for several repos at once, so
    // this source has to be filtered per ENTRY, not per file.
    const ours = repoWithRemote('ours', `https://github.com/${OURS}.git`);
    const r = fire(ours, {
      ci: ciStatus([
        { repo: OURS, workflowName: 'ci' },
        { repo: 'stuinfla/AppealArmor', workflowName: 'Regression Tests' },
        { repo: 'someone-else/unrelated', workflowName: 'deploy' },
      ]),
    });
    expect(r.context).toContain('CI is RED on stuinfla/ruvnet-brain');
    expect(r.context).not.toContain('AppealArmor');
    expect(r.context).not.toContain('someone-else');
  });

  it('every URL form of the same repository is recognised as ours', () => {
    for (const url of [
      `git@github.com:${OURS}.git`,          // ssh
      `https://github.com/${OURS}`,          // no .git suffix
      `https://github.com/StuInfla/RuvNet-Brain.git`, // GitHub slugs are case-insensitive
      `ssh://git@github.com/${OURS}.git`,    // ssh:// scheme
    ]) {
      const d = repoWithRemote(`form-${Math.random().toString(16).slice(2)}`, url);
      expect(fire(d, { issues: openIssues() }).context, url).toContain('issue #139');
    }
  });

  it('a linked worktree (.git is a FILE) still resolves its remotes', () => {
    // `.git` as a file naming a gitdir is the worktree/submodule shape. Reading it wrong would make
    // the gate silently own nothing there — a silent regression, the kind this project keeps hitting.
    const ours = repoWithRemote('wt-main', `https://github.com/${OURS}.git`);
    const linked = path.join(dir, 'wt-linked');
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.join(ours, '.git')}\n`);
    expect(fire(linked, { issues: openIssues() }).context).toContain('issue #139');
  });
});

describe('continuation gate — when ownership cannot be proved, it says nothing', () => {
  it('a directory that is not a git repo at all → silent', () => {
    const plain = path.join(dir, 'not-git');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'index.js'), '// somebody else\n');
    const r = fire(plain, { issues: openIssues(), ci: ciStatus([{ repo: OURS }]) });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });

  it('a git repo with NO remote → silent: unprovable is not the same as ours', () => {
    const r = fire(repoWithRemote('no-remote', null), { issues: openIssues() });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });

  it('an artifact with no repo field at all → silent', () => {
    const ours = repoWithRemote('ours', `https://github.com/${OURS}.git`);
    const file = path.join(dir, 'no-repo-field.json');
    fs.writeFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      issues: [{ number: 1, title: 'unattributable', ageHours: 9, breach: true }],
    }));
    expect(fire(ours, { issues: file }).stdout).toBe('');
  });
});

describe('continuation gate — the work ledger is NOT weakened by any of this', () => {
  it('a REAL commitment still forces in a stranger repo — that ledger is that project\'s own', () => {
    // The standing rule is "do not stop until it is done", and a previous fix already broke it once
    // by silently disabling the gate on a timer. Scoping the DERIVED sources must not cost the
    // explicit ones a single case: a commitment recorded here belongs here, whatever the remote is.
    const stranger = repoWithRemote('stranger', 'https://github.com/someone-else/totally-unrelated.git');
    const ledger = path.join(dir, 'their-ledger.json');
    fs.writeFileSync(ledger, JSON.stringify({
      items: [{ text: 'finish their migration', done: false, at: new Date(Date.now() - 3 * 3600_000).toISOString() }],
    }));
    const r = fire(stranger, { issues: openIssues(), ci: ciStatus([{ repo: OURS }]), ledger });
    expect(r.context).toContain('finish their migration');
    expect(r.context).toContain('You have unfinished work you committed to');
    // …and STILL nothing of ours leaks in alongside it.
    expect(r.context).not.toContain('ruvnet-brain');
    expect(r.context).not.toContain('#139');
    expect(r.context).not.toContain('#137');
  });
});

describe('continuation gate — a derived item is never called a commitment', () => {
  it('a derived-only envelope does not claim the reader agreed to anything', () => {
    // GPT-5.6-Sol's verdict on the live hit was not only about scope: it was "presented as a prior
    // commitment". Nobody promised Dependabot's PR. Under a gate that forces the turn to continue,
    // asserting an agreement that was never made manufactures the obligation it then enforces.
    const ours = repoWithRemote('ours', `https://github.com/${OURS}.git`);
    const r = fire(ours, { issues: openIssues({ atMs: Date.now() - 3 * 3600_000 }) });
    expect(r.context).not.toMatch(/You have unfinished work you committed to/);
    expect(r.context, 'a watcher OBSERVED this; it was not committed to').not.toMatch(/\(committed \d+[hd] ago/);
    expect(r.context).toMatch(/observed 3h ago/);
    expect(r.context).toContain('NOT something you');
    expect(r.context).toContain('Do NOT end the turn');       // the force itself is unchanged
    // --done is a ledger verb. Offering it here would offer a way to mark a red build finished.
    expect(r.context).not.toContain('--done');
  });

  it('a ledger item keeps the committed wording, and a mixed envelope names both halves', () => {
    const ours = repoWithRemote('ours', `https://github.com/${OURS}.git`);
    const ledger = path.join(dir, 'mixed.json');
    fs.writeFileSync(ledger, JSON.stringify({
      items: [{ text: 'ship the thing', done: false, at: new Date(Date.now() - 2 * 3600_000).toISOString() }],
    }));
    const only = fire(ours, { ledger });
    expect(only.context).toMatch(/You have unfinished work you committed to/);
    expect(only.context).toMatch(/\(committed 2h ago\)/);
    expect(only.context).toContain('--done');

    const mixed = fire(ours, { ledger, issues: openIssues() });
    expect(mixed.context).toMatch(/you committed to, and stuinfla\/ruvnet-brain has open work of its own/);
    expect(mixed.context).toContain('ship the thing');
    expect(mixed.context).toContain('issue #139');
  });
});
