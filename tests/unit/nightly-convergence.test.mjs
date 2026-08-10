import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported under RUVNET_BRAIN_IMPORT_ONLY=1 so the installer main() never runs as an import side
// effect — the same pattern as install-plan-choices / offerNightly / telemetry. The first version of
// this file imported it bare; that happened to return in 221ms today because the no-argv path is
// currently inert, which is luck, not a contract. A test that runs the REAL INSTALLER on a
// maintainer's machine because a flag branch changed is not a risk worth carrying for one import.
let installCronEntry;
beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  ({ installCronEntry } = await import('../../bin/install.mjs'));
});

/**
 * ISSUE #129 — the scheduled update paths bypassed host convergence.
 *
 * Three schedulers, one job, and they did not agree about what the job IS:
 *
 *   session (SessionStart)  npx ruvnet-brain@latest --update --host-sync-only --no-nightly-prompt
 *   macOS LaunchAgent       node forge-update.mjs --apply          ← KB BYTES ONLY
 *   printed cron recipe     node forge-update.mjs --apply          ← KB BYTES ONLY
 *
 * `forge-update.mjs --apply` advances the corpus and never reaches host convergence, so a scheduled
 * run could move the KB forward while the Stable Spine, the Claude and Codex payloads, the Console
 * runtime and host-convergence.json stayed behind — overnight, on a schedule, with the update log
 * reporting success. A machine that silently updates itself into a split state is worse than one
 * that never updates.
 *
 * And `--enable-nightly` exited 0 on every non-Darwin platform while installing nothing, so any
 * automated check of "is Evergreen on?" was told yes on a machine with no schedule.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const INSTALL = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');
const HOST_UPDATE = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'host-update.mjs'), 'utf8');

/** The argv the session updater actually runs — read from its source, never restated here. */
function sessionArgv() {
  const block = HOST_UPDATE.slice(HOST_UPDATE.indexOf('spawnSync(npx, ['));
  return [...block.slice(0, block.indexOf('], {')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('issue #129 — every scheduler runs the one host-convergent command', () => {
  it('the installer schedules exactly what the session updater runs', () => {
    // Derived from both sources rather than spelled out, so the day someone changes one the test
    // fails instead of quietly agreeing with a stale copy.
    const argv = sessionArgv();
    expect(argv, 'sanity: the session path must still be the convergent one').toContain('--host-sync-only');
    const nightly = INSTALL.slice(INSTALL.indexOf('const NIGHTLY_ARGV = ['));
    const declared = [...nightly.slice(0, nightly.indexOf(']')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(declared).toEqual(argv);
  });

  it('TEETH: no scheduler invokes the KB-only updater any more', () => {
    // This is the actual defect. forge-update.mjs is still referenced for presence checks and by the
    // in-session update path (which then performs host sync) — what must be gone is scheduling it.
    const plist = INSTALL.slice(INSTALL.indexOf('<key>ProgramArguments</key>'));
    expect(plist.slice(0, 400), 'the LaunchAgent must not exec the KB-only updater')
      .not.toMatch(/forge-update\.mjs/);
    // Just the definition — a wider window picks up the neighbouring comment about
    // forge-update.mjs's exit codes, which is prose about a different concern.
    const from = INSTALL.indexOf('const cronExample =');
    const cron = INSTALL.slice(from, INSTALL.indexOf(';', from));
    expect(cron, 'nor may the printed cron recipe').not.toMatch(/forge-update\.mjs/);
    expect(cron, 'and it must be built from the one declared argv').toMatch(/nightlyCommand\(\)/);
  });

  it('the LaunchAgent carries a PATH, because launchd does not read a shell profile', () => {
    // Without this the agent resolves npx against /usr/bin:/bin:/usr/sbin:/sbin and fails to launch
    // on every Homebrew/nvm/Volta install — and the only symptom is a nightly that never runs.
    expect(INSTALL).toMatch(/<key>EnvironmentVariables<\/key>/);
    expect(INSTALL).toMatch(/<key>PATH<\/key>/);
  });

  it('still no /bin/sh -c in the LaunchAgent (ADR-038)', () => {
    const plist = INSTALL.slice(INSTALL.indexOf('<key>ProgramArguments</key>'));
    expect(plist.slice(0, 400)).not.toMatch(/\/bin\/sh/);
  });
});

describe('issue #129 — enable-nightly reports what it actually did', () => {
  it('installs the entry, and is idempotent when it is already there', async () => {
    const calls = [];
    const fake = (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input });
      if (args[0] === '-l') return { status: 0, stdout: '0 5 * * * something-else\n' };
      return { status: 0, stdout: '' };
    };
    const r = installCronEntry('47 3 * * *  npx --yes ruvnet-brain@latest --update', { run: fake });
    expect(r.ok).toBe(true);
    expect(calls[1].input, 'the existing crontab must be preserved, not replaced')
      .toMatch(/0 5 \* \* \* something-else/);
    expect(calls[1].input).toMatch(/ruvnet-brain@latest/);

    const already = installCronEntry('47 3 * * *  npx --yes ruvnet-brain@latest --update', {
      run: (cmd, args) => (args[0] === '-l'
        ? { status: 0, stdout: '47 3 * * *  npx --yes ruvnet-brain@latest --update\n' }
        : { status: 0 }),
    });
    expect(already, 'a second run must not append a duplicate line').toEqual({ ok: true, already: true });
  });

  it('TEETH: a failure returns a REASON, and never reports success', async () => {
    const noBinary = installCronEntry('x', { run: () => ({ error: new Error('ENOENT') }) });
    expect(noBinary.ok).toBe(false);
    expect(noBinary.why).toMatch(/no crontab command/);

    const rejected = installCronEntry('x', {
      run: (cmd, args) => (args[0] === '-l' ? { status: 0, stdout: '' } : { status: 1, stderr: 'bad minute' }),
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.why, 'the user needs to know WHY, not just that it failed').toMatch(/bad minute/);
  });

  it('the non-Darwin branch exits non-zero when nothing was installed', () => {
    const branch = INSTALL.slice(INSTALL.indexOf("if (process.platform !== 'darwin')"));
    const body = branch.slice(0, branch.indexOf('\n  }\n'));
    expect(body, 'it must actually try to install').toMatch(/installCronEntry/);
    expect(body, 'and must not report success when it could not').toMatch(/process\.exit\(1\)/);
  });
});
