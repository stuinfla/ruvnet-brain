// tests/integration/install-smoke.mjs — drive-to-98 item #6: the REAL installer smoke test.
//
// bin/install.mjs is the highest-risk untested path — a stranger's very first contact with the
// brain runs through it, and until now nothing exercised it. These tests run the ACTUAL installer
// in its three safe, offline, non-mutating modes and assert on real observed behavior (exit code +
// stdout), not on mocks:
//   1. `--help`   — prints usage/flags, exits 0.
//   2. `--doctor` — runs the read-only health check, prints the banner + a diagnostic line, and
//                   NEVER crashes. We pin RUVNET_BRAIN_KB to an empty temp dir so the check takes
//                   the deterministic "brain not found here" path on EVERY machine (a fresh CI
//                   runner has no brain; a dev box does — pinning makes both behave identically and
//                   skips the multi-minute model-warm smoke query). We do NOT assert a passing
//                   health state — only that doctor RAN, produced a diagnostic, and stayed
//                   read-only (the pinned dir must be untouched afterwards).
//   3. freshness flags — `--update` against an empty KB dir must fail LOUD (non-zero exit + the
//                   re-run-installer message); `--enable-nightly` / `--disable-nightly` must write/
//                   remove a valid LaunchAgent plist under an overridden HOME (macOS only; the
//                   RUVNET_BRAIN_TEST=1 guard skips launchctl so the real gui domain is never touched).
//   4. signing wiring — asserts `node --check bin/install.mjs` parses, and that SIGNING_PUBKEY_PEM
//                   and the verifyBundle definition are both still inlined (guards against the
//                   Ed25519 bundle-signature gate being accidentally deleted).
//
// Robust by construction: spawnSync with an explicit timeout, zero network dependence, node:test +
// node:assert (runnable via `node --test tests/integration/install-smoke.mjs`). Any failed
// assertion makes the process exit non-zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');

// Run the real installer. Bounded timeout, inherited env (+ overrides), never touches the network
// in the modes exercised here.
function runInstaller(args, extraEnv = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...extraEnv },
  });
}

function assertClean(r, label) {
  assert.equal(r.error, undefined, `${label}: spawn failed — ${r.error && r.error.message}`);
  assert.equal(r.signal, null, `${label}: process was killed by signal ${r.signal} (timeout?)`);
  assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}\nstderr:\n${r.stderr || ''}`);
}

test('the installer file exists at bin/install.mjs', () => {
  assert.ok(fs.existsSync(INSTALLER), `installer missing at ${INSTALLER}`);
});

test('`--help` exits 0 and prints usage + flags', () => {
  const r = runInstaller(['--help']);
  assertClean(r, '--help');
  const out = r.stdout || '';
  assert.match(out, /RuvNet Brain installer/, 'help must identify the tool');
  assert.match(out, /Usage:/, 'help must print a Usage section');
  assert.match(out, /--doctor/, 'help must list the --doctor flag');
});

test('`--doctor` runs a read-only health check, prints a diagnostic, and never crashes', () => {
  // Pin the brain dir to an EMPTY temp dir → deterministic "brain not found here" path on any
  // machine (and no multi-minute model warm-up). Read-only: the dir must stay untouched.
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-doctor-'));
  try {
    const r = runInstaller(['--doctor'], { RUVNET_BRAIN_KB: brainDir });
    assertClean(r, '--doctor');
    const out = r.stdout || '';
    assert.match(out, /RuvNet Brain/, 'doctor must print the banner identifying the tool');
    assert.match(out, /brain dir:/, 'doctor must print a diagnostic check line (the brain dir it inspected)');
    // A read-only diagnostic must not write anything into the brain dir it was pointed at.
    assert.deepEqual(fs.readdirSync(brainDir), [], 'doctor must be non-mutating (pinned brain dir stayed empty)');
    // No unhandled throw: exit 0 already proves this, but also reject a leaked JS stack trace.
    assert.doesNotMatch(r.stderr || '', /\n\s+at\s+\S+.*:\d+:\d+/, 'doctor must not emit an unhandled-exception stack');
  } finally {
    fs.rmSync(brainDir, { recursive: true, force: true });
  }
});

test('`--help` lists the freshness flags: --update, --enable-nightly, --disable-nightly', () => {
  const r = runInstaller(['--help']);
  assertClean(r, '--help (freshness flags)');
  const out = r.stdout || '';
  for (const flag of ['--update', '--enable-nightly', '--disable-nightly']) {
    assert.ok(out.includes(flag), `help must list ${flag}`);
  }
});

test('`--update` against an empty KB dir fails LOUD with the re-run-installer message', () => {
  // An empty dir has no forge-update.mjs — the honest failure is a clear "re-run the installer",
  // a non-zero exit, and NO invented fallback behavior.
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-update-'));
  try {
    const r = runInstaller(['--update'], { RUVNET_BRAIN_KB: kbDir });
    assert.equal(r.error, undefined, `--update: spawn failed — ${r.error && r.error.message}`);
    assert.notEqual(r.status, 0, '--update on an empty KB dir must exit non-zero (fail loud)');
    const all = `${r.stdout || ''}${r.stderr || ''}`;
    assert.match(all, /forge-update\.mjs/, 'must name the missing self-updater');
    assert.match(all, /npx ruvnet-brain/, 'must tell the user the fix: re-run the installer');
    assert.deepEqual(fs.readdirSync(kbDir), [], '--update must not mutate the KB dir on failure');
  } finally {
    fs.rmSync(kbDir, { recursive: true, force: true });
  }
});

// The LaunchAgent path only exists on macOS (--enable-nightly prints a cron recipe elsewhere).
// HOME is pointed at a temp dir so the REAL ~/Library/LaunchAgents is never touched, and
// RUVNET_BRAIN_TEST=1 makes the installer skip launchctl entirely (we assert the guard fired).
test(
  '`--enable-nightly` writes a valid per-user plist under a test HOME, and `--disable-nightly` removes it',
  { skip: process.platform !== 'darwin' ? 'macOS-only: exercises the LaunchAgent plist path' : false },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-home-'));
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-kb-'));
    const realPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist');
    const realPlistBefore = fs.existsSync(realPlist);
    try {
      // --enable-nightly refuses to schedule a job with nothing to run — give it a stub updater.
      fs.writeFileSync(path.join(kbDir, 'forge-update.mjs'), '// stub for install-smoke — never executed\n');
      const env = { HOME: home, RUVNET_BRAIN_KB: kbDir, RUVNET_BRAIN_TEST: '1' };

      const r = runInstaller(['--enable-nightly'], env);
      assertClean(r, '--enable-nightly');
      // The guard must have fired: launchctl skipped, and the installer must SAY so.
      assert.match(r.stdout || '', /RUVNET_BRAIN_TEST=1/, 'test-mode guard must announce that launchctl was skipped');

      const plist = path.join(home, 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist');
      assert.ok(fs.existsSync(plist), `plist not written at ${plist} (HOME override not honored?)`);
      const xml = fs.readFileSync(plist, 'utf8');
      assert.ok(xml.includes(kbDir), "plist must be templated to THIS user's kb dir");
      assert.match(xml, /<key>Hour<\/key>\s*<integer>3<\/integer>/, 'must schedule hour 3');
      assert.match(xml, /<key>Minute<\/key>\s*<integer>47<\/integer>/, 'must schedule minute 47 (03:47)');
      assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/, 'must not run at load');
      assert.match(xml, /forge-update\.mjs --apply/, 'must run the bundled self-updater with --apply');
      // plutil is macOS's own plist validator — structural proof launchd could load this file.
      const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8', timeout: 15000 });
      assert.equal(lint.status, 0, `plutil -lint rejected the plist:\n${lint.stdout || ''}${lint.stderr || ''}`);

      // --disable-nightly removes it…
      const d1 = runInstaller(['--disable-nightly'], env);
      assertClean(d1, '--disable-nightly (first run)');
      assert.ok(!fs.existsSync(plist), '--disable-nightly must delete the plist');
      // …and is idempotent + friendly when there's nothing to remove.
      const d2 = runInstaller(['--disable-nightly'], env);
      assertClean(d2, '--disable-nightly (second run, idempotent)');
      assert.match(d2.stdout || '', /already off/i, 'second disable must stay friendly, not error');

      // The REAL LaunchAgents dir must be exactly as it was — the whole point of the HOME override.
      assert.equal(fs.existsSync(realPlist), realPlistBefore, 'the real ~/Library/LaunchAgents must be untouched');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  },
);

test('installer parses and still inlines the Ed25519 signing pubkey + verifyBundle', () => {
  // Syntax gate: a broken installer would ENOENT for every stranger on first contact.
  const check = spawnSync(process.execPath, ['--check', INSTALLER], { encoding: 'utf8', timeout: 30000 });
  assert.equal(check.status, 0, `node --check bin/install.mjs failed:\n${check.stderr || ''}`);
  // Wiring gate: the bundle-signature verifier must not be silently removed.
  const src = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(src, /SIGNING_PUBKEY_PEM\s*=/, 'SIGNING_PUBKEY_PEM constant must remain wired in');
  assert.match(src, /-----BEGIN PUBLIC KEY-----/, 'the inlined Ed25519 public key block must remain');
  assert.match(src, /function\s+verifyBundle\s*\(/, 'the verifyBundle definition must remain');
});
