// tests/unit/continuation-gate-objective-close.test.mjs — H4: the continuation objective could
// never be closed.
//
// ROOT CAUSE. `--commit-to` writes `led.objective` with `state: 'active'`, and the Stop-side
// allow-list checks `['cancelled', 'completed', 'blocked'].includes(led.objective?.state)` to decide
// whether to stay silent — but until this fix, NOTHING ever wrote one of those three states. An
// objective, once opened via `--commit-to`, forced every subsequent Stop for the rest of the
// project's life, with no way to close it short of `--clear`, which wipes every OTHER ledger item
// too (a blunt instrument for closing one objective).
//
// Every test below exercises the REAL CLI end to end — `--commit-to`, then the new
// `--complete-objective`/`--cancel-objective` verbs, then a real Stop-hook invocation — never a
// fixture-constructed ledger, matching this file's sibling continuation-gate.test.mjs's own
// "the exact gap that let a stop through in production" test (which found the SAME class of bug for
// `--commit-to` itself).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.resolve(import.meta.dirname, '../../plugin/scripts/continuation-gate.mjs');

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-gate-close-'));
  return { dir, ledger: path.join(dir, 'ledger.json') };
}

function envFor(dir, ledger) {
  return {
    ...process.env,
    RUVNET_WORK_LEDGER: ledger,
    RUVNET_CONTINUATION_COOLDOWN_MS: '0',
    RUVNET_OPEN_ISSUES_FILE: path.join(dir, 'no-such-open-issues.json'),
  };
}

function runCli(dir, env, args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [GATE, ...args], { cwd: dir, env, encoding: 'utf8' }) };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

/** Fires the real Stop hook and returns whether it forced (non-null additionalContext). */
function runStop(dir, env, sessionId = 's-cli') {
  const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, stop_hook_active: false, cwd: dir });
  let out = '';
  try { out = execFileSync(process.execPath, [GATE], { input: payload, encoding: 'utf8', cwd: dir, env }); }
  catch (e) { out = e.stdout || ''; }
  let ctx = null;
  try { ctx = JSON.parse(out).reason ?? null; } catch { /* no envelope */ }
  return { forced: ctx != null, ctx };
}

describe('--complete-objective cannot close work from prose alone', () => {
  it('a prose closure is refused and the actual Stop keeps the objective open', () => {
    const { dir, ledger } = freshDir();
    const env = envFor(dir, ledger);
    try {
      runCli(dir, env, ['--commit-to', 'ship the retry policy']);
      const before = runStop(dir, env);
      expect(before.forced, 'sanity: the committed objective must genuinely be open first').toBe(true);
      expect(before.ctx).toMatch(/ship the retry policy/);

      const complete = runCli(dir, env, ['--complete-objective', 'deployed to prod, verified via /health returning 200']);
      expect(complete.status).toBe(2);

      const after = runStop(dir, env, 's-cli-2');
      expect(after.forced, 'prose must not suppress unfinished work').toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('records state, a timestamp, and the evidence text on the objective, without touching other ledger items', () => {
    const { dir, ledger } = freshDir();
    const env = envFor(dir, ledger);
    try {
      // A plain (non-objective) ledger item, written directly, that --complete-objective must leave alone.
      fs.mkdirSync(path.dirname(ledger), { recursive: true });
      fs.writeFileSync(ledger, JSON.stringify({ items: [{ text: 'unrelated item', done: false, at: new Date().toISOString() }] }));

      runCli(dir, env, ['--commit-to', 'ship the retry policy']);
      runCli(dir, env, ['--complete-objective', 'deployed to prod, verified via /health returning 200']);

      const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      expect(led.objective.state).toBe('active');
      expect(led.objective.completionRequest).toBe('deployed to prod, verified via /health returning 200');
      expect(Number.isFinite(Date.parse(led.objective.completionRequestedAt))).toBe(true);
      // The unrelated plain item survives untouched.
      expect(led.items.some((i) => i.text === 'unrelated item' && i.done === false)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('requires evidence text — refuses an empty completion (never a silent "marked done without doing it")', () => {
    const { dir, ledger } = freshDir();
    const env = envFor(dir, ledger);
    try {
      runCli(dir, env, ['--commit-to', 'ship the retry policy']);
      const r = runCli(dir, env, ['--complete-objective']);
      expect(r.status).not.toBe(0);

      // The objective must remain active — a refused close is not a silent close.
      const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      expect(led.objective.state).toBe('active');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('whitespace-only evidence is refused the same as empty (it is not real evidence)', () => {
    const { dir, ledger } = freshDir();
    const env = envFor(dir, ledger);
    try {
      runCli(dir, env, ['--commit-to', 'ship the retry policy']);
      const r = runCli(dir, env, ['--complete-objective', '   ']);
      expect(r.status).not.toBe(0);
      const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      expect(led.objective.state).toBe('active');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('is a graceful no-op (not a crash) when there is no objective to complete', () => {
    const { dir, ledger } = freshDir();
    const env = envFor(dir, ledger);
    try {
      const r = runCli(dir, env, ['--complete-objective', 'nothing was ever committed']);
      expect(r.status).toBe(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('--cancel-objective closes an objective the real CLI opened', () => {
  it('a committed objective forces the Stop hook, then --cancel-objective silences it (RED on pre-fix code)', () => {
    const { dir, ledger } = freshDir();
    const env = envFor(dir, ledger);
    try {
      runCli(dir, env, ['--commit-to', 'migrate the legacy queue']);
      const before = runStop(dir, env);
      expect(before.forced).toBe(true);

      const cancel = runCli(dir, env, ['--cancel-objective', 'superseded by the new queue design in ADR-091']);
      expect(cancel.status).toBe(0);

      const after = runStop(dir, env, 's-cli-2');
      expect(after.forced, 'a cancelled objective must NOT force the turn to continue').toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('records state, a timestamp, and the reason text, without touching other ledger items', () => {
    const { dir, ledger } = freshDir();
    const env = envFor(dir, ledger);
    try {
      fs.mkdirSync(path.dirname(ledger), { recursive: true });
      fs.writeFileSync(ledger, JSON.stringify({ items: [{ text: 'unrelated item', done: false, at: new Date().toISOString() }] }));

      runCli(dir, env, ['--commit-to', 'migrate the legacy queue']);
      runCli(dir, env, ['--cancel-objective', 'superseded by the new queue design in ADR-091']);

      const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      expect(led.objective.state).toBe('cancelled');
      expect(led.objective.cancellationReason).toBe('superseded by the new queue design in ADR-091');
      expect(Number.isFinite(Date.parse(led.objective.cancelledAt))).toBe(true);
      expect(led.items.some((i) => i.text === 'unrelated item' && i.done === false)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('requires a reason — refuses an empty cancellation', () => {
    const { dir, ledger } = freshDir();
    const env = envFor(dir, ledger);
    try {
      runCli(dir, env, ['--commit-to', 'migrate the legacy queue']);
      const r = runCli(dir, env, ['--cancel-objective']);
      expect(r.status).not.toBe(0);
      const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      expect(led.objective.state).toBe('active');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('--help documents both new verbs', () => {
  it('lists --complete-objective and --cancel-objective', () => {
    const { dir, ledger } = freshDir();
    const env = envFor(dir, ledger);
    try {
      const r = runCli(dir, env, ['--help']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/--complete-objective/);
      expect(r.stdout).toMatch(/--cancel-objective/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
