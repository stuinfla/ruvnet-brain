import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock, releaseLock } from '../../scripts/issue-fix-lock.mjs';
import {
  buildPrompt,
  executionPolicy,
  worktreeCleanupDecision,
} from '../../scripts/issue-fix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('issue fixer authority modes', () => {
  it('scheduled unattended mode is read-only triage with no implementation or publication authority', () => {
    expect(executionPolicy('unattended')).toEqual({
      mode: 'unattended',
      readOnlyTriage: true,
      prepareWorktree: false,
      spawnFixer: false,
      publicComment: false,
      pushBranch: false,
      promote: false,
    });
  });

  it('supervised mode may prepare a candidate but cannot publish or promote it', () => {
    expect(executionPolicy('supervised')).toEqual({
      mode: 'supervised',
      readOnlyTriage: false,
      prepareWorktree: true,
      spawnFixer: true,
      publicComment: false,
      pushBranch: false,
      promote: false,
    });
  });

  it('rejects unknown modes instead of widening authority', () => {
    expect(() => executionPolicy('autonomous')).toThrow(/unsupported issue-fix mode/i);
  });
});

describe('supervised fixer prompt has no publication authority', () => {
  it('prepares and tests only, leaving review and integration to the supervising session', () => {
    const prompt = buildPrompt({ number: 79, title: 'console lifecycle' });
    expect(prompt).toMatch(/session-supervised/i);
    expect(prompt).toMatch(/leave the worktree intact/i);
    expect(prompt).not.toMatch(/git push/i);
    expect(prompt).not.toMatch(/git commit/i);
    expect(prompt).not.toMatch(/gh issue comment/i);
    expect(prompt).not.toMatch(/post a triage comment/i);
  });
});

describe('worktree cleanup is recovery-safe', () => {
  const root = '/tmp/owned-issue-worktrees';

  it('allows cleanup only for a clean registry-owned worktree', () => {
    expect(worktreeCleanupDecision({ worktreeRoot: root, wtPath: `${root}/79-123`, dirty: false }))
      .toEqual({ remove: true, reason: 'clean-registry-owned' });
  });

  it('preserves dirty worktrees as recovery evidence', () => {
    expect(worktreeCleanupDecision({ worktreeRoot: root, wtPath: `${root}/79-123`, dirty: true }))
      .toEqual({ remove: false, reason: 'dirty-recovery-evidence' });
  });

  it('refuses cleanup outside the registry root, including prefix-confusion paths', () => {
    expect(worktreeCleanupDecision({ worktreeRoot: root, wtPath: '/tmp/owned-issue-worktrees-evil/79', dirty: false }))
      .toEqual({ remove: false, reason: 'outside-registry-root' });
    expect(worktreeCleanupDecision({ worktreeRoot: root, wtPath: '/tmp/unrelated/79', dirty: false }))
      .toEqual({ remove: false, reason: 'outside-registry-root' });
  });
});

describe('scheduled deployment is explicitly read-only', () => {
  it('launches unattended mode and describes no auto-fix/public-write behavior', () => {
    const plist = fs.readFileSync(path.join(ROOT, 'deploy/com.ruvnet.issue-fix.plist'), 'utf8');
    expect(plist).toContain('<string>--mode</string>');
    expect(plist).toContain('<string>unattended</string>');
    expect(plist).toContain('<integer>1800</integer>');
    expect(plist).toMatch(/read-only triage/i);
    expect(plist).not.toMatch(/pushes an issue-fix/i);
    expect(plist).not.toMatch(/posts an\s+honest triage comment/i);
  });

  it('the job registry matches the 30-minute read-only contract', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/scheduled-jobs.json'), 'utf8'));
    const job = registry.jobs.find((entry) => entry.label === 'com.ruvnet.issue-fix');
    expect(job.schedule).toBe('every 30 min');
    expect(job.what).toMatch(/read-only triage/i);
    expect(job.what).toMatch(/no branch push/i);
    expect(job.what).toMatch(/no public comment/i);
    expect(job.what).not.toMatch(/auto-fixes/i);
  });
});

// ── ADR-107: the autofix mode, the shared O_EXCL lock, and the delegation (added; nothing above weakened) ──
const tmps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fixlock-')); tmps.push(d); return d; };
afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop(), { recursive: true, force: true }); });
const DEAD_PID = 2_147_483_000; // far above any real pid on macOS/Linux

describe('executionPolicy: autofix (ADR-107)', () => {
  it('is exactly the frozen object, with no publish operation', () => {
    expect(executionPolicy('autofix')).toEqual({
      mode: 'autofix', readOnlyTriage: false, prepareWorktree: true, spawnFixer: true,
      publicComment: 'outcome-only', pushBranch: 'release/*', promote: 'fast-forward-main',
      dispatch: 'protected-release:code', publish: false,
    });
  });
  it("'autonomous' and unknown modes are still rejected; the other two modes did not move", () => {
    expect(() => executionPolicy('autonomous')).toThrow(/unsupported issue-fix mode: autonomous/);
    expect(() => executionPolicy('Autofix')).toThrow(/unsupported/);
    expect(executionPolicy()).toEqual(executionPolicy('unattended'));
    expect(Object.keys(executionPolicy('unattended'))).toHaveLength(7);
    expect(executionPolicy('supervised').publicComment).toBe(false);
    expect(executionPolicy('supervised').pushBranch).toBe(false);
    expect(executionPolicy('supervised').promote).toBe(false);
  });
});

describe('issue-fix-lock (O_EXCL, shared by supervised and autofix)', () => {
  it('a live holder keeps the lock; the loser learns who holds it', () => {
    const lock = path.join(tmp(), 'issue-fix.lock');
    expect(acquireLock(lock, { mode: 'autofix' })).toEqual({ acquired: true });
    const second = acquireLock(lock, { pid: process.pid + 0, mode: 'supervised' });
    expect(second.acquired).toBe(false);
    expect(second.holder).toMatchObject({ pid: process.pid, mode: 'autofix' });
  });
  it('a dead holder is reclaimed once', () => {
    const lock = path.join(tmp(), 'issue-fix.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00Z', mode: 'autofix' }));
    expect(acquireLock(lock)).toEqual({ acquired: true });
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
  });
  it('an unreadable lock file does not wedge the job forever', () => {
    const lock = path.join(tmp(), 'issue-fix.lock');
    fs.writeFileSync(lock, 'not json');
    expect(acquireLock(lock).acquired).toBe(true);
  });
  it('release removes only the caller\'s own lock', () => {
    const lock = path.join(tmp(), 'issue-fix.lock');
    acquireLock(lock);
    expect(releaseLock(lock, { pid: process.pid + 1 })).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(releaseLock(lock)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(releaseLock(lock)).toBe(false);
  });
  it('N processes racing from the same instant: exactly one wins (proves O_EXCL, not exists-then-write)', async () => {
    const lock = path.join(tmp(), 'issue-fix.lock');
    const lockModule = path.join(ROOT, 'scripts/issue-fix-lock.mjs');
    const child = `
      import { acquireLock } from ${JSON.stringify(lockModule)};
      const t = Number(process.argv[2]); while (Date.now() < t) { /* spin to a shared start instant */ }
      const r = acquireLock(${JSON.stringify(lock)});
      process.stdout.write(r.acquired ? 'WON' : 'LOST');
      if (r.acquired) await new Promise((res) => setTimeout(res, 1500)); // keep holding so no one can reclaim
    `;
    for (let round = 0; round < 5; round++) {
      fs.rmSync(lock, { force: true });
      const start = Date.now() + 1500;
      const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
        const c = spawn(process.execPath, ['--input-type=module', '-e', child, String(start)], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => resolve(out));
      })));
      expect(outs.filter((o) => o === 'WON'), `round ${round}: ${outs}`).toHaveLength(1);
    }
  }, 60_000);
});

describe('issue-fix.mjs --mode autofix delegation', () => {
  // A throwaway tree: the real issue-fix.mjs + lock + entrypoint, a stub watcher module and a STUB autofix
  // orchestrator, so this proves the wiring without ever reaching the real GitHub.
  function tree(autofixSrc) {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plugin/scripts'), { recursive: true });
    for (const f of ['issue-fix.mjs', 'issue-fix-lock.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
    fs.copyFileSync(path.join(ROOT, 'plugin/scripts/entrypoint.mjs'), path.join(root, 'plugin/scripts/entrypoint.mjs'));
    fs.writeFileSync(path.join(root, 'scripts/issue-watch.mjs'), "export const BOT_MARKER='x'; export const OWNER_LOGIN='o'; export const ghJsonWithRetry=()=>{throw new Error('no network in tests')};\n");
    if (autofixSrc) fs.writeFileSync(path.join(root, 'scripts/issue-autofix.mjs'), autofixSrc);
    return root;
  }
  const runMain = (root, args, lock) => spawnSync(process.execPath, [path.join(root, 'scripts/issue-fix.mjs'), ...args],
    { encoding: 'utf8', env: { ...process.env, HOME: root, ISSUE_FIX_LOCK: lock, GH_BIN: '/nonexistent-gh' } });
  const STUB = `import fs from 'node:fs';
    export async function main(argv) { fs.writeFileSync(process.env.ISSUE_FIX_LOCK + '.seen', JSON.stringify({ argv, lock: fs.existsSync(process.env.ISSUE_FIX_LOCK) })); return 3; }`;

  it('holds the lock while the orchestrator runs, passes argv, returns its exit code, then releases', () => {
    const root = tree(STUB); const lock = path.join(root, 'issue-fix.lock');
    const r = runMain(root, ['--mode', 'autofix', '--dry-run'], lock);
    expect(r.status).toBe(3);
    const seen = JSON.parse(fs.readFileSync(`${lock}.seen`, 'utf8'));
    expect(seen).toEqual({ argv: ['--mode', 'autofix', '--dry-run'], lock: true });
    expect(fs.existsSync(lock)).toBe(false);
  });
  it('a live holder (e.g. supervised mode) means exit 75 and the orchestrator is never started', () => {
    const root = tree(STUB); const lock = path.join(root, 'issue-fix.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 'now', mode: 'supervised' }));
    const r = runMain(root, ['--mode', 'autofix'], lock);
    expect(r.status).toBe(75);
    expect(fs.existsSync(`${lock}.seen`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid); // the holder's lock is untouched
  });
  it('a crashing orchestrator exits 1 and still releases the lock', () => {
    const root = tree('export async function main() { throw new Error("boom"); }'); const lock = path.join(root, 'issue-fix.lock');
    const r = runMain(root, ['--mode', 'autofix'], lock);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/boom/);
    expect(fs.existsSync(lock)).toBe(false);
  });
  it('a --simulate dry-run skips the lock; a plain live dry-run takes it', () => {
    const root = tree(STUB); const lock = path.join(root, 'issue-fix.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 'now', mode: 'supervised' }));
    expect(runMain(root, ['--mode', 'autofix', '--dry-run', '--simulate'], lock).status).toBe(3);
    fs.rmSync(`${lock}.seen`, { force: true });
    expect(runMain(root, ['--mode', 'autofix', '--dry-run'], lock).status).toBe(75);
  });
  it("supervised mode shares the same lock file (a live autofix holder blocks it with 75)", () => {
    const root = tree(STUB); const lock = path.join(root, 'issue-fix.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 'now', mode: 'autofix' }));
    expect(runMain(root, ['--mode', 'supervised'], lock).status).toBe(75);
  });
  it("'autonomous' is still refused by the entry point", () => {
    const root = tree(STUB);
    const r = runMain(root, ['--mode', 'autonomous'], path.join(root, 'l'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unsupported issue-fix mode/);
  });
});
