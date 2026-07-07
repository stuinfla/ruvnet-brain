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
//   3. signing wiring — asserts `node --check bin/install.mjs` parses, and that SIGNING_PUBKEY_PEM
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
