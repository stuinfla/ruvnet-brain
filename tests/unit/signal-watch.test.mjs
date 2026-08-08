// tests/unit/signal-watch.test.mjs — ADR-058 §D3 "the external-signal watch plane" / DDD-0013
// Context 2 (SignalDebt). Two subjects, tested at the boundary that actually matters:
//
//   scripts/signal-watch.mjs        (the W2 poller — a plain maintainer dev tool, NOT a hook) is
//                                    tested by DIRECT IMPORT, same idiom as ci-verdict.test.mjs.
//   plugin/scripts/signal-watch.mjs (the W1 PostToolUse OBSERVER — a registered hook) is tested as
//                                    a SUBPROCESS fed real event JSON on stdin, same idiom as
//                                    tests/unit/hook-battery.test.mjs — "testing anything short of
//                                    the process boundary proves nothing about the real contract."
//
// The three real Bash PostToolUse envelopes used below (and the constructed exit-1 one) are the
// exact captures from tests/fixtures/signal-watch/bash-posttooluse-envelopes.json — see that file's
// _note/_uncaptured_failure_case for full provenance and the VERIFY-FIRST investigation.
//
// Red-first mutants for M-W1/M-W2/M-W3/M-W4 live in tests/mutation/signal-watch-mutation.test.mjs —
// this file is the "does it work" battery; that file is the "does it FAIL when broken" proof.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPushDebts, resolveVerdict, pollOnce, debtKey } from '../../scripts/signal-watch.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OBSERVER = path.join(REPO_ROOT, 'plugin/scripts/signal-watch.mjs');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests/fixtures/signal-watch');
const ENVELOPES = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'bash-posttooluse-envelopes.json'), 'utf8')).envelopes;

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-watch-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function writeFixture(name, content) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}

// ── scripts/signal-watch.mjs — the poller (direct import, matches ci-verdict.test.mjs) ─────────────
describe('scripts/signal-watch.mjs — resolveVerdict reuses ci-verdict.mjs\'s unknown-is-red law', () => {
  it('a success run resolves to state=resolved, conclusion=success', () => {
    const fixturePath = writeFixture('gh-success.json', [{ status: 'completed', conclusion: 'success', workflowName: 'ci' }]);
    const v = resolveVerdict({ repo: 'stuinfla/ruvnet-brain', ref: 'deadbeef' }, { fixturePath });
    expect(v.state).toBe('resolved');
    expect(v.conclusion).toBe('success');
  });

  it('a failure run resolves to state=resolved, conclusion=failure (never silently green)', () => {
    const fixturePath = writeFixture('gh-failure.json', [{ status: 'completed', conclusion: 'failure', workflowName: 'ci' }]);
    const v = resolveVerdict({ repo: 'stuinfla/ruvnet-brain', ref: 'deadbeef' }, { fixturePath });
    expect(v.state).toBe('resolved');
    expect(v.conclusion).toBe('failure');
  });

  // M-W3 core assertion: an API error / rate-limit must NEVER be invented as green. The debt stays
  // OPEN (state 'pending'), exactly DDD-0013 Context 2 invariant 1 ("UNKNOWN STAYS OPEN").
  it('M-W3: an API-error/rate-limit fixture stays state=pending — NEVER resolved as success', () => {
    const fixturePath = writeFixture('gh-ratelimit.json', { apiError: true });
    const v = resolveVerdict({ repo: 'stuinfla/ruvnet-brain', ref: 'deadbeef' }, { fixturePath });
    expect(v.state).toBe('pending');
    expect(v.state).not.toBe('resolved');
  });

  it('no run found yet for the SHA stays state=pending (CI just hasn\'t started)', () => {
    const fixturePath = writeFixture('gh-empty.json', []);
    const v = resolveVerdict({ repo: 'stuinfla/ruvnet-brain', ref: 'deadbeef' }, { fixturePath });
    expect(v.state).toBe('pending');
  });

  it('degradation: gh not installed (fixture) -> state=unverifiable with a named fix', () => {
    const fixturePath = writeFixture('gh-notinstalled.json', { notInstalled: true });
    const v = resolveVerdict({ repo: 'stuinfla/ruvnet-brain', ref: 'deadbeef' }, { fixturePath });
    expect(v.state).toBe('unverifiable');
    expect(v.reason).toMatch(/not installed/);
  });

  it('degradation: gh unauthenticated (fixture) -> state=unverifiable with a named fix', () => {
    const fixturePath = writeFixture('gh-unauth.json', { unauthenticated: true });
    const v = resolveVerdict({ repo: 'stuinfla/ruvnet-brain', ref: 'deadbeef' }, { fixturePath });
    expect(v.state).toBe('unverifiable');
    expect(v.reason).toMatch(/auth login/);
  });

  it('degradation: a REAL nonexistent gh binary (no fixture) -> state=unverifiable, no network touched', () => {
    const v = resolveVerdict({ repo: 'stuinfla/ruvnet-brain', ref: 'deadbeef' }, { ghBin: '/definitely/not/a/real/gh-binary-xyz' });
    expect(v.state).toBe('unverifiable');
    expect(v.reason).toMatch(/not installed/);
  });
});

describe('scripts/signal-watch.mjs — readPushDebts / pollOnce', () => {
  it('parses only git-push kind entries, deduped to the latest per (repo,ref)', () => {
    const pendingFile = path.join(tmp, 'pending.jsonl');
    fs.writeFileSync(pendingFile, [
      JSON.stringify({ kind: 'git-push', repo: 'a/b', ref: 'sha1', ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ kind: 'cli-exit-nonzero', tool: 'vercel', ts: '2026-01-01T00:00:01Z' }), // ignored — not a push debt
      JSON.stringify({ kind: 'git-push', repo: 'a/b', ref: 'sha1', ts: '2026-01-01T00:00:02Z' }), // dup, same key
      'not json at all', // malformed line — must never crash the poller
    ].join('\n'));
    const debts = readPushDebts(pendingFile);
    expect(debts).toHaveLength(1);
    expect(debts[0].key).toBe(debtKey('gh-ci', 'a/b', 'sha1'));
  });

  it('pollOnce writes ci-status.json and never re-resolves an already-resolved debt', () => {
    const pendingFile = path.join(tmp, 'pending.jsonl');
    const statusFile = path.join(tmp, 'ci-status.json');
    fs.writeFileSync(pendingFile, JSON.stringify({ kind: 'git-push', repo: 'a/b', ref: 'sha1' }) + '\n');
    const fixturePath = writeFixture('gh-failure2.json', [{ status: 'completed', conclusion: 'failure', workflowName: 'ci' }]);

    const status1 = pollOnce({ pendingFile, statusFile, fixturePath });
    const key = debtKey('gh-ci', 'a/b', 'sha1');
    expect(status1[key].conclusion).toBe('failure');
    const firstCheckedAt = status1[key].checkedAt;

    // Re-poll with a DIFFERENT fixture (success) — append-only: a resolved debt is never re-resolved.
    const successFixture = writeFixture('gh-success2.json', [{ status: 'completed', conclusion: 'success', workflowName: 'ci' }]);
    const status2 = pollOnce({ pendingFile, statusFile, fixturePath: successFixture });
    expect(status2[key].conclusion).toBe('failure'); // unchanged
    expect(status2[key].checkedAt).toBe(firstCheckedAt); // untouched
  });

  it('an unreadable pending.jsonl (never written yet) yields zero debts, never throws', () => {
    expect(readPushDebts(path.join(tmp, 'does-not-exist.jsonl'))).toEqual([]);
  });
});

// ── plugin/scripts/signal-watch.mjs — the PostToolUse OBSERVER (subprocess, real JSON on stdin) ────
function runObserver(envelope, { cwd = tmp, env = {} } = {}) {
  const r = spawnSync(process.execPath, [OBSERVER], {
    cwd,
    input: JSON.stringify(envelope),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, RUVNET_SIGNAL_DIR: path.join(tmp, 'signals'), ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function pendingLines(signalDir = path.join(tmp, 'signals')) {
  try { return fs.readFileSync(path.join(signalDir, 'pending.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

describe('plugin/scripts/signal-watch.mjs — PostToolUse observer (real recorded envelopes)', () => {
  it('ALWAYS exits 0 with empty stderr — advisory, never blocking', () => {
    for (const ev of ENVELOPES) {
      const out = runObserver(ev);
      expect(out.status).toBe(0);
      expect(out.stderr).toBe('');
    }
  });

  it('a real successful echo/gh-version envelope is a no-op — no debt, no advisory line', () => {
    for (const ev of ENVELOPES.filter((e) => e.tool_input.command !== 'vercel deploy --prod')) {
      const out = runObserver(ev);
      expect(out.stdout.trim()).toBe('');
    }
    expect(pendingLines()).toEqual([]);
  });

  // M-W4's fixture: the constructed (shape-verified, content-extrapolated) failing vercel envelope.
  it('M-W4: a recorded vercel-deploy exit-1 envelope appends a cli-exit-nonzero debt AND prints one advisory line', () => {
    const vercelFail = ENVELOPES.find((e) => e.tool_input.command === 'vercel deploy --prod');
    const out = runObserver(vercelFail);
    expect(out.stdout).toContain('[RuvNet Brain — external signal] vercel command failed');
    expect(out.stdout).toContain('build step failed with exit code 1');
    const lines = pendingLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'cli-exit-nonzero', tool: 'vercel' });
  });

  it('a non-Bash tool_name is a no-op regardless of command content', () => {
    const out = runObserver({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, tool_response: 'x' });
    expect(out.stdout.trim()).toBe('');
    expect(pendingLines()).toEqual([]);
  });

  it('STRUCTURAL classification: "vercel deploy" inside a commit MESSAGE (DATA, not executable position) never fires', () => {
    const ev = {
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "docs: mention vercel deploy in the changelog"' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    };
    const out = runObserver(ev);
    expect(out.stdout.trim()).toBe('');
    expect(pendingLines()).toEqual([]);
  });

  it('a SUCCESSFUL `git push` in a real git repo opens a git-push debt keyed (repo, sha)', () => {
    const repoDir = path.join(tmp, 'fake-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repoDir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/stuinfla/ruvnet-brain.git'], { cwd: repoDir });
    spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-q', '-m', 'test(signal): seed fixture'], { cwd: repoDir });
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).stdout.trim();

    const ev = {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      tool_response: { stdout: 'To github.com:stuinfla/ruvnet-brain.git\n   abc1234..def5678  main -> main', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    };
    const out = runObserver(ev, { cwd: repoDir });
    expect(out.status).toBe(0);
    const lines = pendingLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'git-push', repo: 'stuinfla/ruvnet-brain', ref: sha });
  });

  it('a FAILING `git push` opens no debt — nothing landed on origin, there is no SHA to poll a verdict for', () => {
    const repoDir = path.join(tmp, 'fake-repo-2');
    fs.mkdirSync(repoDir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repoDir });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/stuinfla/ruvnet-brain.git'], { cwd: repoDir });
    const ev = {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      tool_response: { stdout: '', stderr: '! [rejected]        main -> main (non-fast-forward)', interrupted: false, isImage: false, noOutputExpected: false },
    };
    const out = runObserver(ev, { cwd: repoDir });
    expect(out.status).toBe(0);
    expect(pendingLines()).toEqual([]);
  });
});
