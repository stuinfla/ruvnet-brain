import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
