import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBash } from '../../plugin/scripts/hook-shim-bash.mjs';

/**
 * ISSUE #134 — the writer and the reader must name the SAME queue.
 *
 * `learn-capture.sh` is wired on PostToolUse, so it runs after every tool call. It anchored the queue
 * on bare `$PWD` while `learn-flush.mjs:26` and `health-repair.mjs:32` both resolve
 * `RUVNET_BRAIN_PROJECT_DIR || cwd`. Any command that left the shell below the project root — a test
 * run, a build, anything that cd's — made the writer create a queue the reader never opens, and those
 * events are orphaned rather than misfiled.
 *
 * This is #104's residual: that issue made the two halves of the FLUSH agree, and the component that
 * creates the queue was not brought along.
 *
 * The test runs the real script the way the host runs it — argv and stdin payload, no tty — because a
 * hook proven any other way is proven on a channel that cannot observe the defect.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CAPTURE = path.join(ROOT, 'plugin', 'scripts', 'learn-capture.sh');

const temps = [];
const mktemp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-root-')); temps.push(d); return d; };
const cleanup = () => temps.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

/** Fire the hook exactly as PostToolUse does: JSON on stdin, from some working directory. */
function capture({ cwd, projectDir, claudeProjectDir }) {
  const payload = JSON.stringify({
    session_id: 'issue134', hook_event_name: 'PostToolUse', cwd,
    tool_name: 'Write', tool_input: { file_path: 'a.mjs' }, tool_response: { success: true },
  });
  const env = { ...process.env, RUVNET_LEARNING_SCOPE: 'project' };
  if (projectDir) env.RUVNET_BRAIN_PROJECT_DIR = projectDir; else delete env.RUVNET_BRAIN_PROJECT_DIR;
  // Explicit, not just "absent from the ambient env": a real hook run always carries a definite
  // CLAUDE_PROJECT_DIR value or none, never "whatever this test runner's own process happened to have".
  if (claudeProjectDir) env.CLAUDE_PROJECT_DIR = claudeProjectDir; else delete env.CLAUDE_PROJECT_DIR;
  try { execFileSync(resolveBash(), [CAPTURE], { cwd, env, input: payload, stdio: 'pipe', timeout: 20_000 }); }
  catch { /* the hook fails open by design; the queue on disk is what this asserts */ }
}

const queued = (root) => {
  const dir = path.join(root, '.swarm', 'ruvnet-brain-learn');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
};

/**
 * The two behavioural cases spawn the real hook through bash. On a host with no bash the hook does
 * not run at all, so there is nothing to observe — skipped explicitly rather than left red.
 *
 * The condition is the RESOLVER, not `platform === 'win32'`. That platform check was a proxy for
 * "there is no bash here" and got it wrong in both directions: a Windows box WITH Git-for-Windows
 * can run this perfectly and was being skipped (coverage silently lost on the platform that most
 * needs it), while a stripped Linux container without bash would still have failed. Same proxy
 * mistake as reading `.claude/settings.json` to decide whether a daemon is running — ask the thing
 * that actually decides.
 */
const behavioural = resolveBash() ? describe : describe.skip;

behavioural('issue #134 — captured events land where the flush looks', () => {
  it('honours RUVNET_BRAIN_PROJECT_DIR even when the shell has drifted below the root', () => {
    const project = mktemp();
    const drifted = path.join(project, 'tests', 'fixtures');
    fs.mkdirSync(drifted, { recursive: true });

    capture({ cwd: drifted, projectDir: project, claudeProjectDir: null });

    expect(queued(project), 'the queue belongs to the project the reader will open').not.toEqual([]);
    expect(queued(drifted), 'and must NOT be stranded in whatever directory the shell happened to be in')
      .toEqual([]);
    cleanup();
  });

  it('TEETH: without the variable it still uses cwd — so the fix is the variable, not a hardcoded root', () => {
    // If this passed by pinning the queue to a git root or some other guess, the writer would have
    // stopped agreeing with the reader in the other direction. The reader's rule is
    // `RUVNET_BRAIN_PROJECT_DIR || cwd`; both halves of that rule have to match.
    const loose = mktemp();
    capture({ cwd: loose, projectDir: null, claudeProjectDir: null });
    expect(queued(loose), 'unset variable → cwd, exactly as learn-flush.mjs resolves it').not.toEqual([]);
    cleanup();
  });

  it('ISSUE #134 RESIDUAL — RUVNET_BRAIN_PROJECT_DIR is never actually set by real hook dispatch on ' +
     'either host (grep: hook-shim.mjs forwards process.env unmodified; codex-hook-adapter.mjs builds ' +
     'its own env block and never includes it), so a drifted PostToolUse cwd must still land at the ' +
     'project root via CLAUDE_PROJECT_DIR — the one project-root signal both hosts DO provide on every ' +
     'invocation (native on Claude Code; explicitly derived from input.cwd by codex-hook-adapter.mjs) ' +
     'and which this repo already trusts elsewhere for exactly this purpose (project-identity.mjs, ' +
     'session-start-core.mjs)', () => {
    const project = mktemp();
    const drifted = path.join(project, 'tests', 'fixtures');
    fs.mkdirSync(drifted, { recursive: true });

    // Real production shape: RUVNET_BRAIN_PROJECT_DIR unset (nothing sets it), CLAUDE_PROJECT_DIR set
    // (both hosts provide it), cwd drifted below the project root.
    capture({ cwd: drifted, projectDir: null, claudeProjectDir: project });

    expect(queued(project), 'CLAUDE_PROJECT_DIR must anchor the queue when the shell has drifted')
      .not.toEqual([]);
    expect(queued(drifted), 'and the event must NOT be orphaned in the drifted directory')
      .toEqual([]);
    cleanup();
  });

  it('CONTAINMENT — an unrelated CLAUDE_PROJECT_DIR that does not contain cwd must NOT overrule it ' +
     '(#85/#107: the same rule project-identity.mjs\'s projectDirectory() already enforces for the ' +
     'receipt/Console agreement, applied here rather than trusting the variable unconditionally)', () => {
    const cwd = mktemp();
    const unrelated = mktemp();

    capture({ cwd, projectDir: null, claudeProjectDir: unrelated });

    expect(queued(cwd), 'cwd is authoritative when the declared root does not contain it')
      .not.toEqual([]);
    expect(queued(unrelated), 'an unrelated declared root must never receive the queue')
      .toEqual([]);
    cleanup();
  });

});

describe('issue #134 — the invariant is pinned in source, on every platform', () => {
  it('the writer and the reader resolve the project root by the same rule, in source', () => {
    // The behavioural cases above cover today. This one fails if a future edit reintroduces the
    // asymmetry in either file — which is how #104 came back as #134 in the first place.
    const writer = fs.readFileSync(CAPTURE, 'utf8');
    const reader = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'learn-flush.mjs'), 'utf8');
    expect(writer, 'learn-capture.sh must consult the variable the flush honours')
      .toMatch(/RUVNET_BRAIN_PROJECT_DIR/);
    expect(reader).toMatch(/RUVNET_BRAIN_PROJECT_DIR/);
    expect(writer, 'and must not fall back to a bare $PWD queue path')
      .not.toMatch(/DIR="\$PWD\/\.swarm/);
  });
});
