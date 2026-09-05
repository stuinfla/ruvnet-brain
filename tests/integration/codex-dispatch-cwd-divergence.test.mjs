import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dream Cycle 2026-09-05 — cross-host-conformance / codex-parity + stranger-project-behaviour.
 *
 * Codex's own dispatch trampoline (plugin/hooks/codex-hooks.json) never sets `cwd:` when it spawns
 * codex-hook.mjs, and codex-hook-wrapper.mjs never sets it when it spawns codex-hook-adapter.mjs
 * either. So the real OS `$PWD` every downstream hook body inherits is wherever CODEX happened to
 * launch the trampoline from — architecturally independent of the JSON payload's own `cwd` field,
 * which is the only place the real project root is carried on Codex.
 *
 * project-identity.mjs's `projectDirectory()` and learn-capture.sh's own containment check both
 * trust `CLAUDE_PROJECT_DIR` only when `$PWD` actually lies inside it (#85/#107: an unrelated
 * declared root must never overrule a cwd it does not contain). So whenever the dispatcher's real
 * cwd and the payload's declared cwd diverge — a real Codex shape, not a test artifact, which is
 * exactly why codex-hook-adapter.mjs reads `input.cwd` from the payload at all instead of trusting
 * its own `process.cwd()` — that containment check silently REJECTS the correct root and falls back
 * to the dispatcher's own directory: this plugin writes under a project it does not own (ADR-058
 * D5), and the entry meant for the real project is orphaned (same shape as #104/#134).
 *
 * `tests/integration/hook-conformance-both-hosts.test.mjs`'s `fire()` cannot see this: it always
 * spawns with `cwd:` equal to the payload's own directory (no divergence to hit), and always sets
 * `RUVNET_BRAIN_PROJECT_DIR`, which that file's own 2026-08-30 finding established production never
 * sets — either alone would make this pass by construction. This test fires the REAL
 * wrapper -> adapter -> shim chain with the two cwds deliberately different, and neither shortcut.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function installCodexSpine(brainHome) {
  const version = 'cwd-divergence';
  const codeRoot = path.join(brainHome, 'versions', version);
  fs.mkdirSync(codeRoot, { recursive: true });
  fs.cpSync(path.join(ROOT, 'plugin'), codeRoot, { recursive: true });
  fs.writeFileSync(path.join(brainHome, 'active.json'), JSON.stringify({
    generation: version, version, codeRoot: `versions/${version}`,
  }));
  fs.copyFileSync(
    path.join(ROOT, 'plugin', 'scripts', 'codex-hook-wrapper.mjs'),
    path.join(brainHome, 'codex-hook.mjs'),
  );
}

describe('Codex dispatch cwd must not leak into the project the payload actually names', () => {
  it('learn-capture writes under the payload\'s declared project, not the dispatcher\'s own OS cwd', () => {
    const dispatchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatcher-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-'));
    const brainHome = path.join(projectDir, '.conformance-home');
    installCodexSpine(brainHome);
    const payload = JSON.stringify({
      session_id: 'cwd-divergence-test',
      hook_event_name: 'PostToolUse',
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_response: { success: true },
    });
    try {
      const r = spawnSync(process.execPath, [path.join(brainHome, 'codex-hook.mjs'), 'learn-capture'], {
        // Where CODEX itself happened to launch the trampoline from — deliberately NOT the project.
        cwd: dispatchDir,
        input: payload,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
          RUVNET_BRAIN_HOME: brainHome,
          // Explicit opt-in, same signal a real project uses (learn-capture.sh's SCOPE_CONFIGURED).
          RUVNET_LEARNING_SCOPE: 'project',
          // Deliberately absent: RUVNET_BRAIN_PROJECT_DIR. Real hook dispatch never sets it on
          // either host (docs/dream-cycle/2026-08-30-cross-host-conformance-report.md); setting it
          // here would mask exactly the gap this test exists to catch.
        },
      });
      expect(r.error, `spawn failed: ${r.error?.message}`).toBeFalsy();
      expect(r.status, `learn-capture must exit 0 or 2, stderr: ${r.stderr}`).not.toBeNull();

      const inProject = fs.existsSync(path.join(projectDir, '.swarm', 'ruvnet-brain-learn'));
      const inDispatcher = fs.existsSync(path.join(dispatchDir, '.swarm'));

      expect(inDispatcher, 'must never create anything under the dispatcher\'s own directory — '
        + 'ADR-058 D5, this plugin does not own it').toBe(false);
      expect(inProject, 'must write the learning queue under the project the payload actually '
        + 'named, not wherever Codex happened to launch the trampoline from').toBe(true);
    } finally {
      fs.rmSync(dispatchDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);
});
