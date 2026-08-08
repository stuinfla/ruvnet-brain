// host-install-matrix.mjs — ONE definition of "install this artifact into clean hosts and judge it".
//
// WHY THIS EXISTS. Two harnesses did this same job and disagreed about almost everything:
//
//   scripts/staged-host-verifier.mjs        scripts/publication-receipt.mjs (installHosts)
//   ─────────────────────────────────       ────────────────────────────────────────────────
//   modes: claude / codex / dual            modes: claudeOnly / codexOnly / dual
//   --local … --no-selfcheck                --version v<X>  (no --local, selfcheck ON)
//   RUVNET_CLAUDE_MARKETPLACE_SOURCE        RUVNET_STRICT_INSTALL=1
//   RUVNET_CODEX_HOOK_TRUST_MODE=bypass     RUVNET_BRAIN_PROFILE=complete
//
// They could not even be compared: one produced `fixtures.claude`, the other `hosts.claudeOnly`,
// for the identical fixture. So "the hosts passed" meant two different things depending on which
// half of the release you asked, and nothing in the system could notice they had drifted apart.
//
// Some of that difference is REAL and must survive: a STAGED check runs before publication against
// local bytes, so it points the marketplace at the unpacked package and skips selfcheck; a
// PUBLISHED check runs after, against what npm actually serves, so it resolves by version and
// installs strictly. That is one axis with two values — a parameter. Everything else was accident.
//
// So: the modes are named once, the loop is written once, the verdict is classified once, and the
// only thing a caller chooses is which VARIANT it is running. Same shape as
// scripts/console-runtime-identity.mjs, where one enumeration serves both the copy list and the
// digest — a fact stated once cannot drift from itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** The three host shapes a release must survive. ONE name each, for every consumer. */
export const HOST_MODES = Object.freeze(['claude', 'codex', 'dual']);

/** Which CLIs each mode is allowed to see. A codex-only box genuinely has no `claude`. */
export const MODE_HOSTS = Object.freeze({
  claude: ['claude'],
  codex: ['codex'],
  dual: ['claude', 'codex'],
});

/**
 * The published-side receipt has always spelled these `claudeOnly` / `codexOnly` / `dual`, and that
 * name is baked into current-release.json and every receipt already published — renaming it would
 * invalidate history for a cosmetic win. So the two spellings are reconciled HERE, once, instead of
 * being silently different in two files. `publication.installed.claudeOnly` and `fixtures.claude`
 * are now provably the same fixture, which is what made the two halves of a release incomparable.
 */
export const RECEIPT_MODE_NAMES = Object.freeze({ claude: 'claudeOnly', codex: 'codexOnly', dual: 'dual' });
export const MODE_FROM_RECEIPT_NAME = Object.freeze({ claudeOnly: 'claude', codexOnly: 'codex', dual: 'dual' });

/**
 * The two genuinely different questions, declared once instead of implied by two files.
 *
 * `staged`    — before publication, against local bytes. The marketplace is pointed at the unpacked
 *               package because nothing is on npm yet, and selfcheck is skipped for the same reason.
 * `published` — after publication, against what npm actually serves. Resolves by version and
 *               installs strictly, because this is the run that must match a stranger's machine.
 */
export const VARIANTS = Object.freeze({
  staged: Object.freeze({
    installerArgs: (_v) => ['--local', '--yes', '--force', '--no-nightly-prompt',
      '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline', '--no-selfcheck'],
    env: ({ packageRoot }) => ({
      RUVNET_CLAUDE_MARKETPLACE_SOURCE: packageRoot,
      RUVNET_CODEX_HOOK_TRUST_MODE: 'bypass',
    }),
  }),
  published: Object.freeze({
    installerArgs: (version) => ['--yes', '--force', '--version', `v${version}`, '--no-nightly-prompt',
      '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline'],
    env: () => ({
      RUVNET_STRICT_INSTALL: '1',
      RUVNET_BRAIN_PROFILE: 'complete',
      // A VIRGIN AUTOMATED HOME CAN NEVER HAVE RECORDED CODEX HOOK TRUST (fixed 2026-08-08).
      //
      // The staged variant above has carried this since it was written; the published variant did
      // not, and that asymmetry failed the post-publication seal on EVERY release. The doctor ran
      // green on everything that matters — "✓ Healthy", "✓ Grounding PROVEN", "✓ Self-check passed",
      // 17 hook registrations across 68 firings — and then exited non-zero on the one condition a
      // fixture cannot satisfy:
      //
      //     ! Codex installed the Brain, but 17 lifecycle hooks await review.
      //       Fix: Start a fresh Codex session, run /hooks, and trust ruvnet-brain@ruvnet-brain.
      //
      // That instruction is correct for a human and impossible for a runner: hook trust is recorded
      // interactively. So each release published both channels successfully and then reported
      // failure, which is the exact "gate reporting something other than what it measured" pattern
      // this repo has spent a week removing — and worse here, because it made a GOOD release look bad.
      //
      // This does NOT weaken the check. install.mjs:1994 documents the bypass as executing the real
      // hook commands "without pretending a fresh interactive user has already reviewed them", and
      // the hooks still run — 68 firings, all inside contract. Only the pending-trust verdict is
      // waived, and only for an automated fixture. End-user doctor runs remain fail-closed.
      RUVNET_CODEX_HOOK_TRUST_MODE: 'bypass',
    }),
  }),
});

/** A doctor run is ACCEPTED only on a clean exit. One rule, not one per harness. */
export function classifyDoctor(result) {
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (!result.error && result.status === 0) return { accepted: true, status: 'PASS', output };
  return { accepted: false, status: 'FAIL', output };
}

/** Build a PATH exposing only the CLIs this mode is entitled to see. */
export function fixturePath(mode, temp, locate) {
  const bin = path.join(temp, `bin-${mode}`);
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['node', 'npm', ...MODE_HOSTS[mode]]) {
    const target = locate(name);
    if (!target) throw new Error(`${name} CLI unavailable for the ${mode} host fixture`);
    fs.symlinkSync(target, path.join(bin, name));
  }
  return `${bin}:/usr/bin:/bin`;
}

/**
 * Install `packageRoot` into a clean HOME per mode and run its doctor. Returns a result for EVERY
 * mode — including the ones that failed — because "which host broke" is the whole diagnostic value,
 * and the previous harnesses threw on the first failure and lost the rest.
 *
 * @returns {{verdict:'PASS'|'FAIL', fixtures:Record<string,object>, error?:string}}
 */
export function runHostMatrix({ packageRoot, version, variant = 'staged', locate, temp, run = spawnSync }) {
  const spec = VARIANTS[variant];
  if (!spec) throw new Error(`unknown host-matrix variant: ${variant}`);
  const workspace = temp || fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-host-matrix-'));
  const installer = path.join(packageRoot, 'bin', 'install.mjs');
  const fixtures = {};
  let verdict = 'PASS';
  let error;

  for (const mode of HOST_MODES) {
    try {
      const home = path.join(workspace, `home-${mode}`);
      const codexHome = path.join(home, '.codex');
      const brainHome = path.join(home, '.cache', 'ruvnet-brain');
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      if (mode !== 'claude') fs.mkdirSync(codexHome, { recursive: true });
      const env = {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        RUVNET_BRAIN_HOME: brainHome,
        RUVNET_BRAIN_KB: path.join(brainHome, 'kb'),
        CI: 'true',
        PATH: fixturePath(mode, workspace, locate),
        ...spec.env({ packageRoot }),
      };
      const install = run(process.execPath, [installer, ...spec.installerArgs(version)], {
        cwd: packageRoot, env, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024,
      });
      if (install.error || install.status !== 0) {
        throw new Error(`install failed for ${mode}: ${(install.stderr || install.error?.message || '').slice(-4000)}`);
      }
      const doctor = run(process.execPath, [installer, '--doctor', '--hooks'], {
        cwd: packageRoot, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
      });
      const classified = classifyDoctor(doctor);
      fixtures[mode] = { status: classified.status, doctorExit: doctor.status, version };
      if (!classified.accepted) {
        verdict = 'FAIL';
        fixtures[mode].output = classified.output.slice(-5000);
        // The output belongs IN the error. The previous harness put it there and I dropped it in
        // the consolidation, so CI reported a bare "doctor failed for claude" and the one thing
        // needed to act on it — what the doctor actually said — was thrown away.
        error = error || `doctor failed for ${mode} (exit ${doctor.status}): ${classified.output.slice(-4000)}`;
      }
    } catch (e) {
      verdict = 'FAIL';
      fixtures[mode] = { status: 'FAIL', error: e.message };
      error = error || e.message;
    }
  }
  return error ? { verdict, fixtures, error } : { verdict, fixtures };
}
